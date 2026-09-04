"""Detection pipeline — spec §7.1, with §6.4/§6.5 run over each market group.

`detect_opportunities` is deliberately pure: snapshots in, detections out, no
Elasticsearch anywhere. That is not only for testability — §7.1 requires the
cycle to work from **the in-memory batch it just fetched, never from an ES
read-back**, because a read-back races the bulk index that produced it and can
silently detect against a partially-refreshed view of the market.

`run_once` is the impure half: fetch, normalize, index, detect, persist. It stops
short of notifying anyone. Discord is Phase 2 (§9); this phase stores paper
recommendations so that seven days of them exist to analyse when alerting arrives.

§16.1: nothing here places a bet, and nothing here can. The output is documents.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .config import Settings, settings_from_document
from .dedup import (
    STATUS_OPEN,
    cooldown_key,
    opp_hash,
    select_cooldown_winners,
)
from .deeplink import build_deep_link
from .indices import (
    BANKROLL_LEDGER_INDEX,
    EVENTS_INDEX,
    ODDS_SNAPSHOTS_INDEX,
    OPPORTUNITIES_INDEX,
    RECOMMENDATIONS_INDEX,
    SETTINGS_INDEX,
    SPORTSBOOKS_INDEX,
    UNMATCHED_INDEX,
    event_doc_id,
    with_prefix,
)
from .normalizer import UnmatchedRow, normalize
from .oddsmath import (
    arb_profit_pct,
    consensus,
    decimal_to_american,
    devig,
    ev_pct,
    implied_prob,
    inverse_sum,
    split_arb_stakes,
    staleness_from_others,
)
from .oddsmath import bet_first_index as _bet_first_index
from .schemas import BookOddsSnapshot, OpportunityLeg, StakeLeg, StakePlan, utc_now_iso
from .staking import arb_allocation_cents, apply_guardrails, plan_ev_stake

log = logging.getLogger(__name__)

TYPE_EV = "ev"
TYPE_ARB = "arb"


@dataclass
class Detection:
    """One opportunity, before staking and before it touches the datastore."""

    type: str  # 'ev' | 'arb'
    event_id: str
    sport_key: str
    market_key: str
    commence_time: str
    legs: list[OpportunityLeg]
    edge_pct: float
    detected_at: str
    consensus_prob: float | None = None
    hash: str = ""

    def __post_init__(self) -> None:
        if not self.hash:
            self.hash = opp_hash(
                self.event_id,
                self.market_key,
                [leg.selection for leg in self.legs],
                [leg.book_key for leg in self.legs],
            )

    def to_document(self) -> dict[str, Any]:
        """Shaped for `edgeline-opportunities` (§4.3), which is `dynamic: strict`."""
        return {
            "type": self.type,
            "event_id": self.event_id,
            "market_key": self.market_key,
            "legs": [
                {
                    "book_key": leg.book_key,
                    "selection": leg.selection,
                    "line": leg.line,
                    "price_decimal": leg.price_decimal,
                    "devig_prob": leg.devig_prob,
                    "staleness": leg.staleness,
                    "bet_first": leg.bet_first,
                }
                for leg in self.legs
            ],
            "edge_pct": self.edge_pct,
            "status": STATUS_OPEN,
            "detected_at": self.detected_at,
            "expires_at": self.commence_time,
        }


@dataclass
class _BookQuote:
    """One book's view of one market group: its prices and its de-vigged probs."""

    prices: dict[str, float] = field(default_factory=dict)
    fair: dict[str, float] = field(default_factory=dict)


def _book_quotes(
    rows: list[BookOddsSnapshot], method: str
) -> dict[str, _BookQuote]:
    """Per-book prices, plus de-vigged probabilities where the quote is complete.

    A book quoting only one side of the market gets prices but no `fair` values:
    §6.2 cannot strip an overround it cannot see, and inventing a fair
    probability from a half-quote would feed a fabricated number straight into
    the consensus.
    """
    quotes: dict[str, _BookQuote] = {}
    for row in rows:
        quotes.setdefault(row.book_key, _BookQuote()).prices[row.selection] = (
            row.price_decimal
        )

    for quote in quotes.values():
        if len(quote.prices) < 2:
            continue
        selections = list(quote.prices)
        raw = [implied_prob(quote.prices[s]) for s in selections]
        try:
            fair = devig(raw, method)
        except (ValueError, NotImplementedError):
            continue
        quote.fair = dict(zip(selections, fair))
    return quotes


def _market_selections(quotes: dict[str, _BookQuote]) -> list[str]:
    """The outcome set of the market, taken from the most complete single quote.

    Using one book's complete view rather than the union across books: a union
    would absorb any stray selection into the market and make `inverse_sum`
    range over an outcome set no book actually offers.
    """
    if not quotes:
        return []
    return sorted(max((q.prices for q in quotes.values()), key=len))


def detect_opportunities(
    snapshots: list[BookOddsSnapshot],
    settings: Settings,
    *,
    enabled_books: set[str] | None = None,
    now_iso: str | None = None,
) -> list[Detection]:
    """Run §6.4 (+EV) and §6.5 (arbitrage) over every same-line market group.

    `enabled_books` of `None` means "consider every book present", which is what
    the fixture-replay tests want. In production it is the enabled set from
    `edgeline-sportsbooks`, and an empty set legitimately yields no detections.
    """
    from .normalizer import group_same_line  # local: avoids a circular import

    detected_at = now_iso or utc_now_iso()
    detections: list[Detection] = []

    for (event_id, market_key, _line), rows in group_same_line(snapshots).items():
        usable = [
            r for r in rows if enabled_books is None or r.book_key in enabled_books
        ]
        if len(usable) < 2:
            continue

        quotes = _book_quotes(usable, settings.devig_method)
        selections = _market_selections(quotes)
        if len(selections) < 2:
            continue

        header = usable[0]
        # The group is keyed on |line|, so a spread's two sides share a group but
        # keep their own signed points. Carry them explicitly rather than
        # re-parsing them out of the selection strings later.
        lines = {row.selection: row.line for row in usable}

        detections.extend(
            _detect_ev(
                quotes, selections, lines, settings, header, event_id, market_key, detected_at
            )
        )
        arb = _detect_arb(
            quotes, selections, lines, settings, header, event_id, market_key, detected_at
        )
        if arb is not None:
            detections.append(arb)

    return detections


def _detect_ev(
    quotes: dict[str, _BookQuote],
    selections: list[str],
    lines: dict[str, float | None],
    settings: Settings,
    header: BookOddsSnapshot,
    event_id: str,
    market_key: str,
    detected_at: str,
) -> list[Detection]:
    """§6.4: price a book against the consensus of the *other* books."""
    found: list[Detection] = []
    for selection in selections:
        for book_key, quote in quotes.items():
            price = quote.prices.get(selection)
            if price is None:
                continue
            others = {
                other_key: other.fair[selection]
                for other_key, other in quotes.items()
                if other_key != book_key and selection in other.fair
            }
            # "consensus available from >= min_books_for_consensus OTHER books"
            # — the book being priced never votes on its own fair value.
            if len(others) < settings.min_books_for_consensus:
                continue

            consensus_prob = consensus(others, settings.consensus_weights)
            edge = ev_pct(consensus_prob, price)
            if edge < settings.ev_threshold_pct:
                continue

            found.append(
                Detection(
                    type=TYPE_EV,
                    event_id=event_id,
                    sport_key=header.sport_key,
                    market_key=market_key,
                    commence_time=header.commence_time,
                    legs=[
                        OpportunityLeg(
                            book_key=book_key,
                            selection=selection,
                            line=lines.get(selection),
                            price_decimal=price,
                            price_american=decimal_to_american(price),
                            devig_prob=quote.fair.get(selection, consensus_prob),
                        )
                    ],
                    edge_pct=edge,
                    detected_at=detected_at,
                    consensus_prob=consensus_prob,
                )
            )
    return found


def _detect_arb(
    quotes: dict[str, _BookQuote],
    selections: list[str],
    lines: dict[str, float | None],
    settings: Settings,
    header: BookOddsSnapshot,
    event_id: str,
    market_key: str,
    detected_at: str,
) -> Detection | None:
    """§6.5: best price per outcome across different books, then `inv < 1`."""
    best: dict[str, tuple[str, float]] = {}
    for selection in selections:
        candidates = [
            (book_key, quote.prices[selection])
            for book_key, quote in quotes.items()
            if selection in quote.prices
        ]
        if not candidates:
            return None  # incomplete market: cannot cover every outcome
        best[selection] = max(candidates, key=lambda pair: pair[1])

    books = [book for book, _ in best.values()]
    if len(set(books)) < 2:
        # §6.5 is "across different books". One book pricing both sides into an
        # arb would be the book's error, not a cross-book edge, and acting on it
        # is how accounts get closed.
        return None

    prices = [price for _, price in best.values()]
    if inverse_sum(prices) >= 1.0:
        return None

    profit = arb_profit_pct(prices)
    if profit < settings.arb_min_profit_pct:
        return None

    legs: list[OpportunityLeg] = []
    scores: list[float] = []
    for selection, (book_key, price) in best.items():
        others = [
            other.fair[selection]
            for other_key, other in quotes.items()
            if other_key != book_key and selection in other.fair
        ]
        own_fair = quotes[book_key].fair.get(selection)
        score: float | None = None
        if others and own_fair is not None:
            score = staleness_from_others(
                own_fair, others, sigma_floor=settings.staleness_sigma_floor
            )
        scores.append(score if score is not None else 0.0)
        legs.append(
            OpportunityLeg(
                book_key=book_key,
                selection=selection,
                line=lines.get(selection),
                price_decimal=price,
                price_american=decimal_to_american(price),
                devig_prob=own_fair if own_fair is not None else implied_prob(price),
                staleness=score,
            )
        )

    if len(legs) >= 2 and any(leg.staleness is not None for leg in legs):
        first = _bet_first_index(scores)
        if first is not None:
            legs[first] = legs[first].model_copy(update={"bet_first": True})

    return Detection(
        type=TYPE_ARB,
        event_id=event_id,
        sport_key=header.sport_key,
        market_key=market_key,
        commence_time=header.commence_time,
        legs=legs,
        edge_pct=profit,
        detected_at=detected_at,
    )


# ---- staking + persistence -------------------------------------------------


def build_stake_plan(
    detection: Detection,
    settings: Settings,
    *,
    bankroll_cents: int,
    todays_exposure_cents: int = 0,
    daily_loss_stop_tripped: bool = False,
    link_templates: dict[str, dict[str, Any]] | None = None,
    provider_event_id: str = "",
) -> tuple[StakePlan | None, list[str], bool]:
    """Turn a detection into a `StakePlan` (§6.7, §6.5, §9.4).

    Returns `(plan, guardrails_applied, alert)`. A `None` plan means the
    guardrails suppressed the bet outright; `alert=False` with a plan means
    "store the opportunity, send nothing" (§6.7 steps 5 and 6).
    """
    templates = link_templates or {}

    if detection.type == TYPE_EV:
        leg = detection.legs[0]
        decision = plan_ev_stake(
            detection.consensus_prob or 0.0,
            leg.price_decimal,
            edge_pct=detection.edge_pct,
            settings=settings,
            bankroll_cents=bankroll_cents,
            todays_exposure_cents=todays_exposure_cents,
            daily_loss_stop_tripped=daily_loss_stop_tripped,
        )
        if decision.stake_cents <= 0:
            return None, decision.guardrails_applied, False
        stake_legs = [
            _stake_leg(
                leg, decision.stake_cents, templates, provider_event_id
            )
        ]
        return (
            StakePlan(
                total_cents=decision.stake_cents,
                legs=stake_legs,
                method="kelly",
                guardrails_applied=decision.guardrails_applied,
            ),
            decision.guardrails_applied,
            decision.alert,
        )

    allocation = arb_allocation_cents(settings, bankroll_cents)
    split = split_arb_stakes(
        allocation,
        [leg.price_decimal for leg in detection.legs],
        rounding_cents=settings.stake_rounding_cents,
        min_profit_pct=settings.arb_min_profit_pct,
    )
    if not split.accepted:
        # §6.5: the rounded split no longer clears the threshold, so there is no
        # arbitrage to recommend even though the raw prices showed one.
        return None, ["arb_rounding_recheck"], False

    decision = apply_guardrails(
        sum(split.stakes_cents),
        edge_pct=detection.edge_pct,
        settings=settings,
        bankroll_cents=bankroll_cents,
        todays_exposure_cents=todays_exposure_cents,
        daily_loss_stop_tripped=daily_loss_stop_tripped,
    )
    if decision.stake_cents <= 0:
        return None, decision.guardrails_applied, False

    stake_legs = [
        _stake_leg(leg, stake, templates, provider_event_id)
        for leg, stake in zip(detection.legs, split.stakes_cents)
    ]
    return (
        StakePlan(
            total_cents=sum(split.stakes_cents),
            legs=stake_legs,
            method="arb_split",
            guardrails_applied=decision.guardrails_applied,
        ),
        decision.guardrails_applied,
        decision.alert,
    )


def _stake_leg(
    leg: OpportunityLeg,
    stake_cents: int,
    templates: dict[str, dict[str, Any]],
    provider_event_id: str,
) -> StakeLeg:
    deep_link, link_level = build_deep_link(
        templates.get(leg.book_key), {"provider_event_id": provider_event_id}
    )
    return StakeLeg(
        book_key=leg.book_key,
        selection=leg.selection,
        stake_cents=stake_cents,
        to_win_cents=int(round(stake_cents * leg.price_decimal)) - stake_cents,
        deep_link=deep_link,
        link_level=link_level,
    )


def snapshot_documents(
    snapshots: list[BookOddsSnapshot], *, is_closing: bool = False
) -> list[dict[str, Any]]:
    """Rows shaped for `edgeline-odds-snapshots` (§4.3)."""
    return [
        {
            "event_id": event_doc_id(s.sport_key, s.provider_event_id),
            "book_key": s.book_key,
            "market_key": s.market_key,
            "selection": s.selection,
            "line": s.line,
            "price_decimal": s.price_decimal,
            "is_closing": is_closing,
            "@timestamp": s.fetched_at,
        }
        for s in snapshots
    ]


def event_documents(snapshots: list[BookOddsSnapshot]) -> dict[str, dict[str, Any]]:
    """One `edgeline-events` document per event in the batch, keyed by `_id`."""
    events: dict[str, dict[str, Any]] = {}
    for s in snapshots:
        events[event_doc_id(s.sport_key, s.provider_event_id)] = {
            "sport_key": s.sport_key,
            "commence_time": s.commence_time,
            "home_team": s.home_team,
            "away_team": s.away_team,
        }
    return events


# ---- the cycle (§7.1) ------------------------------------------------------


@dataclass
class CycleReport:
    """What one poll cycle did — printed by `--once`, logged by the worker."""

    sport_key: str
    snapshots: int = 0
    quarantined: int = 0
    events: int = 0
    detections: list[Detection] = field(default_factory=list)
    alerted: list[Detection] = field(default_factory=list)
    enabled_books: int = 0
    skipped_reason: str | None = None
    quota_used: int | None = None
    quota_remaining: int | None = None


async def load_settings(client, *, prefix: str) -> Settings:
    """Settings from the `"global"` document, falling back to §3.2 defaults."""
    index = with_prefix(SETTINGS_INDEX, prefix)
    try:
        found = await client.get(index=index, id="global")
        return settings_from_document(found["_source"])
    except Exception:  # index or document absent — defaults are a valid answer
        log.info("no seeded settings at %s/global; using §3.2 defaults", index)
        return settings_from_document(None)


async def load_enabled_books(client, *, prefix: str) -> dict[str, dict[str, Any]]:
    """Enabled sportsbooks and their link templates, keyed by book key."""
    index = with_prefix(SPORTSBOOKS_INDEX, prefix)
    try:
        found = await client.search(
            index=index, query={"term": {"enabled": True}}, size=100
        )
    except Exception:
        return {}
    return {hit["_id"]: hit["_source"] for hit in found["hits"]["hits"]}


async def current_bankroll_cents(client, settings: Settings, *, prefix: str) -> int:
    """Bankroll as a sum aggregation over the ledger (§4.4 rule 3).

    There is no stored balance to read, by design. An empty ledger means the
    user has not recorded a deposit yet, so the §3.2 starting figure stands in.
    """
    index = with_prefix(BANKROLL_LEDGER_INDEX, prefix)
    try:
        found = await client.search(
            index=index, size=0, aggs={"balance": {"sum": {"field": "delta_cents"}}}
        )
    except Exception:
        return settings.bankroll_start_cents
    total = int(found["aggregations"]["balance"]["value"] or 0)
    return total or settings.bankroll_start_cents


async def run_once(
    provider,
    client,
    *,
    sport_key: str,
    prefix: str = "edgeline-",
    settings: Settings | None = None,
) -> CycleReport:
    """One §7.1 poll cycle. Fetches, stores, detects, and stops before alerting."""
    from elasticsearch.helpers import async_bulk

    settings = settings or await load_settings(client, prefix=prefix)
    report = CycleReport(sport_key=sport_key)

    books = await load_enabled_books(client, prefix=prefix)
    report.enabled_books = len(books)

    response = await provider.fetch_odds(sport_key, settings.markets_featured)
    report.quota_used = response.quota.used
    report.quota_remaining = response.quota.remaining

    quarantine: list[UnmatchedRow] = []
    snapshots = normalize(provider.key, response.payload, quarantine=quarantine)
    report.snapshots = len(snapshots)
    report.quarantined = len(quarantine)

    actions: list[dict[str, Any]] = [
        {"_index": with_prefix(ODDS_SNAPSHOTS_INDEX, prefix), "_source": doc}
        for doc in snapshot_documents(snapshots)
    ]
    events = event_documents(snapshots)
    report.events = len(events)
    actions += [
        {"_index": with_prefix(EVENTS_INDEX, prefix), "_id": doc_id, "_source": doc}
        for doc_id, doc in events.items()
    ]
    actions += [
        {"_index": with_prefix(UNMATCHED_INDEX, prefix), "_source": row.to_document()}
        for row in quarantine
    ]
    if actions:
        # Default refresh: §4.4 rule 2 — detection works from the in-memory
        # batch below, so nothing waits on these becoming searchable.
        await async_bulk(client, actions)

    if settings.kill_switch:
        # §7.1: keep polling for data continuity, stop before alerting.
        report.skipped_reason = "kill_switch"

    # Always the enabled set, even when it is empty. §6.5 and §6.6 both say
    # "enabled books", so an empty set must mean no detections rather than
    # quietly falling back to every book the feed happened to return.
    report.detections = detect_opportunities(
        snapshots, settings, enabled_books=set(books)
    )

    now = datetime.now(timezone.utc)
    candidates = [
        (cooldown_key(d.sport_key, d.market_key), d, d.edge_pct)
        for d in report.detections
    ]
    winners = select_cooldown_winners(
        candidates,
        last_alert_at_by_key={},
        now=now,
        cooldown_s=settings.alert_cooldown_s,
    )

    bankroll = await current_bankroll_cents(client, settings, prefix=prefix)
    for detection in report.detections:
        await client.index(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix),
            id=detection.hash,
            document=detection.to_document(),
            refresh="wait_for",  # §4.4 rule 2
        )
        if settings.kill_switch or detection not in winners:
            continue
        plan, _guardrails, alert = build_stake_plan(
            detection,
            settings,
            bankroll_cents=bankroll,
            link_templates={k: v.get("link_templates", {}) for k, v in books.items()},
            provider_event_id=detection.event_id.split(":", 1)[-1],
        )
        if plan is None or not alert:
            continue
        await client.index(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
            document={
                "opportunity_id": detection.hash,
                "stakes": plan.model_dump(),
                "paper": settings.paper_mode,
                "channel": "cli",
                "sent_at": utc_now_iso(),
            },
            refresh="wait_for",
        )
        report.alerted.append(detection)

    return report


def _format(report: CycleReport) -> str:
    lines = [
        f"sport            {report.sport_key}",
        f"snapshots        {report.snapshots}",
        f"events           {report.events}",
        f"quarantined      {report.quarantined}",
        f"enabled books    {report.enabled_books}",
        f"quota            {report.quota_used} used / {report.quota_remaining} left",
        f"detections       {len(report.detections)}",
        f"recommendations  {len(report.alerted)}",
    ]
    if report.skipped_reason:
        lines.append(f"NOT ALERTING     {report.skipped_reason}")
    if report.enabled_books == 0:
        lines.append(
            "note             no sportsbooks are enabled, so nothing can be "
            "detected. Confirm the Maryland list (§17), then enable books in "
            "edgeline-sportsbooks."
        )
    for detection in report.detections:
        legs = " | ".join(
            f"{leg.book_key} {leg.selection} @ {leg.price_decimal:.4f}"
            for leg in detection.legs
        )
        lines.append(
            f"  {detection.type:3s} {detection.edge_pct:+7.3f}%  "
            f"{detection.market_key:8s} {legs}"
        )
    return "\n".join(lines)


async def _main_async(args: argparse.Namespace) -> int:
    from .es import close_client, ensure_indices, get_client
    from .providers.the_odds_api import TheOddsApiProvider

    client = get_client()
    provider = TheOddsApiProvider()
    try:
        await ensure_indices(client)
        settings = await load_settings(client, prefix="edgeline-")
        for sport_key in args.sports or settings.sports_enabled:
            report = await run_once(
                provider, client, sport_key=sport_key, settings=settings
            )
            print(_format(report))
            print(
                "\nPAPER MODE — these are recommendations only. "
                "Edgeline never places a bet (§16.1)."
                if settings.paper_mode
                else ""
            )
    finally:
        await provider.aclose()
        await close_client()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m edgeline.engine",
        description="Edgeline detection engine. Recommends bets; never places them.",
    )
    parser.add_argument(
        "--once", action="store_true", help="run a single poll cycle and print it"
    )
    parser.add_argument(
        "--sports", nargs="*", help="sport keys to poll (default: settings.sports_enabled)"
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s %(message)s",
    )

    if not args.once:
        parser.error("only --once is implemented in Phase 1; the worker is §13")
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())

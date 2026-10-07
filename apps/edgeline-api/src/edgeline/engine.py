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
from datetime import datetime, timedelta, timezone
from typing import Any

from elasticsearch import NotFoundError

from .config import Settings, settings_from_document
from .dedup import (
    STATUS_ALERTED,
    STATUS_OPEN,
    closing_transition,
    cooldown_key,
    expiry_transition,
    is_expired,
    may_alert,
    opp_hash,
    parse_iso,
    select_cooldown_winners,
)
from .notify import AlertSink, LogSink, render_alert
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
    #: Per leg, how many other books backed its staleness figure. §9.2's arb
    #: message quotes this ("leg 2 matches {n} books").
    leg_consensus_books: list[int] = field(default_factory=list)
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
            # Since 2026-10-01, so the CLV summary can group by sport (`clv.py`).
            "sport_key": self.sport_key,
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


def _has_started(commence_time: str, detected_at: str) -> bool:
    """Has the event begun by the time this cycle ran?

    An unparseable or missing timestamp answers *no*: dropping a real edge over a
    malformed date would be worse than the thing this guards, and the §7.4
    expiry still catches the event afterwards.
    """
    if not commence_time:
        return False
    try:
        return parse_iso(commence_time) <= parse_iso(detected_at)
    except (ValueError, TypeError):
        return False


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

    **An event that has already started is skipped.** §7.4 expires an opportunity
    once its event begins, but expiry ran *after* detection had already stored,
    alerted and staked it — so the gate never stopped anything, it only tidied up
    afterwards. Measured 2026-09-11 against the live index: **all 27 stored
    opportunities were detected after kickoff**, by 8 to 158 minutes, including
    the 10.71% arb and 23.56% EV that were recorded as this system's first real
    finds. They are not edges. A book that leaves a pre-game line up after first
    pitch, or prices in-play differently, is not a market being slow — and §16's
    whole premise is handing a person a bet they can still place.
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
        if _has_started(usable[0].commence_time, detected_at):
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
    backing_books: list[int] = []
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
        backing_books.append(len(others))
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
        leg_consensus_books=backing_books,
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
    provider_links: dict[tuple[str, str, str], dict[str, str | None]] | None = None,
    book_state: str = "md",
) -> tuple[StakePlan | None, list[str], bool]:
    """Turn a detection into a `StakePlan` (§6.7, §6.5, §9.4).

    Returns `(plan, guardrails_applied, alert)`. A `None` plan means the
    guardrails suppressed the bet outright; `alert=False` with a plan means
    "store the opportunity, send nothing" (§6.7 steps 5 and 6).
    """
    templates = link_templates or {}
    links = provider_links or {}
    placeholders = {"provider_event_id": provider_event_id, "state": book_state}

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
                leg, decision.stake_cents, templates, placeholders, links, detection.market_key
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
        _stake_leg(leg, stake, templates, placeholders, links, detection.market_key)
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
    placeholders: dict[str, Any],
    provider_links: dict[tuple[str, str, str], dict[str, str | None]],
    market_key: str,
) -> StakeLeg:
    deep_link, link_level = build_deep_link(
        templates.get(leg.book_key),
        placeholders,
        provider_links.get((leg.book_key, market_key, leg.selection)),
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


def provider_link_index(
    snapshots: list[BookOddsSnapshot],
) -> dict[tuple[str, str, str], dict[str, str | None]]:
    """`(book, market, selection)` → the provider's links for that price.

    Built from the in-memory batch, per §4.4 rule 2 — the links arrived on the
    same response the prices did, and reading them back out of Elasticsearch
    would be both slower and a different question, since a snapshot index is a
    time series and a leg needs *this* cycle's link.

    Entries with no links at all are left out, so a lookup miss and "the provider
    covers this book but sent nothing" are the same thing to the ladder, which is
    correct: both mean fall through.
    """
    index: dict[tuple[str, str, str], dict[str, str | None]] = {}
    for snapshot in snapshots:
        links = {
            "event_link": snapshot.event_link,
            "market_link": snapshot.market_link,
            "outcome_link": snapshot.outcome_link,
        }
        if not any(links.values()):
            continue
        index[(snapshot.book_key, snapshot.market_key, snapshot.selection)] = links
    return index


@dataclass(frozen=True)
class LineDeath:
    """One previously-alerted opportunity that has now vanished from the feed.

    T2.5's instrumentation: how long an edge survives after we told someone about
    it is the number that decides whether a push channel is fast enough to be
    worth building. It is recorded whether or not any channel is wired up.
    """

    opportunity_hash: str
    market_key: str
    type: str
    edge_pct: float
    detected_at: str
    closed_at: str
    lifetime_s: float


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
    #: True when `offline_mode` stopped the cycle before any provider request.
    #: Distinct from `skipped_reason`, which means "polled, but did not alert".
    offline: bool = False
    quota_used: int | None = None
    quota_remaining: int | None = None
    #: How many books the poll named (§8.4 `poll_bookmakers`); 0 when it asked
    #: for `regions` instead.
    named_books: int = 0
    #: The end of the lookahead window the poll asked about, or `None` for none.
    window_to: str | None = None
    # §7.4 lifecycle, and T2.5's line-death instrumentation.
    closed: list[str] = field(default_factory=list)
    expired: list[str] = field(default_factory=list)
    line_deaths: list[LineDeath] = field(default_factory=list)
    surviving_alerts: list[str] = field(default_factory=list)
    #: Live opportunities on events beyond the window: not asked about, so left
    #: as they were rather than closed for not being seen.
    beyond_window: list[str] = field(default_factory=list)


async def load_settings(client, *, prefix: str) -> Settings:
    """Settings from the `"global"` document, falling back to §3.2 defaults.

    **Only an absent document is a fallback.** Any other failure raises, because
    §3.2's defaults are not a safe guess at what the user configured: both
    `kill_switch` and `offline_mode` default to *off*, so a read that fails for
    ten seconds would quietly resume a system someone had paused, and a stored
    `quota_monthly_budget` would revert to the free tier's while the pace guard
    was reading it.

    Measured 2026-09-15: every sleep/resume on this laptop drops the connection
    to the containerised cluster for one tick, and each one logged "no seeded
    settings … using §3.2 defaults" over a datastore that was fully seeded.
    """
    index = with_prefix(SETTINGS_INDEX, prefix)
    try:
        found = await client.get(index=index, id="global")
    except NotFoundError:  # index or document absent — defaults are a valid answer
        log.info("no seeded settings at %s/global; using §3.2 defaults", index)
        return settings_from_document(None)
    return settings_from_document(found["_source"])


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


#: `commenceTimeFrom`/`commenceTimeTo` take exactly this shape (§8).
PROVIDER_STAMP = "%Y-%m-%dT%H:%M:%SZ"


def featured_request(
    settings: Settings, enabled_books: dict[str, Any] | set[str], now: datetime
) -> dict[str, Any]:
    """The keyword arguments a featured poll passes `fetch_odds` (§8.4, 2026-10-01).

    The enabled books by name when `poll_bookmakers` is `enabled` and any are
    enabled — ten or fewer bill as one region, half of `us,us2` — and `regions`
    otherwise; plus the lookahead window when `poll_lookahead_h` sets one.
    `regions` travels either way and the adapter drops it when books are named.
    """
    request: dict[str, Any] = {"regions": ",".join(settings.regions)}
    if settings.poll_bookmakers == "enabled" and enabled_books:
        request["bookmakers"] = sorted(enabled_books)
    if settings.poll_lookahead_h > 0:
        request["commence_time_from"] = now.strftime(PROVIDER_STAMP)
        request["commence_time_to"] = (
            now + timedelta(hours=settings.poll_lookahead_h)
        ).strftime(PROVIDER_STAMP)
    return request


async def run_once(
    provider,
    client,
    *,
    sport_key: str,
    prefix: str = "edgeline-",
    settings: Settings | None = None,
    sink: AlertSink | None = None,
    now_iso: str | None = None,
) -> CycleReport:
    """One §7.1 poll cycle: fetch, store, detect, reconcile lifecycle, dispatch.

    `now_iso` overrides the clock for detection *and* the §7.4 lifecycle, so the
    two never disagree about what time it is. Tests need it because the only
    honest way to watch an opportunity expire is to detect it before its event
    and reconcile it after — which by wall clock takes hours.

    `sink` is where alerts go. It defaults to `LogSink` because §9's Discord
    channel has no token yet; swapping in a real channel later changes this
    argument and nothing else.
    """
    from elasticsearch.helpers import async_bulk

    settings = settings or await load_settings(client, prefix=prefix)
    sink = sink or LogSink()
    report = CycleReport(sport_key=sport_key)

    if settings.offline_mode:
        # §3.2: the whole point is that nothing else stops. The worker stays up,
        # its other jobs run, and the API keeps serving — this cycle simply does
        # not buy anything. Checked before `load_enabled_books` so an offline
        # cycle touches neither the provider nor the datastore.
        report.offline = True
        log.info("offline_mode: skipping the %s poll, no provider request made", sport_key)
        return report

    books = await load_enabled_books(client, prefix=prefix)
    report.enabled_books = len(books)

    request = featured_request(
        settings, books, parse_iso(now_iso) if now_iso else datetime.now(timezone.utc)
    )
    report.named_books = len(request.get("bookmakers", []))
    report.window_to = request.get("commence_time_to")
    response = await provider.fetch_odds(sport_key, settings.markets_featured, **request)
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
        snapshots, settings, enabled_books=set(books), now_iso=now_iso
    )

    now = parse_iso(now_iso) if now_iso else datetime.now(timezone.utc)
    now_iso = now_iso or utc_now_iso()
    opportunities = with_prefix(OPPORTUNITIES_INDEX, prefix)

    # §7.4 lifecycle. Everything still open or alerted from an earlier cycle is
    # reconciled against what this cycle found, before anything new is written.
    stored = await load_live_opportunities(client, sport_key, prefix=prefix)
    detected = {d.hash: d for d in report.detections}
    await _retire_vanished(
        client,
        opportunities,
        stored,
        detected,
        now,
        now_iso,
        report,
        window_end=parse_iso(report.window_to) if report.window_to else None,
    )

    # What each detection's opportunity was told before (§7.4, amended
    # 2026-10-01): its live document, or the closed one of a line that died and
    # came back — same hash, same bet — and, where neither records an alert,
    # whether a recommendation names it anyway.
    history = {doc_id: hit["_source"] for doc_id, hit in stored.items()}
    history.update(
        await _earlier_lives(
            client, opportunities, [d.hash for d in report.detections if d.hash not in stored]
        )
    )
    recommended = await _recommended_opportunities(
        client,
        [
            doc_id
            for doc_id, source in history.items()
            if doc_id in detected
            and source.get("alerted_edge_pct") is None
            and source.get("status") != STATUS_ALERTED
        ],
        prefix=prefix,
    )

    eligible: list[tuple[tuple[str, str], Detection, float]] = []
    for detection in report.detections:
        prior = stored.get(detection.hash)
        before = history.get(detection.hash, {})
        alerted_edge = before.get("alerted_edge_pct")
        was_alerted = (
            alerted_edge is not None
            or before.get("status") == STATUS_ALERTED
            or detection.hash in recommended
        )
        if prior is None:
            document = detection.to_document()
            if was_alerted:
                # A line that closed and has come back is still the bet that was
                # alerted, so it keeps that record and the gate below compares
                # it with the alert rather than treating it as news.
                document["status"] = STATUS_ALERTED
                if alerted_edge is not None:
                    document["alerted_edge_pct"] = alerted_edge
            await client.index(
                index=opportunities,
                id=detection.hash,
                document=document,
                refresh="wait_for",  # §4.4 rule 2
            )
        else:
            # Hash exists: update the edge and keep whatever status it carries.
            await _update_opportunity(
                client, opportunities, detection.hash, {"edge_pct": detection.edge_pct}, prior
            )
        # §7.4: an alerted opportunity re-alerts only when materially better
        # than at that alert — not than at the last poll, against which an edge
        # that dipped and recovered reads as an improvement at an unchanged price.
        if not may_alert(
            alerted_edge_pct=alerted_edge,
            was_alerted=was_alerted,
            new_edge_pct=detection.edge_pct,
            delta_pct=settings.edge_improve_delta_pct,
        ):
            continue
        eligible.append(
            (cooldown_key(detection.sport_key, detection.market_key), detection, detection.edge_pct)
        )

    if settings.kill_switch:
        return report

    last_alerts = await load_last_alert_times(
        client, prefix=prefix, now=now, cooldown_s=settings.alert_cooldown_s
    )
    winners = select_cooldown_winners(
        eligible,
        last_alert_at_by_key=last_alerts,
        now=now,
        cooldown_s=settings.alert_cooldown_s,
    )

    bankroll = await current_bankroll_cents(client, settings, prefix=prefix)
    links = provider_link_index(snapshots)
    for detection in winners:
        plan, _guardrails, alert = build_stake_plan(
            detection,
            settings,
            bankroll_cents=bankroll,
            link_templates={k: v.get("link_templates", {}) for k, v in books.items()},
            provider_event_id=detection.event_id.split(":", 1)[-1],
            provider_links=links,
            book_state=settings.book_state,
        )
        if plan is None or not alert:
            continue

        recommendation_id = f"{detection.hash[:16]}-{int(now.timestamp())}"
        message = render_alert(
            detection,
            plan,
            recommendation_id=recommendation_id,
            paper_mode=settings.paper_mode,
        )
        message_ref = await sink.send(message, recommendation_id=recommendation_id)

        await client.index(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
            # The id §9.3 routes a button tap on and the id §12 grades against
            # have to be this document's id. Letting Elasticsearch autogenerate
            # one left `rec:{id}:bet` pointing at a document that did not exist.
            id=recommendation_id,
            document={
                "opportunity_id": detection.hash,
                "stakes": plan.model_dump(),
                "paper": settings.paper_mode,
                "channel": sink.name,
                "sent_at": utc_now_iso(),
                "message_ref": message_ref or "",
            },
            refresh="wait_for",
        )
        # Only now does the opportunity count as alerted — which is what the
        # cooldown, the re-alert gate and T2.5's instrumentation all read. The
        # edge goes with it: it is the baseline every later re-alert is
        # measured against (§7.4).
        await client.update(
            index=opportunities,
            id=detection.hash,
            doc={"status": STATUS_ALERTED, "alerted_edge_pct": detection.edge_pct},
            refresh="wait_for",
        )
        report.alerted.append(detection)

    return report


async def capture_closing_lines(
    provider,
    client,
    *,
    sport_key: str,
    settings: Settings,
    prefix: str = "edgeline-",
    now: datetime | None = None,
    fallback_tried: set[str] | None = None,
) -> list[str]:
    """Snapshot the closing line for events about to start (§12 step 4, §13).

    `fallback_tried` is the caller's record of games already asked for by id
    after a window left them out, so each costs one fallback request, not one
    a minute until it starts; `None` asks again every call.

    These `is_closing` rows are the only thing CLV can be computed against, and
    the window they are taken in is unrepeatable — once the event starts, the
    closing price is gone. So this is deliberately cheap to call often and safe
    to call repeatedly: an event that already has a closing snapshot is skipped,
    which is what lets §13's one-shot-per-event job be a periodic sweep instead.

    A sweep rather than a per-event timer is a deliberate substitution: an
    in-process one-shot is lost on restart, and losing it means losing that
    event's CLV forever. The observable behaviour is the same.

    **"Cheap to call often" has to mean cheap in credits, not just in writes.**
    This used to fetch first and ask whether anything was due second, so a sweep
    on §13's 60-second interval bought a full featured-odds response every minute
    — `markets x regions` credits — purely to discover that no event was inside
    the window. Measured 2026-09-09: it spent the entire 500-credit monthly free
    tier in 66 minutes, and the §8.4 budget guard never saw it coming because
    that arithmetic only counts the featured poll. The window question is now
    answered from Elasticsearch, which already holds every event's
    `commence_time`, and the provider is only paid when there is something to
    capture.
    """
    now = now or datetime.now(timezone.utc)
    window_end = now + timedelta(seconds=settings.closing_capture_offset_s)

    if settings.offline_mode:
        # §3.2. Closing lines are unrepeatable, so this does lose them for any
        # event starting while offline — which is the honest cost of not paying
        # the provider, and better than a CLV built from prices nobody fetched.
        return []

    if settings.closing_capture_mode == "off":
        # §3.2, the default. CLV derives from the last price already stored
        # before the event started, so this buys nothing. Measured 2026-09-11:
        # buying one for every event is 1,188 credits/month against a budget of
        # 500, and most of it goes on events nobody bet.
        return []

    markets = list(settings.markets_featured)
    wanted: dict[str, set[str]] = {}
    if settings.closing_capture_mode == "recommended":
        if not await _recommended_events_awaiting_closing(
            client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
        ):
            return []
    elif settings.closing_capture_mode == "opportunities":
        wanted = await _opportunity_events_awaiting_closing(
            client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
        )
        if not wanted:
            return []
        # Only the markets an opportunity is in: a closing line nobody's CLV
        # reads measures nothing, and every market is another credit.
        markets = sorted(set().union(*wanted.values()))
    elif not await _closing_capture_is_due(
        client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
    ):
        return []

    # Always the broad `regions`, never the named books (§8.4, 2026-10-01): a
    # closing line is grading's consensus, and offshore books belong in it. The
    # window asks only for the games about to start; none in it is free.
    window = {
        "commence_time_from": now.strftime(PROVIDER_STAMP),
        "commence_time_to": window_end.strftime(PROVIDER_STAMP),
    }
    response = await provider.fetch_odds(
        sport_key, markets, regions=",".join(settings.regions), **window
    )
    quarantine: list[UnmatchedRow] = []
    snapshots = normalize(provider.key, response.payload, quarantine=quarantine)

    due = [
        s for s in snapshots if now < parse_iso(s.commence_time) <= window_end
    ]
    event_ids = {event_doc_id(s.sport_key, s.provider_event_id) for s in due}
    already = await _events_with_closing_lines(client, event_ids | set(wanted), prefix=prefix)

    # An opportunity's game the window should have returned and did not
    # (2026-10-07). Sunday 10-04's 13:00 ET NFL window came back with 2 of its
    # 8 games, and the 20:05 and 00:20 windows with none, so 6 of 8 games with an
    # opportunity were graded against a price hours old. The laptop was awake,
    # the sweep fired on time, and `/events` honours the same window, so the
    # answer itself is what was short. Each such game is asked for once by its
    # own id, and what both answers said is kept in `edgeline-unmatched`, so the
    # next miss shows its cause rather than only its effect.
    missed = sorted(set(wanted) - event_ids - already - (fallback_tried or set()))
    misses: list[UnmatchedRow] = []
    for event_id in missed:
        if fallback_tried is not None:
            fallback_tried.add(event_id)
        found, record = await _fetch_one_closing_line(
            provider, sport_key, event_id, sorted(wanted[event_id]), settings, quarantine
        )
        record.update(event_id=event_id, window=window, answered=_answer_summary(response.payload))
        misses.append(UnmatchedRow(provider.key, CLOSING_WINDOW_MISS, record))
        due.extend(found)
        event_ids |= {event_id} if found else set()

    from elasticsearch.helpers import async_bulk

    if quarantine or misses:
        log.warning(
            "closing capture for %s: %d game(s) with an opportunity missing from the "
            "window's answer, %d fragment(s) quarantined; kept in edgeline-unmatched",
            sport_key, len(misses), len(quarantine),
        )
        await async_bulk(
            client,
            [
                {"_index": with_prefix(UNMATCHED_INDEX, prefix), "_source": row.to_document()}
                for row in [*misses, *quarantine]
            ],
        )

    pending = [
        s
        for s in due
        if event_doc_id(s.sport_key, s.provider_event_id) not in already
    ]
    if not pending:
        return []

    await async_bulk(
        client,
        [
            {"_index": with_prefix(ODDS_SNAPSHOTS_INDEX, prefix), "_source": doc}
            for doc in snapshot_documents(pending, is_closing=True)
        ],
    )
    captured = sorted(event_ids - already)
    log.info("captured closing lines for %d event(s)", len(captured))
    return captured


#: `edgeline-unmatched` reason for a game the closing window's answer left out.
CLOSING_WINDOW_MISS = "closing_window_miss"


def _answer_summary(payload: Any) -> list[dict[str, Any]]:
    """Each event an odds answer held: id, start, and how many books priced it."""
    if not isinstance(payload, list):
        return [{"shape": type(payload).__name__}]
    return [
        {
            "id": event.get("id"),
            "commence_time": event.get("commence_time"),
            "books": len(event.get("bookmakers") or []),
        }
        for event in payload
        if isinstance(event, dict)
    ]


async def _fetch_one_closing_line(
    provider,
    sport_key: str,
    event_id: str,
    markets: list[str],
    settings: Settings,
    quarantine: list[UnmatchedRow],
) -> tuple[list[BookOddsSnapshot], dict[str, Any]]:
    """One missed game's closing line by its own id, and what the answer said.

    `/events/{id}/odds` bills `markets x regions` like the window does, for one
    game. Its snapshots are kept whatever start time it gives, since the game
    has not started: a start that moved out of the window is itself the finding.
    """
    provider_event_id = event_id.split(":", 1)[1]
    try:
        response = await provider.fetch_event_odds(
            sport_key, provider_event_id, markets, regions=",".join(settings.regions)
        )
    except Exception as failed:
        return [], {"fallback": {"error": f"{type(failed).__name__}: {failed}"}}
    found = [
        s
        for s in normalize(provider.key, response.payload, quarantine=quarantine)
        if event_doc_id(s.sport_key, s.provider_event_id) == event_id
    ]
    payload = response.payload if isinstance(response.payload, dict) else {}
    return found, {
        "fallback": {
            "commence_time": payload.get("commence_time"),
            "books": len(payload.get("bookmakers") or []),
            "snapshots": len(found),
        }
    }


async def _closing_capture_is_due(
    client, *, sport_key: str, now: datetime, window_end: datetime, prefix: str
) -> bool:
    """Is any stored event inside the closing window still missing its snapshot?

    Answered from Elasticsearch alone, because the only other place to ask is the
    provider, and the provider charges per question. `edgeline-events` already
    carries `commence_time` for every event a poll has ever seen, which is the
    same set the odds response would describe.

    **Fails closed.** An unreadable answer returns `False`, skipping this tick.
    The sweep runs every 60 seconds, so a transient Elasticsearch error costs one
    minute of delay; failing the other way is what emptied a month of credits in
    an hour, one wasted fetch at a time, and a *persistent* fault would do it
    again. The exposure is bounded either way: a closing line is lost only if ES
    stays unreadable for the whole window before an event starts.
    """
    event_ids = await _events_in_window(
        client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
    )
    if not event_ids:
        return False
    return bool(event_ids - await _events_with_closing_lines(client, event_ids, prefix=prefix))


async def _events_in_window(
    client, *, sport_key: str, now: datetime, window_end: datetime, prefix: str
) -> set[str]:
    """Stored events starting inside the closing window. Empty on any failure."""
    stamp = "%Y-%m-%dT%H:%M:%SZ"
    try:
        found = await client.search(
            index=with_prefix(EVENTS_INDEX, prefix),
            size=1000,
            source=False,
            query={
                "bool": {
                    "filter": [
                        {"term": {"sport_key": sport_key}},
                        {
                            "range": {
                                "commence_time": {
                                    "gt": now.strftime(stamp),
                                    "lte": window_end.strftime(stamp),
                                }
                            }
                        },
                    ]
                }
            },
        )
    except Exception:
        log.warning("closing-capture due check failed; skipping this sweep")
        return set()
    return {hit["_id"] for hit in found["hits"]["hits"]}


async def _recommended_events_awaiting_closing(
    client, *, sport_key: str, now: datetime, window_end: datetime, prefix: str
) -> bool:
    """`closing_capture_mode="recommended"`: is any event in the window one we
    actually alerted a bet on?

    CLV exists only for a recommendation, so an event nobody bet needs no bought
    closing line — its price still gets derived from the last stored poll for
    free. This is the difference between ~90 credits a month and 1,188.
    """
    event_ids = await _events_in_window(
        client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
    )
    if not event_ids:
        return False
    outstanding = event_ids - await _events_with_closing_lines(
        client, event_ids, prefix=prefix
    )
    if not outstanding:
        return False

    try:
        found = await client.search(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix),
            size=0,
            query={
                "bool": {
                    "filter": [
                        {"terms": {"event_id": sorted(outstanding)}},
                        {"term": {"status": STATUS_ALERTED}},
                    ]
                }
            },
        )
    except Exception:
        return False
    return found["hits"]["total"]["value"] > 0


async def _opportunity_events_awaiting_closing(
    client, *, sport_key: str, now: datetime, window_end: datetime, prefix: str
) -> dict[str, set[str]]:
    """`closing_capture_mode="opportunities"`: each game to buy a closing line
    for, with the markets to buy it in.

    Every market of every opportunity, **of any status**, on a game starting
    inside the window that still lacks its closing line. Any status because each
    opportunity's CLV is worth measuring (2026-10-01): one closed an hour after
    detection is as much a measurement as one still open, and an alert is not
    what makes a price worth knowing. Answered from Elasticsearch, so a sweep
    with nothing due costs nothing; empty on any failure, so it fails closed.
    """
    event_ids = await _events_in_window(
        client, sport_key=sport_key, now=now, window_end=window_end, prefix=prefix
    )
    if not event_ids:
        return {}
    outstanding = event_ids - await _events_with_closing_lines(
        client, event_ids, prefix=prefix
    )
    if not outstanding:
        return {}
    try:
        found = await client.search(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix),
            size=0,
            query={"terms": {"event_id": sorted(outstanding)}},
            aggs={
                "events": {
                    "terms": {"field": "event_id", "size": 1000},
                    "aggs": {"markets": {"terms": {"field": "market_key", "size": 50}}},
                }
            },
        )
    except Exception:
        log.warning("closing-capture opportunity check failed; skipping this sweep")
        return {}
    buckets = found.get("aggregations", {}).get("events", {}).get("buckets", [])
    return {
        bucket["key"]: {market["key"] for market in bucket["markets"]["buckets"]}
        for bucket in buckets
    }


async def _events_with_closing_lines(
    client, event_ids: set[str], *, prefix: str
) -> set[str]:
    if not event_ids:
        return set()
    try:
        found = await client.search(
            index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix),
            size=0,
            query={
                "bool": {
                    "filter": [
                        {"terms": {"event_id": sorted(event_ids)}},
                        {"term": {"is_closing": True}},
                    ]
                }
            },
            aggs={"events": {"terms": {"field": "event_id", "size": 1000}}},
        )
    except Exception:
        return set()
    buckets = found.get("aggregations", {}).get("events", {}).get("buckets", [])
    return {bucket["key"] for bucket in buckets}


async def load_live_opportunities(
    client, sport_key: str, *, prefix: str
) -> dict[str, dict[str, Any]]:
    """Every open or alerted opportunity for this sport, with concurrency tokens.

    `event_id` is `{sport_key}:{provider_event_id}` (§4.3), so a prefix query on
    that keyword is enough to scope by sport without a separate field.
    """
    try:
        found = await client.search(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix),
            query={
                "bool": {
                    "filter": [
                        {"prefix": {"event_id": f"{sport_key}:"}},
                        {"terms": {"status": [STATUS_OPEN, STATUS_ALERTED]}},
                    ]
                }
            },
            size=1000,
            seq_no_primary_term=True,  # §4.4 rule 4
        )
    except Exception:
        return {}
    return {hit["_id"]: hit for hit in found["hits"]["hits"]}


async def load_last_alert_times(
    client, *, prefix: str, now: datetime, cooldown_s: int
) -> dict[tuple[str, str], str]:
    """When each `(sport, market_key)` was last alerted, for §7.4's cooldown.

    Derived rather than stored: `edgeline-recommendations` knows *when* an alert
    went out (`sent_at`) and `edgeline-opportunities` knows *what* it was about
    (`market_key`, `event_id`). Joining the two here avoids adding a field to
    §4.3 for something the schema can already answer. Only the cooldown window is
    queried, so this reads a handful of documents at most.
    """
    cutoff = (now - timedelta(seconds=cooldown_s)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        recent = await client.search(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
            query={"range": {"sent_at": {"gte": cutoff}}},
            sort=[{"sent_at": {"order": "desc"}}],
            size=200,
        )
        hits = recent["hits"]["hits"]
        if not hits:
            return {}
        ids = list({hit["_source"]["opportunity_id"] for hit in hits})
        fetched = await client.mget(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix), ids=ids
        )
    except Exception:
        return {}

    by_id = {
        doc["_id"]: doc["_source"]
        for doc in fetched["docs"]
        if doc.get("found")
    }
    last: dict[tuple[str, str], str] = {}
    for hit in hits:  # newest first, so the first write per key wins
        source = by_id.get(hit["_source"]["opportunity_id"])
        if source is None:
            continue
        key = cooldown_key(
            source["event_id"].split(":", 1)[0], source.get("market_key", "")
        )
        last.setdefault(key, hit["_source"]["sent_at"])
    return last


async def _earlier_lives(client, index: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    """Stored documents for hashes this cycle is about to (re)create.

    Not live, or `load_live_opportunities` would have returned them — so a line
    that closed and has come back, carrying `alerted_edge_pct` if it was alerted
    in its earlier life. Empty on a failed read, which treats them as new: the
    record's duplicate rule (§12) still catches a repeat at the same price, and
    raising here would fail a cycle whose odds are already bought.
    """
    if not ids:
        return {}
    try:
        found = await client.mget(index=index, ids=sorted(set(ids)))
    except Exception:
        log.warning("could not read earlier opportunity documents; treating them as new")
        return {}
    return {doc["_id"]: doc["_source"] for doc in found["docs"] if doc.get("found")}


async def _recommended_opportunities(client, ids: list[str], *, prefix: str) -> set[str]:
    """Which of `ids` a recommendation names — alerted, whatever the document says.

    Asked only of documents recording no alert, which after 2026-10-01 means
    ones alerted before `alerted_edge_pct` existed and since closed: closing
    overwrote `status`, and nothing else on the document remembers the alert.
    **Fails closed** — an unreadable answer counts every id as alerted, which
    defers a never-alerted opportunity by one cycle rather than risking a second
    alert on a bet already recommended.
    """
    wanted = sorted(set(ids))
    if not wanted:
        return set()
    try:
        found = await client.search(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
            size=0,
            query={"terms": {"opportunity_id": wanted}},
            aggs={"named": {"terms": {"field": "opportunity_id", "size": len(wanted)}}},
        )
    except Exception:
        log.warning("could not read which opportunities were recommended; holding their alerts")
        return set(wanted)
    buckets = found.get("aggregations", {}).get("named", {}).get("buckets", [])
    return {bucket["key"] for bucket in buckets}


async def _retire_vanished(
    client,
    index: str,
    stored: dict[str, dict[str, Any]],
    detected: dict[str, Detection],
    now: datetime,
    now_iso: str,
    report: CycleReport,
    *,
    window_end: datetime | None = None,
) -> None:
    """Close or expire opportunities the feed no longer shows (§7.4), and record
    the line deaths among them (T2.5).

    **Only inside the window the poll asked about** (2026-10-01). A poll limited
    by `poll_lookahead_h` returns nothing for a game beyond `window_end`, which
    says nothing about its line — closing those would end every opportunity
    days out on each poll, the NBA's 12-25 recommendation and NFL Ravens @
    Falcons on 10-11 among them, and log line deaths that never happened.
    """
    for doc_id, hit in stored.items():
        source = hit["_source"]
        was_alerted = source.get("status") == STATUS_ALERTED

        if doc_id in detected:
            if was_alerted:
                report.surviving_alerts.append(doc_id)
            continue

        expires_at = source.get("expires_at")
        if expires_at and is_expired(expires_at, now):
            await _update_opportunity(
                client, index, doc_id, expiry_transition(now_iso=now_iso), hit
            )
            report.expired.append(doc_id)
            continue

        if window_end is not None and expires_at and parse_iso(expires_at) > window_end:
            report.beyond_window.append(doc_id)
            continue

        edge = source.get("edge_pct", 0.0)
        await _update_opportunity(
            client, index, doc_id, closing_transition(edge, now_iso=now_iso), hit
        )
        report.closed.append(doc_id)

        if was_alerted:
            detected_at = source.get("detected_at", now_iso)
            report.line_deaths.append(
                LineDeath(
                    opportunity_hash=doc_id,
                    market_key=source.get("market_key", ""),
                    type=source.get("type", ""),
                    edge_pct=edge,
                    detected_at=detected_at,
                    closed_at=now_iso,
                    lifetime_s=(now - parse_iso(detected_at)).total_seconds(),
                )
            )
            log.info(
                "line death: %s %s lived %.0fs at %.2f%%",
                source.get("type", ""),
                source.get("market_key", ""),
                report.line_deaths[-1].lifetime_s,
                edge,
            )


async def _update_opportunity(
    client, index: str, doc_id: str, patch: dict[str, Any], hit: dict[str, Any]
) -> None:
    """Partial update under optimistic concurrency, retried once (§4.4 rule 4).

    The API process and the worker both write opportunity status, so a blind
    update would let one clobber the other's transition. On a conflict the
    document has moved underneath us; re-read it and apply the patch to whatever
    is there now.
    """
    from elasticsearch import ConflictError

    try:
        await client.update(
            index=index,
            id=doc_id,
            doc=patch,
            if_seq_no=hit.get("_seq_no"),
            if_primary_term=hit.get("_primary_term"),
            refresh="wait_for",
        )
    except ConflictError:
        log.info("conflict updating %s; retrying once", doc_id)
        await client.update(index=index, id=doc_id, doc=patch, refresh="wait_for")


def _format(report: CycleReport) -> str:
    lines = [
        f"sport            {report.sport_key}",
        f"snapshots        {report.snapshots}",
        f"events           {report.events}",
        f"quarantined      {report.quarantined}",
        f"enabled books    {report.enabled_books}",
        f"quota            {report.quota_used} used / {report.quota_remaining} left",
        f"asked for        "
        + (f"{report.named_books} named books" if report.named_books else "regions")
        + (f", events to {report.window_to}" if report.window_to else ", every event listed"),
        f"detections       {len(report.detections)}",
        f"recommendations  {len(report.alerted)}",
        f"closed/expired   {len(report.closed)} / {len(report.expired)}"
        + (f" ({len(report.beyond_window)} beyond the window, left)" if report.beyond_window else ""),
        f"alerts surviving {len(report.surviving_alerts)}",
    ]
    for death in report.line_deaths:
        lines.append(
            f"line death       {death.type} {death.market_key} "
            f"lived {death.lifetime_s:.0f}s at {death.edge_pct:+.2f}%"
        )
    if report.offline:
        lines.append(
            "OFFLINE          offline_mode is on, so no provider request was "
            "made and nothing was ingested (§3.2)."
        )
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
    from .scheduler import record_poll, sports_for_poll_now

    client = get_client()
    provider = TheOddsApiProvider()
    try:
        await ensure_indices(client)
        settings = await load_settings(client, prefix="edgeline-")
        # What the dashboard's button would poll right now, unless told.
        for sport_key in args.sports or sports_for_poll_now(settings):
            report = await run_once(
                provider, client, sport_key=sport_key, settings=settings
            )
            if not report.offline:
                # A cycle from here is a poll like any other, so the worker's
                # plan must see it: stamped, a slot due within three hours
                # stands down instead of buying the same sport again (§13).
                await record_poll(client, prefix="edgeline-", sport_key=sport_key, source="cli")
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
        "--sports",
        nargs="*",
        help="sport keys to poll (default: today's sports in poll_schedule, else sports_enabled)",
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

"""Grading and CLV — spec §12.

This is the job that decides whether any of the rest of the system works. While
`paper_mode` is on nothing is placed, so P&L is hypothetical; **CLV is the number
that carries information**, because it compares the price we alerted at against
where the market actually closed. A detector that finds real edges beats the
close; one that finds noise does not, and no amount of paper profit disguises it.

Two properties matter more than anything else here:

* **Idempotency.** Results are written with the recommendation id as `_id`
  (§4.4 rule 1), so re-running the job overwrites rather than double-counts. That
  matters because step 5 appends to the bankroll ledger, and a ledger is exactly
  the place where "ran twice" becomes real money that never existed.
* **Refusing to guess a settlement.** Anything not derivable from the scores API —
  props above all — is `void`/`needs_manual` rather than settled on an assumption.
  A wrongly graded bet corrupts the CLV record that the go-live decision rests on.

§16.1 still holds: this reads results, it never places anything.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .indices import (
    BANKROLL_LEDGER_INDEX,
    BETS_INDEX,
    EVENTS_INDEX,
    ODDS_SNAPSHOTS_INDEX,
    OPPORTUNITIES_INDEX,
    RECOMMENDATIONS_INDEX,
    RESULTS_INDEX,
    SETTINGS_INDEX,
    event_doc_id,
    with_prefix,
)
from .oddsmath import clv_pct, consensus, devig, implied_prob
from .schemas import utc_now_iso

log = logging.getLogger(__name__)

WIN = "win"
LOSS = "loss"
PUSH = "push"
VOID = "void"

REASON_WON = "bet_won"
REASON_LOST = "bet_lost"

H2H_MARKETS = frozenset({"h2h"})
SPREAD_MARKETS = frozenset({"spreads"})
TOTALS_MARKETS = frozenset({"totals"})


@dataclass
class GradingReport:
    """What one grading run did."""

    events_updated: int = 0
    graded: list[str] = field(default_factory=list)
    skipped_ungradable: list[str] = field(default_factory=list)
    ledger_entries: int = 0
    daily_loss_cents: int = 0
    kill_switch_tripped: bool = False


# ---- settlement (§12 step 2), pure ----------------------------------------


def settle_h2h(selection: str, scores: dict[str, int]) -> str:
    """Winner takes it. Equal scores push — baseball rarely ties, but a called
    game can, and treating that as a loss would be inventing a result."""
    if selection not in scores:
        return VOID
    best = max(scores.values())
    if list(scores.values()).count(best) > 1:
        return PUSH
    return WIN if scores[selection] == best else LOSS


def settle_totals(selection: str, line: float | None, scores: dict[str, int]) -> str:
    """`Over {point}` / `Under {point}` against the combined score."""
    if line is None or len(scores) < 2:
        return VOID
    total = sum(scores.values())
    if total == line:
        return PUSH
    if selection.startswith("Over "):
        return WIN if total > line else LOSS
    if selection.startswith("Under "):
        return WIN if total < line else LOSS
    return VOID


def settle_spread(selection: str, line: float | None, scores: dict[str, int]) -> str:
    """`{team} {+/-point}` against the adjusted margin."""
    if line is None or len(scores) < 2:
        return VOID
    team = selection.rsplit(" ", 1)[0]
    if team not in scores:
        return VOID
    opponent = max(score for name, score in scores.items() if name != team)
    adjusted = scores[team] + line
    if adjusted == opponent:
        return PUSH
    return WIN if adjusted > opponent else LOSS


def settle_leg(
    market_key: str, selection: str, line: float | None, scores: dict[str, int]
) -> str:
    """Dispatch on market. Anything not derivable from the scores API is `void`.

    §12 is explicit that props are largely ungradable this way, and a void that
    the UI flags for a human beats a guess that quietly poisons the CLV record.
    """
    if market_key in H2H_MARKETS:
        return settle_h2h(selection, scores)
    if market_key in TOTALS_MARKETS:
        return settle_totals(selection, line, scores)
    if market_key in SPREAD_MARKETS:
        return settle_spread(selection, line, scores)
    return VOID


def leg_pnl_cents(outcome: str, stake_cents: int, price_decimal: float) -> int:
    """§12 step 3. Win pays the profit only; loss forfeits the stake."""
    if outcome == WIN:
        return round(stake_cents * (price_decimal - 1.0))
    if outcome == LOSS:
        return -stake_cents
    return 0  # push, void


def combine_outcomes(outcomes: list[str]) -> str:
    """One outcome for a multi-leg recommendation.

    An arbitrage always has one winning and one losing leg, so no single label
    describes it; what matters downstream is the summed P&L. `win` is reported
    when any leg won and none is unsettled, which is the useful reading for the
    ledger and the CLV record.
    """
    if not outcomes:
        return VOID
    if VOID in outcomes:
        return VOID
    if WIN in outcomes:
        return WIN
    if all(o == PUSH for o in outcomes):
        return PUSH
    return LOSS


def scores_from_event(event: dict[str, Any]) -> dict[str, int]:
    """`[{name, score}]` (score arrives as a string) -> `{team: int}`."""
    raw = event.get("scores") or []
    scores: dict[str, int] = {}
    for entry in raw:
        name = entry.get("name")
        try:
            scores[name] = int(entry.get("score"))
        except (TypeError, ValueError):
            continue
    return scores


# ---- the job (§12) ---------------------------------------------------------


async def grade(
    provider,
    client,
    *,
    sport_key: str,
    settings: Settings,
    prefix: str = "edgeline-",
    sink=None,
    now: datetime | None = None,
) -> GradingReport:
    """§12's six steps, in order."""
    from .notify import LogSink, render_system_notice

    sink = sink or LogSink()
    now = now or datetime.now(timezone.utc)
    report = GradingReport()

    # 1. Scores -> events.
    response = await provider.fetch_scores(sport_key, days_from=2)
    completed = await _update_events(client, response.payload, prefix=prefix, report=report)

    # 2-4. Settle every ungraded recommendation on a completed event.
    for recommendation in await _ungraded_recommendations(
        client, completed, prefix=prefix
    ):
        await _grade_one(
            client, recommendation, completed, settings, prefix=prefix, report=report
        )

    # 6. Daily loss stop.
    report.daily_loss_cents = await today_executed_losses(client, now, prefix=prefix)
    if report.daily_loss_cents >= settings.daily_loss_stop_cents:
        await _trip_kill_switch(client, prefix=prefix)
        report.kill_switch_tripped = True
        await sink.send(
            render_system_notice("🛑 Daily loss stop hit — alerting paused"),
            recommendation_id="system",
        )
        log.warning(
            "daily loss stop: %d cents lost today >= %d; kill_switch set",
            report.daily_loss_cents,
            settings.daily_loss_stop_cents,
        )

    return report


async def _update_events(
    client, payload: Any, *, prefix: str, report: GradingReport
) -> dict[str, dict[str, Any]]:
    """Step 1: write scores/completed onto `edgeline-events`; return completed ones."""
    completed: dict[str, dict[str, Any]] = {}
    for event in payload or []:
        if not isinstance(event, dict) or not event.get("id"):
            continue
        doc_id = event_doc_id(event.get("sport_key", ""), event["id"])
        scores = scores_from_event(event)
        patch: dict[str, Any] = {"completed": bool(event.get("completed"))}
        if len(scores) == 2:
            home, away = event.get("home_team"), event.get("away_team")
            if home in scores and away in scores:
                patch["home_score"] = scores[home]
                patch["away_score"] = scores[away]
        try:
            await client.update(
                index=with_prefix(EVENTS_INDEX, prefix),
                id=doc_id,
                doc=patch,
                refresh="wait_for",
            )
            report.events_updated += 1
        except Exception:
            # An event we never polled odds for has no document to update. That
            # is normal — the scores feed covers more than we quote.
            continue
        if patch["completed"] and scores:
            completed[doc_id] = {**event, "_scores": scores}
    return completed


async def _ungraded_recommendations(
    client, completed: dict[str, dict[str, Any]], *, prefix: str
) -> list[dict[str, Any]]:
    """Recommendations on completed events with no result document yet.

    "Ungraded" is checked with an `mget` against `edgeline-results` (§12 step 2)
    rather than a flag on the recommendation, so the results index stays the
    single source of truth about what has been settled.
    """
    if not completed:
        return []
    try:
        found = await client.search(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix), size=1000, query={"match_all": {}}
        )
    except Exception:
        return []
    hits = found["hits"]["hits"]
    if not hits:
        return []

    existing = await client.mget(
        index=with_prefix(RESULTS_INDEX, prefix), ids=[hit["_id"] for hit in hits]
    )
    graded = {doc["_id"] for doc in existing["docs"] if doc.get("found")}
    return [hit for hit in hits if hit["_id"] not in graded]


async def _grade_one(
    client,
    recommendation: dict[str, Any],
    completed: dict[str, dict[str, Any]],
    settings: Settings,
    *,
    prefix: str,
    report: GradingReport,
) -> None:
    rec_id = recommendation["_id"]
    source = recommendation["_source"]

    opportunity = await _get(
        client, with_prefix(OPPORTUNITIES_INDEX, prefix), source.get("opportunity_id", "")
    )
    if opportunity is None:
        report.skipped_ungradable.append(rec_id)
        return

    event_id = opportunity.get("event_id", "")
    event = completed.get(event_id)
    if event is None:
        return  # not finished yet; a later run will pick it up

    scores = event["_scores"]
    market_key = opportunity.get("market_key", "")
    stake_legs = (source.get("stakes") or {}).get("legs") or []
    opportunity_legs = opportunity.get("legs") or []

    outcomes: list[str] = []
    pnl_total = 0
    clv_numerator = 0.0
    clv_weight = 0

    for index, opp_leg in enumerate(opportunity_legs):
        stake_leg = stake_legs[index] if index < len(stake_legs) else {}
        stake_cents = int(stake_leg.get("stake_cents", 0))
        price = float(opp_leg.get("price_decimal", 0.0) or 0.0)
        selection = opp_leg.get("selection", "")
        line = opp_leg.get("line")

        outcome = settle_leg(market_key, selection, line, scores)
        outcomes.append(outcome)
        pnl_total += leg_pnl_cents(outcome, stake_cents, price)

        closing = await closing_consensus_prob(
            client, event_id, market_key, selection, settings, prefix=prefix
        )
        if closing is not None and price > 1.0 and stake_cents > 0:
            clv_numerator += clv_pct(closing, price) * stake_cents
            clv_weight += stake_cents

    outcome = combine_outcomes(outcomes)
    # §6.8 defines CLV for one bet. A multi-leg recommendation reports the
    # stake-weighted mean, which reduces to §6.8 exactly for a single leg.
    clv = (clv_numerator / clv_weight) if clv_weight else None

    bet = await _executed_bet(client, rec_id, prefix=prefix)
    document = {
        "bet_id": bet["_id"] if bet else "",
        "outcome": outcome,
        "pnl_cents": pnl_total,
        "clv_pct": clv,
        "needs_manual": outcome == VOID,
        "graded_at": utc_now_iso(),
    }
    await client.index(
        index=with_prefix(RESULTS_INDEX, prefix),
        id=rec_id,  # §4.4 rule 1: re-running overwrites, never duplicates
        document=document,
        refresh="wait_for",
    )
    report.graded.append(rec_id)
    if outcome == VOID:
        report.skipped_ungradable.append(rec_id)

    # 5. Only executed recommendations move the bankroll. Paper never does.
    if bet and pnl_total != 0:
        await client.index(
            index=with_prefix(BANKROLL_LEDGER_INDEX, prefix),
            document={
                "book_key": opportunity_legs[0].get("book_key", "") if opportunity_legs else "",
                "delta_cents": pnl_total,
                "reason": REASON_WON if pnl_total > 0 else REASON_LOST,
                "ref_result_id": rec_id,
                "@timestamp": utc_now_iso(),
            },
            refresh="wait_for",
        )
        report.ledger_entries += 1


async def closing_consensus_prob(
    client,
    event_id: str,
    market_key: str,
    selection: str,
    settings: Settings,
    *,
    prefix: str,
) -> float | None:
    """Consensus fair probability at the close, from `is_closing` snapshots (§12.4).

    Returns `None` when no closing snapshot exists — CLV is simply unknown for
    that bet, which is honest. It happens whenever the closing-capture task did
    not run for the event.
    """
    try:
        found = await client.search(
            index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix),
            size=500,
            query={
                "bool": {
                    "filter": [
                        {"term": {"event_id": event_id}},
                        {"term": {"market_key": market_key}},
                        {"term": {"is_closing": True}},
                    ]
                }
            },
        )
    except Exception:
        return None

    by_book: dict[str, dict[str, float]] = {}
    for hit in found["hits"]["hits"]:
        row = hit["_source"]
        by_book.setdefault(row["book_key"], {})[row["selection"]] = row["price_decimal"]

    fair: dict[str, float] = {}
    for book_key, prices in by_book.items():
        if len(prices) < 2 or selection not in prices:
            continue
        selections = list(prices)
        try:
            devigged = devig([implied_prob(prices[s]) for s in selections], settings.devig_method)
        except (ValueError, NotImplementedError):
            continue
        fair[book_key] = dict(zip(selections, devigged))[selection]

    if not fair:
        return None
    return consensus(fair, settings.consensus_weights)


async def today_executed_losses(
    client, now: datetime, *, prefix: str
) -> int:
    """Cents lost today on executed bets — §12 step 6's trigger.

    Paper recommendations are excluded by construction: a result only carries a
    `bet_id` when a human confirmed the bet, and only those reach the ledger.
    """
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        found = await client.search(
            index=with_prefix(RESULTS_INDEX, prefix),
            size=1000,
            query={
                "bool": {
                    "filter": [
                        {"range": {"graded_at": {"gte": start.strftime("%Y-%m-%dT%H:%M:%SZ")}}},
                        {"range": {"pnl_cents": {"lt": 0}}},
                    ],
                    "must_not": [{"term": {"bet_id": ""}}],
                }
            },
        )
    except Exception:
        return 0
    return sum(-hit["_source"]["pnl_cents"] for hit in found["hits"]["hits"])


async def _trip_kill_switch(client, *, prefix: str) -> None:
    """Set `kill_switch` true. The one setting this system writes for itself.

    §16.2 forbids *loosening* a guardrail without the user; tightening one in
    response to real losses is what §12 step 6 asks for.
    """
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="global",
        doc={"kill_switch": True},
        refresh="wait_for",
    )


async def _executed_bet(client, rec_id: str, *, prefix: str) -> dict[str, Any] | None:
    try:
        found = await client.search(
            index=with_prefix(BETS_INDEX, prefix),
            size=1,
            query={"term": {"recommendation_id": rec_id}},
        )
    except Exception:
        return None
    hits = found["hits"]["hits"]
    return hits[0] if hits else None


async def _get(client, index: str, doc_id: str) -> dict[str, Any] | None:
    if not doc_id:
        return None
    try:
        found = await client.get(index=index, id=doc_id)
    except Exception:
        return None
    return found["_source"]

"""Results summary — spec §10, §12.

§10 is explicit: "thin wrappers over ES aggregations (`date_histogram` + `sum`) —
do not recompute those in Python." So the buckets, sums and averages are computed
by Elasticsearch; the only arithmetic here is the hit-rate division, which is a
ratio of two aggregation outputs rather than a recomputation of the rows.

**Average CLV is the number to read on this page.** While `paper_mode` is on the
P&L is hypothetical, but CLV compares the price alerted at against where the
market closed — it is the one figure that says whether the detector is finding
real edges or noise, and §15's Phase 4 go-live gate rests on it.

**Which is why the average is reported with its provenance.** Since 2026-09-11 a
result's `clv_pct` may be measured against a bought closing snapshot or derived
from the last price stored before kickoff, which at the dev cadence can be twelve
hours old (§3.2 `closing_capture_mode`). Those are two different measurements.
Averaging them into one number and printing it beside a go-live gate would be the
strongest claim this system makes, resting on its weakest data — so the counts
travel with the figure and the page is expected to show them.

**Rows marked `excluded_reason` are left out of every figure, and counted.** Five
paper recommendations from 2026-09-09/10 were detected after their games had
started (`audit.py`), and until 2026-09-23 they were most of this page: −$39.03
and a 33% hit rate over a real record of one bet at +$6.52. They are marked, not
deleted, and `totals.excluded` says how many were set aside so the page can say
so — a figure that quietly drops rows is the same failure as one that quietly
mixes evidence. Since 2026-10-01 a repeat recommendation of one opportunity is the
second reason (`duplicate_alert`), so `totals.excluded_by_reason` says which.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends

from ...clv import RECOMMENDED_IDS_BODY, recommended_ids, summarise, summary_body
from ...indices import OPPORTUNITIES_INDEX, RECOMMENDATIONS_INDEX, RESULTS_INDEX
from ..deps import Context, get_context, mget, search
from ..models import SummaryResponse, WhatIfResponse

router = APIRouter(prefix="/results", tags=["results"])

INTERVALS = {"day": "1d", "week": "1w"}


@router.get("/summary", operation_id="getResultsSummary")
async def summary(
    group: Literal["day", "week"] = "day",
    context: Context = Depends(get_context),
) -> SummaryResponse:
    """P&L, hit rate, average CLV, and the paper-versus-executed split per bucket."""
    response = await search(
        context,
        RESULTS_INDEX,
        size=0,
        query={"bool": {"must_not": [{"exists": {"field": "excluded_reason"}}]}},
        aggs={
            # `global` ignores the query above, so this counts exactly the rows it
            # filtered out — one request, and the count cannot drift from the
            # filter it describes.
            "excluded": {
                "global": {},
                "aggs": {
                    "marked": {
                        "filter": {"exists": {"field": "excluded_reason"}},
                        # Why, per reason: since 2026-10-01 there are two, and a
                        # page that names one reason for all of them misstates
                        # the other.
                        "aggs": {"reasons": {"terms": {"field": "excluded_reason", "size": 20}}},
                    }
                },
            },
            "buckets": {
                "date_histogram": {
                    "field": "graded_at",
                    "calendar_interval": INTERVALS[group],
                    "min_doc_count": 1,
                },
                "aggs": {
                    "pnl_cents": {"sum": {"field": "pnl_cents"}},
                    "avg_clv_pct": {"avg": {"field": "clv_pct"}},
                    "clv_closing": {
                        "filter": {"term": {"clv_source": "closing"}},
                        "aggs": {"avg_clv_pct": {"avg": {"field": "clv_pct"}}},
                    },
                    "clv_derived": {"filter": {"term": {"clv_source": "derived"}}},
                    "wins": {"filter": {"term": {"outcome": "win"}}},
                    "settled": {"filter": {"terms": {"outcome": ["win", "loss"]}}},
                    "executed": {
                        "filter": {"bool": {"must_not": [{"term": {"bet_id": ""}}]}},
                        "aggs": {"pnl_cents": {"sum": {"field": "pnl_cents"}}},
                    },
                    "needs_manual": {"filter": {"term": {"needs_manual": True}}},
                },
            },
            "totals": {
                "filter": {"match_all": {}},
                "aggs": {
                    "pnl_cents": {"sum": {"field": "pnl_cents"}},
                    "avg_clv_pct": {"avg": {"field": "clv_pct"}},
                    "clv_closing": {
                        "filter": {"term": {"clv_source": "closing"}},
                        "aggs": {"avg_clv_pct": {"avg": {"field": "clv_pct"}}},
                    },
                    "clv_derived": {"filter": {"term": {"clv_source": "derived"}}},
                    "wins": {"filter": {"term": {"outcome": "win"}}},
                    "settled": {"filter": {"terms": {"outcome": ["win", "loss"]}}},
                },
            },
        },
    )

    aggregations = response.get("aggregations") or {}
    buckets = [
        _bucket(bucket)
        for bucket in aggregations.get("buckets", {}).get("buckets", [])
    ]
    # Every opportunity's CLV (§12, 2026-10-01): one more aggregation request,
    # shaped by `clv.py` so the CLI report and this page read the same figures.
    # `by_alert` needs the recommended ids first, so this is two requests.
    recommended = recommended_ids(
        await search(context, RECOMMENDATIONS_INDEX, **RECOMMENDED_IDS_BODY)
    )
    opportunity_clv = summarise(
        await search(
            context, OPPORTUNITIES_INDEX, track_total_hits=True, **summary_body(recommended)
        )
    )
    return {
        "group": group,
        "buckets": buckets,
        "totals": _totals(aggregations),
        "opportunity_clv": opportunity_clv,
    }


@router.get("/what-if", operation_id="getWhatIf")
async def what_if(context: Context = Depends(get_context)) -> WhatIfResponse:
    """Settled bets for the What-if page (§11, 2026-11-13): the paper ledger, and
    every settled single-leg +EV opportunity.

    Rows, not aggregations, unlike `/summary`: the page re-totals them on every
    toggle (sport, odds, edge, market, period, stake) and computes a luck range
    per bet, which a fixed aggregation cannot. There are a few hundred.
    """
    opportunities = await search(
        context, OPPORTUNITIES_INDEX, size=10_000,
        query={"bool": {"filter": [{"term": {"type": "ev"}}, {"exists": {"field": "bet_outcome"}}]}},
    )
    recommended = set(
        recommended_ids(await search(context, RECOMMENDATIONS_INDEX, **RECOMMENDED_IDS_BODY))
    )
    rows, without = [], 0
    for hit in opportunities.get("hits", {}).get("hits", []):
        row = _what_if_row(hit["_id"], hit["_source"], recommended=hit["_id"] in recommended)
        # A circular CLV was priced by the poll that found the edge, so it
        # restates the detector rather than testing it, and every other CLV
        # figure leaves it out (§12). Here it would also inflate "expected":
        # with them in, all opportunities averaged +10.8% against +7.3% for
        # football, the best sport.
        if row is None or row["clv_circular"]:
            without += 1
        else:
            rows.append(row)

    results = await search(
        context, RESULTS_INDEX, size=10_000,
        query={"bool": {"must_not": [{"exists": {"field": "excluded_reason"}}]}},
    )
    graded = {hit["_id"]: hit["_source"] for hit in results.get("hits", {}).get("hits", [])}
    recommendations = await mget(context, RECOMMENDATIONS_INDEX, sorted(graded))
    linked = await mget(
        context, OPPORTUNITIES_INDEX,
        sorted({r.get("opportunity_id", "") for r in recommendations.values()} - {""}),
    )
    paper, paper_without = [], 0
    for rec_id, result in graded.items():
        rec = recommendations.get(rec_id) or {}
        legs = (rec.get("stakes") or {}).get("legs") or []
        opportunity = linked.get(rec.get("opportunity_id", ""))
        if len(legs) != 1 or opportunity is None or result.get("clv_pct") is None:
            paper_without += 1
            continue
        leg = legs[0]
        stake = int(leg.get("stake_cents") or 0)
        if stake <= 0:
            paper_without += 1
            continue
        # The result's own CLV, measured at the price alerted at.
        base = _what_if_row(
            rec_id, {**opportunity, "clv_pct": result["clv_pct"]},
            recommended=True, require_outcome=False,
        )
        if base is None:
            paper_without += 1
            continue
        paper.append({
            **base,
            "book_key": leg.get("book_key", base["book_key"]),
            # The price alerted at, which a re-alert may have improved.
            "price_decimal": 1 + int(leg.get("to_win_cents") or 0) / stake,
            "clv_pct": result["clv_pct"],
            "outcome": result.get("outcome", "void"),
            "stake_cents": stake,
            "pnl_cents": int(result.get("pnl_cents") or 0),
        })
    rows.sort(key=lambda r: r["starts_at"])
    paper.sort(key=lambda r: r["starts_at"])
    return {
        "paper": paper,
        "opportunities": rows,
        "paper_without_clv": paper_without,
        "opportunities_without_clv": without,
    }


def _what_if_row(
    doc_id: str, source: dict[str, Any], *, recommended: bool, require_outcome: bool = True
) -> dict[str, Any] | None:
    """An opportunity as a `WhatIfBet`, or `None` when it cannot be judged:
    more than one leg, no price, no CLV, or (for an opportunity) no outcome."""
    legs = source.get("legs") or []
    if len(legs) != 1 or source.get("clv_pct") is None:
        return None
    leg = legs[0]
    price = float(leg.get("price_decimal") or 0)
    if price <= 1 or (require_outcome and not source.get("bet_outcome")):
        return None
    event_id = source.get("event_id", "")
    return {
        "id": doc_id,
        "sport_key": source.get("sport_key") or event_id.split(":", 1)[0],
        "event_id": event_id,
        "market_key": source.get("market_key", ""),
        "selection": leg.get("selection", ""),
        "book_key": leg.get("book_key", ""),
        "price_decimal": price,
        "edge_pct": source.get("edge_pct"),
        "consensus_edge_pct": source.get("consensus_edge_pct"),
        "sharp_edge_pct": source.get("sharp_edge_pct"),
        "shadow": bool(source.get("shadow")),
        "clv_pct": source["clv_pct"],
        "clv_sharp_pct": source.get("clv_sharp_pct"),
        "clv_circular": source.get("clv_circular"),
        "outcome": source.get("bet_outcome") or "void",
        "starts_at": source.get("expires_at", ""),
        "detected_at": source.get("detected_at"),
        "recommended": recommended,
    }


def _hit_rate(wins: int, settled: int) -> float | None:
    """Wins over settled bets. `None` rather than 0.0 when nothing has settled —
    a hit rate of zero and no data yet are very different claims."""
    return (wins / settled) if settled else None


def _bucket(bucket: dict[str, Any]) -> dict[str, Any]:
    wins = bucket["wins"]["doc_count"]
    settled = bucket["settled"]["doc_count"]
    return {
        "key": bucket["key_as_string"],
        "graded": bucket["doc_count"],
        "pnl_cents": int(bucket["pnl_cents"]["value"] or 0),
        "avg_clv_pct": bucket["avg_clv_pct"]["value"],
        **_clv_provenance(bucket),
        "wins": wins,
        "settled": settled,
        "hit_rate": _hit_rate(wins, settled),
        "executed": bucket["executed"]["doc_count"],
        "executed_pnl_cents": int(bucket["executed"]["pnl_cents"]["value"] or 0),
        "paper": bucket["doc_count"] - bucket["executed"]["doc_count"],
        "needs_manual": bucket["needs_manual"]["doc_count"],
    }


def _clv_provenance(scope: dict[str, Any]) -> dict[str, Any]:
    """How many of the CLV figures in this scope came from a bought closing line.

    Reported rather than folded in, because `avg_clv_pct` over a mix is one
    number standing for two measurements. A reader who cannot see the split
    cannot tell a result carried by real closing prices from one carried by
    prices up to twelve hours old.
    """
    closing = scope["clv_closing"]
    return {
        "clv_from_closing": closing["doc_count"],
        "clv_from_derived": scope["clv_derived"]["doc_count"],
        # The same average over the strong evidence alone. `None` when there is
        # none, which is the honest answer rather than the mixed figure.
        "avg_clv_pct_closing": closing["avg_clv_pct"]["value"],
    }


def _totals(aggregations: dict[str, Any]) -> dict[str, Any]:
    marked = aggregations.get("excluded", {}).get("marked", {})
    excluded = marked.get("doc_count", 0)
    by_reason = {
        bucket["key"]: bucket["doc_count"]
        for bucket in marked.get("reasons", {}).get("buckets", [])
    }
    totals = aggregations.get("totals")
    if not totals:
        return {
            "graded": 0,
            "pnl_cents": 0,
            "avg_clv_pct": None,
            "hit_rate": None,
            "clv_from_closing": 0,
            "clv_from_derived": 0,
            "avg_clv_pct_closing": None,
            "excluded": excluded,
            "excluded_by_reason": by_reason,
        }
    wins = totals["wins"]["doc_count"]
    settled = totals["settled"]["doc_count"]
    return {
        "graded": totals["doc_count"],
        "pnl_cents": int(totals["pnl_cents"]["value"] or 0),
        "avg_clv_pct": totals["avg_clv_pct"]["value"],
        **_clv_provenance(totals),
        "wins": wins,
        "settled": settled,
        "hit_rate": _hit_rate(wins, settled),
        "excluded": excluded,
        "excluded_by_reason": by_reason,
    }

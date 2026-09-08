"""Results summary — spec §10, §12.

§10 is explicit: "thin wrappers over ES aggregations (`date_histogram` + `sum`) —
do not recompute those in Python." So the buckets, sums and averages are computed
by Elasticsearch; the only arithmetic here is the hit-rate division, which is a
ratio of two aggregation outputs rather than a recomputation of the rows.

**Average CLV is the number to read on this page.** While `paper_mode` is on the
P&L is hypothetical, but CLV compares the price alerted at against where the
market closed — it is the one figure that says whether the detector is finding
real edges or noise, and §15's Phase 4 go-live gate rests on it.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends

from ...indices import RESULTS_INDEX
from ..deps import Context, get_context, search
from ..models import SummaryResponse

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
        query={"match_all": {}},
        aggs={
            "buckets": {
                "date_histogram": {
                    "field": "graded_at",
                    "calendar_interval": INTERVALS[group],
                    "min_doc_count": 1,
                },
                "aggs": {
                    "pnl_cents": {"sum": {"field": "pnl_cents"}},
                    "avg_clv_pct": {"avg": {"field": "clv_pct"}},
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
    return {"group": group, "buckets": buckets, "totals": _totals(aggregations)}


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
        "wins": wins,
        "settled": settled,
        "hit_rate": _hit_rate(wins, settled),
        "executed": bucket["executed"]["doc_count"],
        "executed_pnl_cents": int(bucket["executed"]["pnl_cents"]["value"] or 0),
        "paper": bucket["doc_count"] - bucket["executed"]["doc_count"],
        "needs_manual": bucket["needs_manual"]["doc_count"],
    }


def _totals(aggregations: dict[str, Any]) -> dict[str, Any]:
    totals = aggregations.get("totals")
    if not totals:
        return {"graded": 0, "pnl_cents": 0, "avg_clv_pct": None, "hit_rate": None}
    wins = totals["wins"]["doc_count"]
    settled = totals["settled"]["doc_count"]
    return {
        "graded": totals["doc_count"],
        "pnl_cents": int(totals["pnl_cents"]["value"] or 0),
        "avg_clv_pct": totals["avg_clv_pct"]["value"],
        "wins": wins,
        "settled": settled,
        "hit_rate": _hit_rate(wins, settled),
    }

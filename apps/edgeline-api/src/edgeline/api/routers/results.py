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
    }

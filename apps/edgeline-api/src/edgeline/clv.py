"""CLV for every opportunity — spec §12, supporting evidence for §15's T4.4.

`python -m edgeline.clv` measures what is missing and prints the report; the
worker's nightly grade measures it too. Neither asks the provider for anything.

**Why every opportunity.** §7.4's cooldown allows one alert per `(sport, market)`
per window, so by 2026-10-01 144 opportunities had produced 26 recommendations.
Grading recommendations alone measures CLV on a sixth of what the detector found,
and the other five sixths cost nothing more to measure: their prices are already
stored. Each opportunity is measured with grading's own `closing_consensus_prob`
at its **first-detection leg price** — `run_once` updates only `edge_pct` on an
existing opportunity, so its legs keep the price it was found at — once its game
has started, and stored on the opportunity with the same provenance a result
carries (`clv_source`, `clv_staleness_s`).

**Circular measurements are flagged and left out.** The closing price is the
newest stored before the start; when no poll priced the game after the one that
found the edge, that price *is* the detecting poll's, and the CLV re-measures
the detection edge rather than testing it. Seven of the first eight graded
recommendations were that (2026-10-01); the one genuine CLV among them was
+2.06%. `clv_circular` is true when the closing price was fetched at or before
`detected_at`, and the summary's figures exclude it while counting it.

T4.4 is unchanged — at least 200 paper recommendations, their CLV distribution,
reported to the user. This is evidence beside that, not a substitute for it.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .dedup import parse_iso
from .grading import CLV_CLOSING, CLV_DERIVED, closing_consensus_prob
from .indices import OPPORTUNITIES_INDEX, with_prefix
from .oddsmath import clv_pct
from .schemas import utc_now_iso

log = logging.getLogger(__name__)

STAMP = "%Y-%m-%dT%H:%M:%SZ"
#: How many opportunities one search measures before the next.
BATCH = 500

#: The report's odds bands, by the leg's decimal price: favourites, near even,
#: underdogs, long shots (the biggest edges so far: 11.5, 13, 10.5).
ODDS_BANDS: tuple[tuple[str, float | None, float | None], ...] = (
    ("under 2.0", None, 2.0),
    ("2.0 to 3.0", 2.0, 3.0),
    ("3.0 to 5.0", 3.0, 5.0),
    ("5.0 to 10.0", 5.0, 10.0),
    ("10.0 and over", 10.0, None),
)
#: The report's lead-time bands: how long before the start a detection came.
LEAD_BANDS_H: tuple[tuple[str, float | None, float | None], ...] = (
    ("under 2 h", None, 2),
    ("2 to 6 h", 2, 6),
    ("6 to 24 h", 6, 24),
    ("1 to 3 days", 24, 72),
    ("3 days and over", 72, None),
)


async def measure(
    client, source: dict[str, Any], settings: Settings, *, prefix: str
) -> dict[str, Any]:
    """The CLV fields for one opportunity whose game has started.

    A multi-leg opportunity (an arbitrage) reports the plain mean of its legs:
    there is no stake to weight by, and for one leg it is §6.8 exactly.
    """
    event_id = source.get("event_id", "")
    legs = source.get("legs") or []
    detected = source.get("detected_at")
    commence = source.get("expires_at")
    patch: dict[str, Any] = {
        "sport_key": event_id.split(":", 1)[0],
        "clv_graded_at": utc_now_iso(),
        "clv_price_decimal": legs[0].get("price_decimal") if len(legs) == 1 else None,
        "clv_lead_s": (
            int((parse_iso(commence) - parse_iso(detected)).total_seconds())
            if commence and detected
            else None
        ),
    }

    values: list[float] = []
    sources: set[str] = set()
    staleness: list[int] = []
    priced: list[str] = []
    for leg in legs:
        price = float(leg.get("price_decimal") or 0.0)
        if price <= 1.0:
            continue
        closing = await closing_consensus_prob(
            client, event_id, source.get("market_key", ""), leg.get("selection", ""),
            settings, prefix=prefix,
        )
        if closing is None:
            continue
        values.append(clv_pct(closing.prob, price))
        sources.add(closing.source)
        if closing.staleness_s is not None:
            staleness.append(closing.staleness_s)
        if closing.priced_at:
            priced.append(closing.priced_at)

    if not values:
        # Nothing stored before the start — honestly unknown, and final: no
        # pre-game price appears after the game has begun.
        return {**patch, "clv_pct": None, "clv_source": None, "clv_staleness_s": None,
                "clv_priced_at": None, "clv_circular": None}

    earliest = min(priced) if priced else None
    return {
        **patch,
        "clv_pct": sum(values) / len(values),
        # A mix is reported as derived, like a result: the weaker leg is what
        # the number inherits.
        "clv_source": CLV_CLOSING if sources == {CLV_CLOSING} else CLV_DERIVED,
        "clv_staleness_s": max(staleness) if staleness else None,
        "clv_priced_at": earliest,
        "clv_circular": bool(
            earliest and detected and parse_iso(earliest) <= parse_iso(detected)
        ),
    }


async def grade_opportunities(
    client, settings: Settings, *, prefix: str, now: datetime | None = None
) -> int:
    """Measure every opportunity whose game has started and has no CLV yet.

    Free — Elasticsearch only — and idempotent: `clv_graded_at` marks what is
    done, and it is set even when no price existed. Returns how many it measured.
    """
    now = now or datetime.now(timezone.utc)
    index = with_prefix(OPPORTUNITIES_INDEX, prefix)
    measured = 0
    while True:
        found = await client.search(
            index=index,
            size=BATCH,
            query={
                "bool": {
                    "filter": [{"range": {"expires_at": {"lte": now.strftime(STAMP)}}}],
                    "must_not": [{"exists": {"field": "clv_graded_at"}}],
                }
            },
            sort=[{"expires_at": {"order": "asc"}}],
        )
        hits = found["hits"]["hits"]
        for hit in hits:
            patch = await measure(client, hit["_source"], settings, prefix=prefix)
            await client.update(index=index, id=hit["_id"], doc=patch, refresh=False)
        measured += len(hits)
        if len(hits) < BATCH:
            break
        # The next search must not see this batch again.
        await client.indices.refresh(index=index)
    if measured:
        await client.indices.refresh(index=index)
    return measured


# ---- the report -------------------------------------------------------------


def _ranges(bands, scale: float) -> list[dict[str, Any]]:
    out = []
    for key, low, high in bands:
        row: dict[str, Any] = {"key": key}
        if low is not None:
            row["from"] = low * scale
        if high is not None:
            row["to"] = high * scale
        out.append(row)
    return out


_STATS: dict[str, Any] = {
    "mean": {"avg": {"field": "clv_pct"}},
    "median": {"percentiles": {"field": "clv_pct", "percents": [50]}},
    "positive": {"filter": {"range": {"clv_pct": {"gt": 0}}}},
    "closing": {"filter": {"term": {"clv_source": CLV_CLOSING}}},
}

#: The summary as one aggregation request (§10: summaries are ES aggregations,
#: not recomputed in Python). Every figure is over measured, non-circular
#: opportunities; `circular` and `unpriced` count what was set aside.
SUMMARY_BODY: dict[str, Any] = {
    "size": 0,
    "query": {"exists": {"field": "clv_graded_at"}},
    "aggs": {
        "measured": {
            "filter": {
                "bool": {
                    "filter": [
                        {"exists": {"field": "clv_pct"}},
                        {"term": {"clv_circular": False}},
                    ]
                }
            },
            "aggs": {
                **_STATS,
                "by_sport": {"terms": {"field": "sport_key", "size": 20}, "aggs": _STATS},
                "by_odds": {
                    "range": {"field": "clv_price_decimal", "ranges": _ranges(ODDS_BANDS, 1)},
                    "aggs": _STATS,
                },
                "by_lead": {
                    "range": {"field": "clv_lead_s", "ranges": _ranges(LEAD_BANDS_H, 3600)},
                    "aggs": _STATS,
                },
            },
        },
        "circular": {"filter": {"term": {"clv_circular": True}}},
        "unpriced": {"filter": {"bool": {"must_not": [{"exists": {"field": "clv_pct"}}]}}},
    },
}


def _stats(bucket: dict[str, Any], key: str | None = None) -> dict[str, Any]:
    count = bucket.get("doc_count", 0)
    median = (bucket.get("median", {}).get("values") or {}).get("50.0")
    return {
        "key": key,
        "count": count,
        "mean_clv_pct": bucket.get("mean", {}).get("value"),
        "median_clv_pct": median,
        # `None` rather than 0.0 with nothing measured: "no data" is not "never".
        "share_positive": (bucket["positive"]["doc_count"] / count) if count else None,
        "from_closing": bucket.get("closing", {}).get("doc_count", 0),
    }


def summarise(response: dict[str, Any]) -> dict[str, Any]:
    """The `SUMMARY_BODY` aggregations as the report's shape."""
    aggs = response.get("aggregations") or {}
    measured = aggs.get("measured") or {"doc_count": 0}
    total = response.get("hits", {}).get("total", {})
    return {
        "graded": total.get("value", 0) if isinstance(total, dict) else int(total or 0),
        "circular": (aggs.get("circular") or {}).get("doc_count", 0),
        "unpriced": (aggs.get("unpriced") or {}).get("doc_count", 0),
        "measured": _stats(measured),
        "by_sport": [
            _stats(bucket, bucket["key"])
            for bucket in measured.get("by_sport", {}).get("buckets", [])
        ],
        "by_odds": [
            _stats(bucket, bucket["key"])
            for bucket in measured.get("by_odds", {}).get("buckets", [])
        ],
        "by_lead": [
            _stats(bucket, bucket["key"])
            for bucket in measured.get("by_lead", {}).get("buckets", [])
        ],
    }


async def opportunity_clv_summary(client, *, prefix: str) -> dict[str, Any]:
    response = await client.search(
        index=with_prefix(OPPORTUNITIES_INDEX, prefix), track_total_hits=True, **SUMMARY_BODY
    )
    return summarise(response)


def _line(stats: dict[str, Any], label: str) -> str:
    def pct(value: float | None) -> str:
        return "    —" if value is None else f"{value:+6.2f}%"

    share = stats["share_positive"]
    return (
        f"  {label:18s} {stats['count']:4d}  mean {pct(stats['mean_clv_pct'])}  "
        f"median {pct(stats['median_clv_pct'])}  positive "
        f"{'  —' if share is None else f'{share:4.0%}'}  closing {stats['from_closing']}"
    )


def format_report(summary: dict[str, Any]) -> str:
    lines = [
        "CLV over every opportunity whose game has started (spec §12), circular left out",
        f"measured {summary['graded']}: {summary['measured']['count']} counted, "
        f"{summary['circular']} circular, {summary['unpriced']} with no stored price",
        _line(summary["measured"], "all"),
    ]
    for title, rows in (
        ("by sport", summary["by_sport"]),
        ("by odds", summary["by_odds"]),
        ("by lead time", summary["by_lead"]),
    ):
        lines.append(title)
        lines.extend(_line(row, str(row["key"])) for row in rows)
    lines.append(
        "Supporting evidence: T4.4 reads the recommendations' CLV, at least 200 of them."
    )
    return "\n".join(lines)


async def _run() -> int:
    from .engine import load_settings
    from .es import close_client, ensure_indices, get_client

    client = get_client()
    try:
        # Additive: gives an index created before 2026-10-01 the CLV fields.
        await ensure_indices(client)
        settings = await load_settings(client, prefix="edgeline-")
        measured = await grade_opportunities(client, settings, prefix="edgeline-")
        print(f"measured {measured} opportunit{'y' if measured == 1 else 'ies'} just now")
        print(format_report(await opportunity_clv_summary(client, prefix="edgeline-")))
        return 0
    finally:
        await close_client()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m edgeline.clv",
        description=(
            "Measure CLV for every opportunity whose game has started, then report it "
            "(spec §12). Reads and writes Elasticsearch only; asks the provider nothing."
        ),
    )
    parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())

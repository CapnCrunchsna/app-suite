"""CLV for every opportunity — spec §12, `clv.py` (added 2026-10-01).

The fixtures are one game priced by two polls: the detecting one at 12:00 and a
later one at 15:41, an hour before the 16:41 start. An opportunity found at
12:00 is measured against 15:41 — a real later price. One found by the 15:41
poll, or on a game no later poll priced, is measured against its own poll: the
circular CLV seven of the first eight graded recommendations were.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from edgeline.config import Settings

pytestmark = pytest.mark.es

REDS = "Cincinnati Reds"
PADRES = "San Diego Padres"
BOOKS = ["dk", "fd", "mgm", "czr", "brv"]
START = "2026-09-02T16:41:00Z"
NOW = datetime(2026, 9, 3, 6, 0, tzinfo=timezone.utc)
# 1.80 / 2.10 at the 15:41 poll: 0.555556 and 0.476190 de-vig to Reds 0.538462,
# so a Reds bet found at 2.10 has CLV 0.538462 x 2.10 - 1 = +13.0769%.
LATER_CLV = 13.0769


async def _fresh(client, prefix):
    from edgeline.es import ensure_indices

    await ensure_indices(client, prefix=prefix)
    await client.indices.put_settings(index=f"{prefix}*", settings={"refresh_interval": "50ms"})
    await client.delete_by_query(
        index=f"{prefix}*", query={"match_all": {}}, refresh=True, conflicts="proceed"
    )
    await ensure_indices(client, prefix=prefix)


async def _poll(client, prefix, event_id: str, stamp: str, reds: float, padres: float, *,
                closing: bool = False):
    from edgeline.indices import ODDS_SNAPSHOTS_INDEX, with_prefix

    for book in BOOKS:
        for selection, price in ((REDS, reds), (PADRES, padres)):
            await client.index(
                index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix),
                document={"event_id": event_id, "book_key": book, "market_key": "h2h",
                          "selection": selection, "line": None, "price_decimal": price,
                          "is_closing": closing, "@timestamp": stamp},
            )


async def _game(client, prefix, event_id: str, start: str = START):
    from edgeline.indices import EVENTS_INDEX, with_prefix

    await client.index(
        index=with_prefix(EVENTS_INDEX, prefix), id=event_id,
        document={"sport_key": event_id.split(":")[0], "commence_time": start,
                  "home_team": REDS, "away_team": PADRES},
    )


async def _opportunity(client, prefix, doc_id: str, event_id: str, detected: str, *,
                       price: float = 2.10, start: str = START):
    from edgeline.indices import OPPORTUNITIES_INDEX, with_prefix

    await client.index(
        index=with_prefix(OPPORTUNITIES_INDEX, prefix), id=doc_id,
        document={"type": "ev", "event_id": event_id, "market_key": "h2h",
                  "legs": [{"book_key": "dk", "selection": REDS, "line": None,
                            "price_decimal": price, "devig_prob": 0.46, "bet_first": False}],
                  "edge_pct": 7.0, "status": "expired", "detected_at": detected,
                  "expires_at": start},
    )


async def _stored(client, prefix, doc_id: str) -> dict:
    from edgeline.indices import OPPORTUNITIES_INDEX, with_prefix

    return (await client.get(index=with_prefix(OPPORTUNITIES_INDEX, prefix), id=doc_id))["_source"]


async def test_every_started_opportunity_is_measured_and_a_circular_one_is_flagged(
    es_url, test_index_prefix
):
    from elasticsearch import AsyncElasticsearch

    from edgeline.clv import grade_opportunities

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _fresh(client, prefix)
        await _game(client, prefix, "baseball_mlb:e1")
        await _poll(client, prefix, "baseball_mlb:e1", "2026-09-02T12:00:00Z", 1.90, 2.00)
        await _poll(client, prefix, "baseball_mlb:e1", "2026-09-02T15:41:00Z", 1.80, 2.10)
        await _game(client, prefix, "baseball_mlb:e2")
        await _poll(client, prefix, "baseball_mlb:e2", "2026-09-02T12:00:00Z", 1.90, 2.00)
        await _game(client, prefix, "baseball_mlb:e3")

        await _opportunity(client, prefix, "found-early", "baseball_mlb:e1", "2026-09-02T12:00:03Z")
        await _opportunity(client, prefix, "found-late", "baseball_mlb:e1", "2026-09-02T15:41:04Z")
        await _opportunity(client, prefix, "never-repriced", "baseball_mlb:e2", "2026-09-02T12:00:03Z")
        await _opportunity(client, prefix, "nothing-stored", "baseball_mlb:e3", "2026-09-02T12:00:03Z")
        await _opportunity(client, prefix, "not-started", "baseball_mlb:e4",
                           "2026-09-02T12:00:03Z", start="2026-09-09T16:41:00Z")
        await client.indices.refresh(index=f"{prefix}*")

        assert await grade_opportunities(client, Settings(), prefix=prefix, now=NOW) == 4

        early = await _stored(client, prefix, "found-early")
        assert early["clv_pct"] == pytest.approx(LATER_CLV, abs=1e-3)
        assert early["clv_circular"] is False
        assert early["clv_source"] == "derived"
        assert early["clv_staleness_s"] == 3600
        assert early["clv_priced_at"] == "2026-09-02T15:41:00Z"
        assert early["clv_lead_s"] == 16_857  # 12:00:03 to 16:41
        assert early["clv_price_decimal"] == 2.10
        assert early["sport_key"] == "baseball_mlb"

        # Priced by the poll that found it, so the CLV re-measures its own edge.
        assert (await _stored(client, prefix, "found-late"))["clv_circular"] is True
        assert (await _stored(client, prefix, "never-repriced"))["clv_circular"] is True

        unpriced = await _stored(client, prefix, "nothing-stored")
        assert unpriced["clv_pct"] is None
        assert unpriced["clv_graded_at"]  # done, and not asked again tomorrow

        assert "clv_graded_at" not in await _stored(client, prefix, "not-started")
        # Idempotent: nothing left to measure.
        assert await grade_opportunities(client, Settings(), prefix=prefix, now=NOW) == 0
    finally:
        await client.close()


async def test_a_bought_closing_line_is_used_and_labelled(es_url, test_index_prefix):
    from elasticsearch import AsyncElasticsearch

    from edgeline.clv import grade_opportunities

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _fresh(client, prefix)
        await _game(client, prefix, "baseball_mlb:e1")
        await _poll(client, prefix, "baseball_mlb:e1", "2026-09-02T12:00:00Z", 1.90, 2.00)
        await _poll(client, prefix, "baseball_mlb:e1", "2026-09-02T16:36:00Z", 1.80, 2.10,
                    closing=True)
        await _opportunity(client, prefix, "o", "baseball_mlb:e1", "2026-09-02T12:00:03Z")
        await client.indices.refresh(index=f"{prefix}*")

        await grade_opportunities(client, Settings(), prefix=prefix, now=NOW)
        stored = await _stored(client, prefix, "o")
        assert stored["clv_source"] == "closing"
        assert stored["clv_staleness_s"] is None
        assert stored["clv_circular"] is False
        assert stored["clv_pct"] == pytest.approx(LATER_CLV, abs=1e-3)
    finally:
        await client.close()


async def test_the_summary_counts_mean_median_and_share_with_circular_left_out(
    es_url, test_index_prefix
):
    """§12's report: count, mean, median, share positive — by sport, odds band and
    lead time — over measured opportunities, with the circular ones counted but
    kept out of every figure."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.clv import format_report, opportunity_clv_summary
    from edgeline.indices import OPPORTUNITIES_INDEX, with_prefix

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix

    async def measured(doc_id, sport, clv, price, lead_h, *, circular=False, source="derived"):
        await client.index(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix), id=doc_id,
            document={"type": "ev", "event_id": f"{sport}:{doc_id}", "market_key": "h2h",
                      "legs": [], "edge_pct": 5.0, "status": "expired",
                      "detected_at": "2026-09-27T12:00:00Z", "expires_at": "2026-09-27T17:00:00Z",
                      "sport_key": sport, "clv_pct": clv, "clv_source": source,
                      "clv_circular": circular, "clv_price_decimal": price,
                      "clv_lead_s": int(lead_h * 3600), "clv_graded_at": "2026-09-28T06:00:00Z"},
        )

    try:
        await _fresh(client, prefix)
        await measured("a", "americanfootball_ncaaf", 6.0, 11.5, 50)
        await measured("b", "americanfootball_ncaaf", -2.0, 2.4, 3)
        await measured("c", "americanfootball_nfl", 4.0, 1.9, 30, source="closing")
        await measured("circ", "americanfootball_ncaaf", 21.3, 13.0, 1, circular=True)
        await client.index(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix), id="unpriced",
            document={"type": "ev", "event_id": "icehockey_nhl:u", "market_key": "h2h", "legs": [],
                      "edge_pct": 2.5, "status": "expired", "detected_at": "2026-09-27T12:00:00Z",
                      "expires_at": "2026-09-27T23:00:00Z", "sport_key": "icehockey_nhl",
                      "clv_pct": None, "clv_graded_at": "2026-09-28T06:00:00Z"},
        )
        await client.indices.refresh(index=f"{prefix}*")

        summary = await opportunity_clv_summary(client, prefix=prefix)

        assert summary["graded"] == 5
        assert summary["circular"] == 1
        assert summary["unpriced"] == 1
        overall = summary["measured"]
        assert overall["count"] == 3
        assert overall["mean_clv_pct"] == pytest.approx(8.0 / 3)
        assert overall["median_clv_pct"] == pytest.approx(4.0, abs=0.5)
        assert overall["share_positive"] == pytest.approx(2 / 3)
        assert overall["from_closing"] == 1

        by_sport = {row["key"]: row for row in summary["by_sport"]}
        assert by_sport["americanfootball_ncaaf"]["count"] == 2  # the circular one left out
        assert by_sport["americanfootball_nfl"]["mean_clv_pct"] == pytest.approx(4.0)
        by_odds = {row["key"]: row["count"] for row in summary["by_odds"]}
        assert by_odds == {"under 2.0": 1, "2.0 to 3.0": 1, "3.0 to 5.0": 0,
                           "5.0 to 10.0": 0, "10.0 and over": 1}
        by_lead = {row["key"]: row["count"] for row in summary["by_lead"]}
        assert by_lead == {"under 2 h": 0, "2 to 6 h": 1, "6 to 24 h": 0,
                           "1 to 3 days": 2, "3 days and over": 0}

        text = format_report(summary)
        assert "3 counted, 1 circular, 1 with no stored price" in text
        assert "T4.4" in text
    finally:
        await client.close()

"""FastAPI surface — spec §10.

Every route runs against a real cluster under this file's own index prefix, wired
in with a single dependency override. The app's own lifespan (which bootstraps
the *production* prefix) never runs here: httpx's ASGI transport does not send
lifespan events, which is what keeps these tests off the real indices.
"""

from __future__ import annotations

import httpx
import pytest

from edgeline.config import DEFAULT_SETTINGS
from edgeline.schemas import utc_now_iso

pytestmark = pytest.mark.es

#: This file's own prefix, deliberately not the shared `edgeline-test-` one.
#:
#: The fixture below keeps its indices between tests instead of deleting and
#: recreating them, which is what makes this file fast. Every other ES test file
#: does the opposite — delete all eleven, recreate, run — and the two strategies
#: interfere on a shared prefix: leftover documents made grading tests see work
#: as already done, and one index reliably survived a delete. Separate namespaces
#: remove the whole class of problem rather than sequencing around it.
API_TEST_PREFIX = "edgeline-apitest-"

OPP_HASH = "b" * 64
REC_ID = "rec-api-test"
EVENT_ID = "baseball_mlb:evtA"


@pytest.fixture
async def api(es_url):
    """An HTTP client for the app, pointed at the test indices.

    Documents are wiped between tests but the **indices are kept**. Deleting and
    recreating all eleven per test cost ~16s a go, which turned this file into a
    six-minute run on its own; `delete_by_query` plus a re-seed does the same job
    in a fraction of it.
    """
    from elasticsearch import AsyncElasticsearch

    from edgeline.api.deps import Context, get_context
    from edgeline.api.main import create_app
    from edgeline.es import ensure_indices

    client = AsyncElasticsearch(hosts=[es_url])
    try:
        await client.delete_by_query(
            index=f"{API_TEST_PREFIX}*",
            query={"match_all": {}},
            refresh=True,
            conflicts="proceed",
        )
    except Exception:
        pass  # first run of the session: nothing to wipe yet
    # Recreates anything missing, and re-seeds the settings/sportsbook documents
    # the wipe just removed.
    await ensure_indices(client, prefix=API_TEST_PREFIX)
    await client.indices.put_settings(
        index=f"{API_TEST_PREFIX}*", settings={"refresh_interval": "50ms"}
    )

    app = create_app()
    app.dependency_overrides[get_context] = lambda: Context(
        client=client, prefix=API_TEST_PREFIX
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, client, API_TEST_PREFIX

    await client.close()


async def seed_recommendation(client, prefix, *, paper=True):
    from edgeline.indices import (
        OPPORTUNITIES_INDEX,
        RECOMMENDATIONS_INDEX,
        with_prefix,
    )

    await client.index(
        index=with_prefix(OPPORTUNITIES_INDEX, prefix),
        id=OPP_HASH,
        document={
            "type": "ev",
            "event_id": EVENT_ID,
            "market_key": "h2h",
            "legs": [
                {
                    "book_key": "dk",
                    "selection": "Cleveland Guardians",
                    "line": None,
                    "price_decimal": 2.10,
                    "devig_prob": 0.46,
                    "bet_first": False,
                }
            ],
            "edge_pct": 5.0,
            "status": "alerted",
            "detected_at": utc_now_iso(),
            "expires_at": utc_now_iso(),
        },
        refresh="wait_for",
    )
    await client.index(
        index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
        id=REC_ID,
        document={
            "opportunity_id": OPP_HASH,
            "stakes": {"total_cents": 1100, "legs": [], "method": "kelly",
                       "guardrails_applied": []},
            "paper": paper,
            "channel": "log",
            "sent_at": utc_now_iso(),
        },
        refresh="wait_for",
    )


# ---- OpenAPI (§10, feeds §11.3) -------------------------------------------


async def test_openapi_is_published_where_the_client_generator_expects_it(api):
    http, _client, _prefix = api
    response = await http.get("/api/openapi.json")

    assert response.status_code == 200
    schema = response.json()
    assert "/api/settings" in schema["paths"]
    assert "/api/system/health" in schema["paths"]


# ---- settings (§10, §3.2) --------------------------------------------------


async def test_settings_reads_back_the_full_default_map(api):
    http, _client, _prefix = api
    response = await http.get("/api/settings")

    assert response.status_code == 200
    assert response.json() == DEFAULT_SETTINGS


async def test_settings_patch_changes_only_what_it_names(api):
    http, _client, _prefix = api
    response = await http.put("/api/settings", json={"kelly_fraction": 0.1})

    assert response.status_code == 200
    body = response.json()
    assert body["kelly_fraction"] == 0.1
    assert body["max_stake_cents"] == DEFAULT_SETTINGS["max_stake_cents"]
    assert (await http.get("/api/settings")).json()["kelly_fraction"] == 0.1


async def test_an_unknown_settings_key_is_rejected_not_stored(api):
    """The index is `dynamic: false`, so a typo would be stored and then ignored
    by every reader — a setting that looks saved and does nothing."""
    http, _client, _prefix = api
    response = await http.put("/api/settings", json={"kelly_fractoin": 0.1})

    assert response.status_code == 400
    assert "kelly_fractoin" in response.json()["detail"]
    assert (await http.get("/api/settings")).json()["kelly_fraction"] == 0.25


async def test_a_badly_typed_setting_is_rejected(api):
    http, _client, _prefix = api
    response = await http.put("/api/settings", json={"devig_method": "vibes"})
    assert response.status_code == 422


# ---- sportsbooks (§10, §4.3) -----------------------------------------------


async def test_sportsbooks_come_back_seeded_and_disabled(api):
    http, _client, _prefix = api
    response = await http.get("/api/sportsbooks")

    from edgeline.indices import SPORTSBOOK_SEEDS

    assert response.status_code == 200
    books = response.json()
    # Counted from the seed rather than written out, so adding a confirmed book
    # is a one-line change instead of a test failure somewhere unrelated.
    assert {book["id"] for book in books} == set(SPORTSBOOK_SEEDS)
    assert all(book["enabled"] is False for book in books)
    assert [book["priority"] for book in books] == sorted(b["priority"] for b in books)


async def test_enabling_a_book_is_what_the_ui_is_for(api):
    """§4.3 leaves every seed disabled and `md_licensed` absent because the
    implementer may not verify licensure; a human supplies both here."""
    http, _client, _prefix = api
    response = await http.patch(
        "/api/sportsbooks/draftkings", json={"enabled": True, "md_licensed": True}
    )

    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["md_licensed"] is True


async def test_patching_an_unknown_book_is_a_404(api):
    http, _client, _prefix = api
    response = await http.patch("/api/sportsbooks/nosuchbook", json={"enabled": True})
    assert response.status_code == 404


async def test_an_empty_patch_is_refused(api):
    http, _client, _prefix = api
    assert (await http.patch("/api/sportsbooks/draftkings", json={})).status_code == 400


# ---- opportunities (§10) ---------------------------------------------------


async def test_opportunities_filter_by_status_and_type(api):
    http, client, prefix = api
    await seed_recommendation(client, prefix)

    assert len((await http.get("/api/opportunities")).json()) == 1
    assert len((await http.get("/api/opportunities?status=alerted")).json()) == 1
    assert len((await http.get("/api/opportunities?status=closed")).json()) == 0
    assert len((await http.get("/api/opportunities?type=arb")).json()) == 0


async def test_an_invalid_status_is_a_422_not_an_empty_table(api):
    http, _client, _prefix = api
    assert (await http.get("/api/opportunities?status=banana")).status_code == 422


# ---- recommendations and confirmation (§10, §9.3) --------------------------


async def test_recommendations_join_their_opportunity(api):
    http, client, prefix = api
    await seed_recommendation(client, prefix)

    rows = (await http.get("/api/recommendations")).json()
    assert len(rows) == 1
    assert rows[0]["opportunity"]["market_key"] == "h2h"
    assert rows[0]["result"] is None  # not graded yet


async def test_recommendations_filter_on_paper(api):
    http, client, prefix = api
    await seed_recommendation(client, prefix, paper=True)

    assert len((await http.get("/api/recommendations?paper=true")).json()) == 1
    assert len((await http.get("/api/recommendations?paper=false")).json()) == 0


async def test_confirming_records_a_human_placed_bet(api):
    """§9.3's ✅ path, from the UI. It records a bet; it never places one (§16.1)."""
    http, client, prefix = api
    from edgeline.indices import BETS_INDEX, with_prefix

    await seed_recommendation(client, prefix)
    response = await http.post(
        f"/api/recommendations/{REC_ID}/confirm",
        json={"stake_actual_cents": 1100, "odds_actual_decimal": 2.05},
    )

    assert response.status_code == 201
    assert response.json()["confirmed_via"] == "ui"
    # The actual odds differ from the recommended 2.10, which is exactly why
    # §10 asks for them rather than copying what we suggested.
    assert response.json()["odds_actual_decimal"] == 2.05

    await client.indices.refresh(index=with_prefix(BETS_INDEX, prefix))
    stored = await client.count(index=with_prefix(BETS_INDEX, prefix))
    assert stored["count"] == 1


async def test_confirming_something_that_does_not_exist_is_a_404(api):
    http, _client, _prefix = api
    response = await http.post(
        "/api/recommendations/nope/confirm",
        json={"stake_actual_cents": 100, "odds_actual_decimal": 2.0},
    )
    assert response.status_code == 404


async def test_confirm_rejects_impossible_odds(api):
    http, client, prefix = api
    await seed_recommendation(client, prefix)
    response = await http.post(
        f"/api/recommendations/{REC_ID}/confirm",
        json={"stake_actual_cents": 100, "odds_actual_decimal": 0.5},
    )
    assert response.status_code == 422


# ---- results summary (§10, §12) --------------------------------------------


async def test_summary_aggregates_pnl_hit_rate_and_clv(api):
    http, client, prefix = api
    from edgeline.indices import RESULTS_INDEX, with_prefix

    for doc_id, outcome, pnl, clv, bet in [
        ("r1", "win", 1210, 6.0, "bet-1"),
        ("r2", "loss", -1100, -2.0, ""),
        ("r3", "void", 0, None, ""),
    ]:
        await client.index(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=doc_id,
            document={
                "bet_id": bet,
                "outcome": outcome,
                "pnl_cents": pnl,
                "clv_pct": clv,
                "needs_manual": outcome == "void",
                "graded_at": utc_now_iso(),
            },
            refresh="wait_for",
        )

    body = (await http.get("/api/results/summary?group=day")).json()
    totals = body["totals"]

    assert totals["graded"] == 3
    assert totals["pnl_cents"] == 110
    assert totals["settled"] == 2  # the void does not count as settled
    assert totals["hit_rate"] == pytest.approx(0.5)
    assert totals["avg_clv_pct"] == pytest.approx(2.0)  # nulls excluded, not zeroed

    bucket = body["buckets"][0]
    assert bucket["executed"] == 1
    assert bucket["paper"] == 2
    assert bucket["needs_manual"] == 1


async def test_hit_rate_is_null_rather_than_zero_with_nothing_settled(api):
    """"No data yet" and "you lose every bet" are very different claims."""
    http, _client, _prefix = api
    totals = (await http.get("/api/results/summary")).json()["totals"]
    assert totals["graded"] == 0
    assert totals["hit_rate"] is None


# ---- bankroll (§10, §4.4 rule 3) -------------------------------------------


async def test_bankroll_balance_is_a_sum_of_deltas(api):
    http, _client, _prefix = api

    await http.post("/api/bankroll/adjust",
                    json={"book_key": "dk", "delta_cents": 100_000, "reason": "deposit"})
    await http.post("/api/bankroll/adjust",
                    json={"book_key": "dk", "delta_cents": -25_000, "reason": "withdrawal"})
    await http.post("/api/bankroll/adjust",
                    json={"book_key": "fd", "delta_cents": 50_000, "reason": "deposit"})

    body = (await http.get("/api/bankroll")).json()
    assert body["total_cents"] == 125_000
    by_book = {row["book_key"]: row["balance_cents"] for row in body["by_book"]}
    assert by_book == {"dk": 75_000, "fd": 50_000}
    assert len(body["entries"]) == 3


async def test_the_ledger_refuses_a_reason_only_grading_may_write(api):
    """`bet_won`/`bet_lost` carry provenance: they mean §12 settled a real bet."""
    http, _client, _prefix = api
    response = await http.post(
        "/api/bankroll/adjust",
        json={"book_key": "dk", "delta_cents": 100, "reason": "bet_won"},
    )
    assert response.status_code == 422


# ---- quarantine queue (§10, §7.3) ------------------------------------------


async def test_matching_queue_lists_then_resolves(api):
    http, client, prefix = api
    from edgeline.indices import UNMATCHED_INDEX, with_prefix

    created = await client.index(
        index=with_prefix(UNMATCHED_INDEX, prefix),
        document={
            "provider_key": "the_odds_api",
            "raw": {"anything": 1},
            "reason": "unknown_market_key",
            "resolved": False,
            "created_at": utc_now_iso(),
        },
        refresh="wait_for",
    )

    assert len((await http.get("/api/matching")).json()) == 1

    response = await http.post(f"/api/matching/{created['_id']}/resolve")
    assert response.status_code == 200
    assert response.json()["resolved"] is True

    assert len((await http.get("/api/matching")).json()) == 0
    assert len((await http.get("/api/matching?resolved=true")).json()) == 1


# ---- system (§10, §13) -----------------------------------------------------


async def test_health_reports_the_flags_that_matter(api):
    http, _client, _prefix = api
    body = (await http.get("/api/system/health")).json()

    assert body["paper_mode"] is True
    assert body["kill_switch"] is False
    assert body["sports_enabled"] == ["baseball_mlb"]


async def test_kill_and_resume_flip_the_switch(api):
    http, _client, _prefix = api

    assert (await http.post("/api/system/kill")).json()["kill_switch"] is True
    assert (await http.get("/api/system/health")).json()["kill_switch"] is True

    assert (await http.post("/api/system/resume")).json()["kill_switch"] is False
    assert (await http.get("/api/system/health")).json()["kill_switch"] is False


async def test_health_surfaces_the_workers_heartbeat(api):
    """§13 stamps this every 60s; a stale value means polling has stopped even
    though the API is still answering."""
    http, client, prefix = api
    from edgeline.indices import SETTINGS_INDEX, with_prefix

    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={"last_heartbeat_at": "2026-09-08T12:00:00Z"},
        refresh="wait_for",
    )
    body = (await http.get("/api/system/health")).json()
    assert body["runtime"]["last_heartbeat_at"] == "2026-09-08T12:00:00Z"

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


async def seed_recommendation(client, prefix, *, paper=True, with_event=True):
    from edgeline.indices import (
        EVENTS_INDEX,
        OPPORTUNITIES_INDEX,
        RECOMMENDATIONS_INDEX,
        with_prefix,
    )

    if with_event:
        await client.index(
            index=with_prefix(EVENTS_INDEX, prefix),
            id=EVENT_ID,
            document={
                "sport_key": "baseball_mlb",
                "commence_time": "2026-09-11T23:10:00Z",
                "home_team": "Cleveland Guardians",
                "away_team": "Kansas City Royals",
                "completed": False,
            },
            refresh="wait_for",
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


async def test_opportunities_carry_the_matchup_not_just_the_event_id(api):
    """`event_id` is a primary key, not information. §4.3 makes it the events
    index `_id`, so the row joins the fixture in and the UI can name the game."""
    http, client, prefix = api
    await seed_recommendation(client, prefix)

    row = (await http.get("/api/opportunities")).json()[0]
    assert row["event"]["home_team"] == "Cleveland Guardians"
    assert row["event"]["away_team"] == "Kansas City Royals"
    assert row["event"]["commence_time"] == "2026-09-11T23:10:00Z"
    # The id lives on the opportunity; repeating it inside the nested object
    # would put the same string on the row twice under two names.
    assert "id" not in row["event"]


async def test_an_opportunity_whose_event_is_gone_still_renders(api):
    """A reaped fixture thins one row; it does not 500 the table."""
    http, client, prefix = api
    await seed_recommendation(client, prefix, with_event=False)

    row = (await http.get("/api/opportunities")).json()[0]
    assert row["event"] is None
    assert row["event_id"] == EVENT_ID


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
    # The embedded opportunity gets the same event join, so a recommendations
    # table can name the game without a request per row.
    assert rows[0]["opportunity"]["event"]["away_team"] == "Kansas City Royals"
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
    assert totals["clv_from_closing"] == 0
    assert totals["avg_clv_pct_closing"] is None


async def test_the_clv_average_travels_with_where_it_came_from(api):
    """§12.4. A CLV measured against a price twelve hours before kickoff is not
    the same evidence as one measured against a bought closing line, and the
    go-live gate rests on telling them apart. The mixed average is still
    reported — it is simply no longer the only number available."""
    http, client, prefix = api
    from edgeline.indices import RESULTS_INDEX, with_prefix

    # One strong figure and two weak ones, deliberately far apart so a reader
    # cannot mistake the mixed mean for either.
    for doc_id, clv, source in (
        ("r-closing", 2.0, "closing"),
        ("r-derived-1", 20.0, "derived"),
        ("r-derived-2", 20.0, "derived"),
    ):
        await client.index(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=doc_id,
            document={
                "bet_id": "",
                "outcome": "win",
                "pnl_cents": 100,
                "clv_pct": clv,
                "clv_source": source,
                "clv_staleness_s": None if source == "closing" else 43_200,
                "needs_manual": False,
                "graded_at": utc_now_iso(),
            },
            refresh="wait_for",
        )

    totals = (await http.get("/api/results/summary")).json()["totals"]

    assert totals["clv_from_closing"] == 1
    assert totals["clv_from_derived"] == 2
    assert totals["avg_clv_pct"] == pytest.approx(14.0)  # the mix
    assert totals["avg_clv_pct_closing"] == pytest.approx(2.0)  # the evidence

    bucket = (await http.get("/api/results/summary")).json()["buckets"][0]
    assert bucket["clv_from_closing"] == 1
    assert bucket["clv_from_derived"] == 2


async def test_an_excluded_result_is_left_out_of_every_figure_and_counted(api):
    """The shape of 2026-09-23: five dead-line bets detected after first pitch were
    most of this page, −$39.03 and a 33% hit rate over a real record of one win.
    Marked rows drop out of every figure — and `excluded` says so, because a page
    that quietly shows fewer rows is the same failure as one that mixes them in."""
    http, client, prefix = api
    from edgeline.indices import RESULTS_INDEX, with_prefix

    for doc_id, outcome, pnl, reason in (
        ("r-dead-line", "loss", -2000, "detected_after_start"),
        ("r-real", "win", 652, None),
    ):
        document = {
            "bet_id": "",
            "outcome": outcome,
            "pnl_cents": pnl,
            "clv_pct": 2.7 if reason is None else None,
            "needs_manual": False,
            "graded_at": utc_now_iso(),
        }
        if reason:
            document["excluded_reason"] = reason
        await client.index(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=doc_id,
            document=document,
            refresh="wait_for",
        )

    body = (await http.get("/api/results/summary")).json()
    totals = body["totals"]
    assert totals["graded"] == 1
    assert totals["pnl_cents"] == 652
    assert totals["hit_rate"] == pytest.approx(1.0)
    assert totals["excluded"] == 1
    assert body["buckets"][0]["graded"] == 1


async def test_the_audit_excludes_a_bet_detected_after_first_pitch_and_nothing_else(api):
    """`audit.py` decides from the data, not from a list of ids: a result counts
    only if the opportunity behind it was detected before its game started — the
    rule `detect_opportunities` has enforced since 2026-09-11. A result whose trail
    cannot be followed stays counted; excluding evidence needs a reason that can be
    shown, not the absence of one."""
    _http, client, prefix = api
    from edgeline.audit import (
        DETECTED_AFTER_START,
        exclude_results_detected_after_start,
    )
    from edgeline.indices import (
        EVENTS_INDEX,
        OPPORTUNITIES_INDEX,
        RECOMMENDATIONS_INDEX,
        RESULTS_INDEX,
        with_prefix,
    )

    first_pitch = "2026-09-09T23:05:00Z"
    await client.index(
        index=with_prefix(EVENTS_INDEX, prefix),
        id=EVENT_ID,
        document={
            "sport_key": "baseball_mlb",
            "commence_time": first_pitch,
            "home_team": "Miami Marlins",
            "away_team": "Atlanta Braves",
            "completed": True,
        },
        refresh="wait_for",
    )

    async def settled_bet(rec_id: str, opp_id: str | None, detected_at: str) -> None:
        if opp_id:
            await client.index(
                index=with_prefix(OPPORTUNITIES_INDEX, prefix),
                id=opp_id,
                document={
                    "type": "ev",
                    "event_id": EVENT_ID,
                    "market_key": "h2h",
                    "legs": [],
                    "edge_pct": 3.0,
                    "status": "expired",
                    "detected_at": detected_at,
                    "expires_at": first_pitch,
                },
                refresh="wait_for",
            )
        await client.index(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
            id=rec_id,
            document={
                "opportunity_id": opp_id or "gone",
                "stakes": {"total_cents": 400, "legs": [], "method": "kelly",
                           "guardrails_applied": []},
                "paper": True,
                "channel": "log",
                "sent_at": detected_at,
            },
            refresh="wait_for",
        )
        await client.index(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=rec_id,  # §12 step 2: a result's id is its recommendation's
            document={
                "bet_id": "",
                "outcome": "win",
                "pnl_cents": 100,
                "clv_pct": None,
                "needs_manual": False,
                "graded_at": utc_now_iso(),
            },
            refresh="wait_for",
        )

    # 3h40m after first pitch — the betPARX-on-the-Marlins shape.
    await settled_bet("rec-dead", "c" * 64, "2026-09-10T02:45:00Z")
    # Four hours before it — a real pre-game detection.
    await settled_bet("rec-real", "d" * 64, "2026-09-09T19:05:00Z")
    # A trail that cannot be followed: the opportunity is missing.
    await settled_bet("rec-orphan", None, "2026-09-10T02:45:00Z")

    marked = await exclude_results_detected_after_start(client, prefix=prefix)
    assert marked == ["rec-dead"]

    results = with_prefix(RESULTS_INDEX, prefix)
    dead = await client.get(index=results, id="rec-dead")
    assert dead["_source"]["excluded_reason"] == DETECTED_AFTER_START
    for kept in ("rec-real", "rec-orphan"):
        assert "excluded_reason" not in (await client.get(index=results, id=kept))["_source"]

    # Idempotent: a second run finds nothing left to mark.
    assert await exclude_results_detected_after_start(client, prefix=prefix) == []


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


# ---- the manual poll (§10, §8.4's "manual trigger") ------------------------


class _EmptyProvider:
    """The adapter answering "no games", which is all this route's own work needs.

    A payload with events in it is `test_engine`'s job; what is under test here is
    the route: arming the guard, stamping `last_poll_at`, recording the quota, and
    refusing a second press.
    """

    key = "the_odds_api"

    def __init__(self, *, raises: Exception | None = None):
        from edgeline.providers.base import QuotaStatus

        self.calls: list[str] = []
        self.quota = QuotaStatus(used=3, remaining=497)
        self.monthly_budget: int | None = None
        self.armed = False
        self._raises = raises

    async def arm_budget_guard(self):
        self.armed = True
        return self.quota

    async def fetch_odds(self, sport_key, markets, *, regions="us"):
        from edgeline.providers.base import ProviderResponse

        if self._raises is not None:
            raise self._raises
        self.calls.append(sport_key)
        return ProviderResponse(
            provider_key=self.key,
            endpoint="odds",
            payload=[],
            quota=self.quota,
            fetched_at=utc_now_iso(),
            sport_key=sport_key,
        )

    async def aclose(self):
        return None


def _poll_client(client, prefix, provider):
    """The app with both seams overridden: this file's indices, a fake provider."""
    from edgeline.api.deps import Context, get_context, get_provider
    from edgeline.api.main import create_app

    app = create_app()
    app.dependency_overrides[get_context] = lambda: Context(client=client, prefix=prefix)
    app.dependency_overrides[get_provider] = lambda: provider
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def _runtime(client, prefix) -> dict:
    from edgeline.indices import SETTINGS_INDEX, with_prefix

    found = await client.get(index=with_prefix(SETTINGS_INDEX, prefix), id="runtime")
    return found["_source"]


async def test_a_manual_poll_runs_a_cycle_and_stamps_it_like_any_other(api):
    """The stamp is the part that is easy to leave out and expensive to miss: a
    manual cycle *is* a poll, so `poll_is_due` has to see it or the next worker
    restart pays for another one on top of it."""
    _http, client, prefix = api
    provider = _EmptyProvider()

    async with _poll_client(client, prefix, provider) as http:
        response = await http.post("/api/system/poll")

    assert response.status_code == 200
    body = response.json()
    assert [row["sport_key"] for row in body["cycles"]] == ["baseball_mlb"]
    assert body["offline"] is False
    assert body["quota_used"] == 3
    assert provider.calls == ["baseball_mlb"]
    # The free `/sports` call the worker makes at startup, for the same reason:
    # the pace guard needs a starting number before anything is spent.
    assert provider.armed is True
    assert provider.monthly_budget == DEFAULT_SETTINGS["quota_monthly_budget"]

    runtime = await _runtime(client, prefix)
    assert runtime["last_poll_at"], "a manual poll must stamp last_poll_at"


async def test_a_manual_poll_records_the_credits_it_spent(api):
    """Same reasoning as the worker's own `record_quota`: a meter stuck at zero
    reads as headroom on a budget where the whole allowance is 500."""
    _http, client, prefix = api

    async with _poll_client(client, prefix, _EmptyProvider()) as http:
        await http.post("/api/system/poll")

    from edgeline.indices import PROVIDERS_INDEX, with_prefix

    found = await client.get(
        index=with_prefix(PROVIDERS_INDEX, prefix), id="the_odds_api"
    )
    assert found["_source"]["quota_used"] == 3


async def test_a_manual_poll_makes_no_provider_request_while_offline(api):
    """§3.2: `offline_mode` stops every provider request, and a button is not an
    exception to it. It also must not stamp `last_poll_at` — a fresh stamp over
    stale data is what `test_an_offline_cycle_does_not_stamp_last_poll_at` was
    written about."""
    _http, client, prefix = api
    from edgeline.indices import SETTINGS_INDEX, with_prefix

    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="global",
        doc={"offline_mode": True},
        refresh="wait_for",
    )
    before = (await _runtime(client, prefix)).get("last_poll_at")
    provider = _EmptyProvider()

    async with _poll_client(client, prefix, provider) as http:
        body = (await http.post("/api/system/poll")).json()

    assert body["offline"] is True
    assert provider.calls == []
    assert provider.armed is False
    assert (await _runtime(client, prefix)).get("last_poll_at") == before


async def test_a_manual_poll_surfaces_the_pace_guards_refusal_rather_than_a_500(api):
    """The guard refuses locally and nothing is sent (§8.4). That is a sentence
    worth putting in front of the person who pressed the button, since the remedy
    — and whether there is one — is in the message."""
    _http, client, prefix = api
    from edgeline.providers.base import ProviderBudgetExceeded

    refusal = ProviderBudgetExceeded("refusing /odds: 480 of 500 monthly credits spent")
    before = (await _runtime(client, prefix)).get("last_poll_at")

    async with _poll_client(client, prefix, _EmptyProvider(raises=refusal)) as http:
        response = await http.post("/api/system/poll")

    assert response.status_code == 409
    assert "480 of 500" in response.json()["detail"]
    # Nothing was fetched, so nothing may claim a poll happened.
    assert (await _runtime(client, prefix)).get("last_poll_at") == before


async def test_a_second_manual_poll_while_one_is_running_is_refused(api):
    """§8.4's budget pays for the cadence, not for how often a button is pressed,
    and two presses would buy the same market twice."""
    _http, client, prefix = api
    from edgeline.api.routers.system import _poll_in_flight

    async with _poll_in_flight:  # stands in for a cycle still fetching
        async with _poll_client(client, prefix, _EmptyProvider()) as http:
            response = await http.post("/api/system/poll")

    assert response.status_code == 409
    assert "already running" in response.json()["detail"]

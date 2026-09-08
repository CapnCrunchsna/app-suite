"""Grading and CLV — spec §12.

The settlement tests use a real recorded result (Cincinnati Reds 7, San Diego
Padres 3, from the 2026-09-04 scores fixture) so the expected outcomes are
checkable against something that actually happened rather than a made-up score.

What these tests protect is not P&L arithmetic — it is the CLV record. A bet
settled wrongly, or graded twice, corrupts the only evidence the go-live decision
(§15 Phase 4) will rest on.
"""

from __future__ import annotations

import pytest

from edgeline.config import Settings
from edgeline.grading import (
    LOSS,
    PUSH,
    VOID,
    WIN,
    combine_outcomes,
    leg_pnl_cents,
    scores_from_event,
    settle_h2h,
    settle_leg,
    settle_spread,
    settle_totals,
)
from edgeline.oddsmath import american_to_decimal

REDS = "Cincinnati Reds"
PADRES = "San Diego Padres"
FINAL = {REDS: 7, PADRES: 3}  # total 10, margin 4


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


# ---- score parsing ---------------------------------------------------------


def test_scores_arrive_as_strings_and_come_back_as_ints():
    event = {"scores": [{"name": REDS, "score": "7"}, {"name": PADRES, "score": "3"}]}
    assert scores_from_event(event) == FINAL


def test_an_unfinished_event_has_no_scores():
    assert scores_from_event({"scores": None}) == {}
    assert scores_from_event({}) == {}


def test_an_unparseable_score_is_dropped_rather_than_guessed():
    event = {"scores": [{"name": REDS, "score": "?"}, {"name": PADRES, "score": "3"}]}
    assert scores_from_event(event) == {PADRES: 3}


def test_recorded_fixture_parses(mlb_scores_payload):
    completed = [row for row in mlb_scores_payload if row["completed"]]
    assert completed
    for row in completed:
        scores = scores_from_event(row)
        assert len(scores) == 2
        assert all(isinstance(value, int) for value in scores.values())


# ---- h2h (§12 step 2) ------------------------------------------------------


def test_h2h_settles_on_the_winner():
    assert settle_h2h(REDS, FINAL) == WIN
    assert settle_h2h(PADRES, FINAL) == LOSS


def test_h2h_ties_push_rather_than_lose():
    """A called game can end level; treating that as a loss invents a result."""
    assert settle_h2h(REDS, {REDS: 4, PADRES: 4}) == PUSH


def test_h2h_on_a_team_that_did_not_play_is_void():
    assert settle_h2h("Baltimore Orioles", FINAL) == VOID


# ---- totals (§12 step 2) ---------------------------------------------------


@pytest.mark.parametrize(
    ("selection", "line", "expected"),
    [
        ("Over 8.5", 8.5, WIN),  # total 10
        ("Under 8.5", 8.5, LOSS),
        ("Over 10.5", 10.5, LOSS),
        ("Under 10.5", 10.5, WIN),
        ("Over 10.0", 10.0, PUSH),  # exact -> push
        ("Under 10.0", 10.0, PUSH),
    ],
)
def test_totals_settle_against_the_combined_score(selection, line, expected):
    assert settle_totals(selection, line, FINAL) == expected


def test_totals_without_a_line_are_void():
    assert settle_totals("Over 8.5", None, FINAL) == VOID


def test_an_unrecognised_total_side_is_void_not_guessed():
    assert settle_totals("Sideways 8.5", 8.5, FINAL) == VOID


# ---- spreads (§12 step 2) --------------------------------------------------


@pytest.mark.parametrize(
    ("selection", "line", "expected"),
    [
        (f"{REDS} -1.5", -1.5, WIN),  # 7 - 1.5 = 5.5 > 3
        (f"{REDS} -4.5", -4.5, LOSS),  # 7 - 4.5 = 2.5 < 3
        (f"{REDS} -4.0", -4.0, PUSH),  # 7 - 4 = 3 == 3
        (f"{PADRES} +1.5", 1.5, LOSS),  # 3 + 1.5 = 4.5 < 7
        (f"{PADRES} +4.5", 4.5, WIN),  # 3 + 4.5 = 7.5 > 7
        (f"{PADRES} +4.0", 4.0, PUSH),  # 3 + 4 = 7 == 7
    ],
)
def test_spreads_settle_on_the_adjusted_margin(selection, line, expected):
    assert settle_spread(selection, line, FINAL) == expected


def test_a_spread_on_an_absent_team_is_void():
    assert settle_spread("Baltimore Orioles -1.5", -1.5, FINAL) == VOID


# ---- dispatch and the void rule --------------------------------------------


def test_settle_leg_dispatches_by_market():
    assert settle_leg("h2h", REDS, None, FINAL) == WIN
    assert settle_leg("totals", "Over 8.5", 8.5, FINAL) == WIN
    assert settle_leg("spreads", f"{REDS} -1.5", -1.5, FINAL) == WIN


@pytest.mark.parametrize("market", ["batter_home_runs", "pitcher_strikeouts", "invented"])
def test_props_and_unknown_markets_are_void_for_manual_review(market):
    """§12: props are largely ungradable from the scores API. A void the UI flags
    beats a guess that quietly poisons the CLV record."""
    assert settle_leg(market, "Logan Allen Over 3.5", 3.5, FINAL) == VOID


# ---- P&L (§12 step 3) ------------------------------------------------------


def test_a_win_pays_the_profit_only():
    # $49 at 2.10 returns $102.90, so the profit is $53.90.
    assert leg_pnl_cents(WIN, 4900, 2.10) == 5390


def test_a_loss_forfeits_the_stake():
    assert leg_pnl_cents(LOSS, 4900, 2.10) == -4900


@pytest.mark.parametrize("outcome", [PUSH, VOID])
def test_a_push_or_void_moves_nothing(outcome):
    assert leg_pnl_cents(outcome, 4900, 2.10) == 0


def test_win_pnl_rounds_to_whole_cents():
    """Money is integer cents everywhere (§1); a fractional cent cannot be stored."""
    pnl = leg_pnl_cents(WIN, 1100, american_to_decimal(-110))
    assert isinstance(pnl, int)
    assert pnl == 1000  # $11 at 1.909091 wins $10.00


def test_an_arb_sums_to_a_small_profit_across_its_legs():
    """G5's split: $49 at 2.10 and $51 at 1.980392, one of which always wins."""
    reds_win = leg_pnl_cents(WIN, 4900, 2.10) + leg_pnl_cents(LOSS, 5100, 1.980392)
    padres_win = leg_pnl_cents(LOSS, 4900, 2.10) + leg_pnl_cents(
        WIN, 5100, american_to_decimal(-102)
    )
    assert reds_win == 290  # $102.90 back on a $100 outlay
    assert padres_win == 100  # $101.00 back on a $100 outlay
    assert min(reds_win, padres_win) > 0  # which is what made it an arb


# ---- combining legs --------------------------------------------------------


def test_an_arbs_combined_outcome_reports_the_winning_side():
    assert combine_outcomes([WIN, LOSS]) == WIN


def test_any_unsettled_leg_voids_the_whole_recommendation():
    """Half-graded is worse than ungraded: the P&L would be wrong and look right."""
    assert combine_outcomes([WIN, VOID]) == VOID


def test_all_pushes_push():
    assert combine_outcomes([PUSH, PUSH]) == PUSH


def test_all_losses_lose():
    assert combine_outcomes([LOSS, LOSS]) == LOSS
    assert combine_outcomes([LOSS]) == LOSS


def test_no_legs_is_void():
    assert combine_outcomes([]) == VOID


# ---- the job against a real cluster (§12) ----------------------------------

EVENT_ID = "baseball_mlb:evtG"
OPP_HASH = "a" * 64
REC_ID = "rec-under-test"


class _ScoresProvider:
    key = "the_odds_api"

    def __init__(self, payload):
        self.payload = payload

    async def fetch_scores(self, sport_key, *, days_from=2):
        from edgeline.providers.base import ProviderResponse, QuotaStatus
        from edgeline.schemas import utc_now_iso

        return ProviderResponse(
            provider_key=self.key,
            endpoint="scores",
            payload=self.payload,
            quota=QuotaStatus(used=1, remaining=499),
            fetched_at=utc_now_iso(),
            sport_key=sport_key,
        )


def completed_scores_payload():
    return [
        {
            "id": "evtG",
            "sport_key": "baseball_mlb",
            "commence_time": "2026-09-02T16:41:00Z",
            "completed": True,
            "home_team": REDS,
            "away_team": PADRES,
            "scores": [{"name": REDS, "score": "7"}, {"name": PADRES, "score": "3"}],
        }
    ]


async def _seed(client, prefix, *, paper=True, with_closing=True):
    """One alerted h2h recommendation on a finished event, ready to grade."""
    from edgeline.es import ensure_indices
    from edgeline.indices import (
        EVENTS_INDEX,
        ODDS_SNAPSHOTS_INDEX,
        OPPORTUNITIES_INDEX,
        RECOMMENDATIONS_INDEX,
        all_index_names,
        with_prefix,
    )

    # Wipe documents rather than delete indices — see test_engine._fresh_cluster
    # for why the create/delete storm had to go.
    await ensure_indices(client, prefix=prefix)
    await client.indices.put_settings(
        index=f"{prefix}*", settings={"refresh_interval": "50ms"}
    )
    await client.delete_by_query(
        index=f"{prefix}*", query={"match_all": {}}, refresh=True, conflicts="proceed"
    )
    await ensure_indices(client, prefix=prefix)

    await client.index(
        index=with_prefix(EVENTS_INDEX, prefix),
        id=EVENT_ID,
        document={
            "sport_key": "baseball_mlb",
            "commence_time": "2026-09-02T16:41:00Z",
            "home_team": REDS,
            "away_team": PADRES,
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
                    "selection": REDS,
                    "line": None,
                    "price_decimal": 2.10,
                    "devig_prob": 0.46,
                    "bet_first": False,
                }
            ],
            "edge_pct": 5.0,
            "status": "alerted",
            "detected_at": "2026-09-02T15:00:00Z",
            "expires_at": "2026-09-02T16:41:00Z",
        },
        refresh="wait_for",
    )
    await client.index(
        index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
        id=REC_ID,
        document={
            "opportunity_id": OPP_HASH,
            "stakes": {
                "total_cents": 1100,
                "legs": [
                    {
                        "book_key": "dk",
                        "selection": REDS,
                        "stake_cents": 1100,
                        "to_win_cents": 1210,
                        "deep_link": "",
                        "link_level": "none",
                    }
                ],
                "method": "kelly",
                "guardrails_applied": [],
            },
            "paper": paper,
            "channel": "log",
            "sent_at": "2026-09-02T15:00:00Z",
        },
        refresh="wait_for",
    )

    if with_closing:
        # Five books at 1.90/2.00 -> de-vigged Reds 0.512821 at the close.
        for book in ["dk", "fd", "mgm", "czr", "brv"]:
            for selection, price in ((REDS, 1.90), (PADRES, 2.00)):
                await client.index(
                    index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix),
                    document={
                        "event_id": EVENT_ID,
                        "book_key": book,
                        "market_key": "h2h",
                        "selection": selection,
                        "line": None,
                        "price_decimal": price,
                        "is_closing": True,
                        "@timestamp": "2026-09-02T16:36:00Z",
                    },
                    refresh="wait_for",
                )


@pytest.mark.es
async def test_grading_settles_a_recommendation_and_computes_clv(es_url, test_index_prefix):
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import RESULTS_INDEX, all_index_names, with_prefix

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix)
        report = await grade(
            _ScoresProvider(completed_scores_payload()),
            client,
            sport_key="baseball_mlb",
            settings=settings(),
            prefix=prefix,
        )

        assert report.graded == [REC_ID]
        result = await client.get(index=with_prefix(RESULTS_INDEX, prefix), id=REC_ID)
        source = result["_source"]

        assert source["outcome"] == WIN  # Reds won 7-3
        assert source["pnl_cents"] == 1210  # $11 at 2.10 wins $12.10
        assert source["needs_manual"] is False
        # Closing consensus 0.512821 against the alerted price of 2.10:
        # (0.512821 x 2.10 - 1) x 100 = 7.6923%
        assert source["clv_pct"] == pytest.approx(7.6923, abs=1e-3)
    finally:
        await client.close()


@pytest.mark.es
async def test_clv_is_null_when_no_closing_line_was_captured(es_url, test_index_prefix):
    """Honest absence beats a fabricated number: without an `is_closing` snapshot
    there is nothing to compare the alert price against."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import RESULTS_INDEX, all_index_names, with_prefix

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix, with_closing=False)
        await grade(
            _ScoresProvider(completed_scores_payload()),
            client,
            sport_key="baseball_mlb",
            settings=settings(),
            prefix=prefix,
        )
        result = await client.get(index=with_prefix(RESULTS_INDEX, prefix), id=REC_ID)
        assert result["_source"]["clv_pct"] is None
        assert result["_source"]["outcome"] == WIN  # settlement is unaffected
    finally:
        await client.close()


@pytest.mark.es
async def test_re_running_grading_changes_nothing(es_url, test_index_prefix):
    """§12 step 2's idempotency, and the reason it matters: step 5 writes to the
    bankroll ledger, where "ran twice" becomes money that never existed."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import (
        BANKROLL_LEDGER_INDEX,
        BETS_INDEX,
        RESULTS_INDEX,
        all_index_names,
        with_prefix,
    )

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix, paper=False)
        # Confirmed by a human, so this one is executed and touches the ledger.
        await client.index(
            index=with_prefix(BETS_INDEX, prefix),
            document={
                "recommendation_id": REC_ID,
                "confirmed_via": "button",
                "stake_actual_cents": 1100,
                "odds_actual_decimal": 2.10,
                "placed_at": "2026-09-02T15:05:00Z",
            },
            refresh="wait_for",
        )

        provider = _ScoresProvider(completed_scores_payload())
        first = await grade(
            provider, client, sport_key="baseball_mlb", settings=settings(), prefix=prefix
        )
        assert first.graded == [REC_ID]
        assert first.ledger_entries == 1

        second = await grade(
            provider, client, sport_key="baseball_mlb", settings=settings(), prefix=prefix
        )
        assert second.graded == []  # already settled, so not re-graded
        assert second.ledger_entries == 0

        await client.indices.refresh(index=f"{prefix}*")
        results = await client.count(index=with_prefix(RESULTS_INDEX, prefix))
        ledger = await client.count(index=with_prefix(BANKROLL_LEDGER_INDEX, prefix))
        assert results["count"] == 1
        assert ledger["count"] == 1
    finally:
        await client.close()


@pytest.mark.es
async def test_a_paper_recommendation_never_touches_the_bankroll(es_url, test_index_prefix):
    """§12 step 5 — paper P&L is recorded as a result, but the ledger is real money."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import BANKROLL_LEDGER_INDEX, all_index_names, with_prefix

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix, paper=True)  # and no bets document
        report = await grade(
            _ScoresProvider(completed_scores_payload()),
            client,
            sport_key="baseball_mlb",
            settings=settings(),
            prefix=prefix,
        )
        assert report.graded == [REC_ID]
        assert report.ledger_entries == 0

        await client.indices.refresh(index=f"{prefix}*")
        ledger = await client.count(index=with_prefix(BANKROLL_LEDGER_INDEX, prefix))
        assert ledger["count"] == 0
    finally:
        await client.close()


@pytest.mark.es
async def test_the_daily_loss_stop_trips_the_kill_switch(es_url, test_index_prefix):
    """§12 step 6. Tightening a guardrail in response to real losses is the one
    setting this system writes for itself (§16.2 forbids loosening, not this)."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import RESULTS_INDEX, SETTINGS_INDEX, all_index_names, with_prefix
    from edgeline.notify import RecordingSink
    from edgeline.schemas import utc_now_iso

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix, paper=False, with_closing=False)
        # A day's worth of executed losses already on the board.
        await client.index(
            index=with_prefix(RESULTS_INDEX, prefix),
            id="earlier-loss",
            document={
                "bet_id": "bet-1",
                "outcome": LOSS,
                "pnl_cents": -60_000,  # over the $500 default stop
                "clv_pct": None,
                "needs_manual": False,
                "graded_at": utc_now_iso(),
            },
            refresh="wait_for",
        )

        sink = RecordingSink()
        report = await grade(
            _ScoresProvider(completed_scores_payload()),
            client,
            sport_key="baseball_mlb",
            settings=settings(),
            prefix=prefix,
            sink=sink,
        )

        assert report.daily_loss_cents >= 60_000
        assert report.kill_switch_tripped

        stored = await client.get(index=with_prefix(SETTINGS_INDEX, prefix), id="global")
        assert stored["_source"]["kill_switch"] is True

        assert len(sink.sent) == 1
        assert "Daily loss stop" in sink.sent[0][1].title
    finally:
        await client.close()


@pytest.mark.es
async def test_losses_below_the_stop_leave_the_kill_switch_alone(es_url, test_index_prefix):
    from elasticsearch import AsyncElasticsearch

    from edgeline.grading import grade
    from edgeline.indices import SETTINGS_INDEX, all_index_names, with_prefix
    from edgeline.notify import RecordingSink

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await _seed(client, prefix, paper=True)
        sink = RecordingSink()
        report = await grade(
            _ScoresProvider(completed_scores_payload()),
            client,
            sport_key="baseball_mlb",
            settings=settings(),
            prefix=prefix,
            sink=sink,
        )

        assert report.daily_loss_cents == 0  # the graded bet won, and was paper
        assert not report.kill_switch_tripped
        assert sink.sent == []

        stored = await client.get(index=with_prefix(SETTINGS_INDEX, prefix), id="global")
        assert stored["_source"]["kill_switch"] is False
    finally:
        await client.close()

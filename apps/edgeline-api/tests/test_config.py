"""Configuration — spec §3.1, §3.2.

The §3.2 table is transcribed here independently of ``config.py``. That duplication
is the point: a typo in a default is invisible by inspection (nothing crashes if
``kelly_fraction`` is 0.025), so the test has to carry its own copy of the spec to
compare against rather than importing the value it is meant to be checking.
"""

from __future__ import annotations

import pytest

from edgeline.config import (
    DEFAULT_SETTINGS,
    MissingSecretError,
    Secrets,
    Settings,
    settings_from_document,
)

# Spec §3.2, key by key, value by value.
SPEC_DEFAULTS = {
    "paper_mode": True,
    "kill_switch": False,
    # Not in §3.2's original table — added 2026-09-10. The mirror of
    # `kill_switch`: that one keeps polling and stops alerting, this one keeps
    # everything and stops polling, so a spent monthly allowance no longer
    # blocks the work that never needed the provider.
    "offline_mode": False,
    "kelly_fraction": 0.25,
    "bankroll_start_cents": 100000,
    "ev_threshold_pct": 2.0,
    "min_edge_to_bet_pct": 1.5,
    "min_books_for_consensus": 4,
    "arb_min_profit_pct": 0.5,
    "max_stake_cents": 25000,
    "max_stake_pct": 2.0,
    "daily_exposure_cap_cents": 100000,
    "daily_loss_stop_cents": 50000,
    "stake_rounding_cents": 100,
    "devig_method": "multiplicative",
    "consensus_weights": {"default": 1},
    "staleness_sigma_floor": 0.002,
    "edge_improve_delta_pct": 0.5,
    "alert_cooldown_s": 300,
    "sports_enabled": ["baseball_mlb"],
    "markets_featured": ["h2h", "spreads", "totals"],
    "markets_props": ["batter_home_runs", "pitcher_strikeouts"],
    # Not in §3.2's original table — added 2026-09-09, see §8.4. `us` alone
    # returns only four MD-legal books, one short of what §6.4's consensus needs.
    "regions": ["us", "us2"],
    "poll_interval_s": 120,
    # 12 h, not §3.2's original 6 h: two regions double the per-poll cost, so the
    # halved rate keeps the dev cadence at the same 360 credits/month.
    "poll_interval_dev_s": 43200,
    # Not in §3.2's original table — added 2026-09-23. The free tier's cadence
    # as fixed Eastern-time polls, placed from data: each ~90 min before its
    # sport's first big window of starts. 14 a week, the interval's 360/month.
    "poll_schedule": [
        {"days": ["sun"], "time": "11:30", "sport": "americanfootball_nfl"},
        {"days": ["sun"], "time": "15:00", "sport": "americanfootball_nfl"},
        {"days": ["mon", "thu"], "time": "18:45", "sport": "americanfootball_nfl"},
        {"days": ["sat"], "time": "10:30", "sport": "americanfootball_ncaaf"},
        {"days": ["sat"], "time": "17:30", "sport": "americanfootball_ncaaf"},
        {"days": ["tue", "wed", "thu", "fri"], "time": "17:30", "sport": "icehockey_nhl"},
        {"days": ["mon", "tue", "wed", "fri"], "time": "17:30", "sport": "basketball_nba"},
    ],
    "props_poll_interval_s": 600,
    "closing_capture_offset_s": 300,
    # Not in §3.2's original table — added 2026-09-11. `off` derives CLV from
    # the last stored poll before kickoff and buys nothing; buying one for every
    # event measured at 1,188 credits/month against a budget of 500.
    "closing_capture_mode": "off",
    # Not in §3.2's original table — added 2026-09-12 with provider deep links.
    # Several books' own links carry a literal `{state}`, so this is what fills
    # it. A wrong value here does not error, it routes someone to another
    # state's sportsbook, which is why it is a setting and not a constant.
    "book_state": "md",
    "quota_monthly_budget": 500,
}


def test_default_settings_match_the_spec_exactly():
    assert DEFAULT_SETTINGS == SPEC_DEFAULTS


def test_no_setting_is_missing_or_extra():
    assert set(Settings.model_fields) == set(SPEC_DEFAULTS)


def test_defaults_round_trip_through_a_document():
    """What bootstrap seeds must validate back to what the engine started with."""
    assert settings_from_document(DEFAULT_SETTINGS) == Settings()
    assert settings_from_document(DEFAULT_SETTINGS).model_dump() == DEFAULT_SETTINGS


def test_unseeded_datastore_falls_back_to_defaults():
    """T0.2's real requirement: usable settings before T0.3 has ever run."""
    assert settings_from_document(None) == Settings()
    assert settings_from_document({}) == Settings()


class _Meta:
    """Just enough of `ApiResponseMeta` for `NotFoundError.__str__`."""

    status = 404


async def test_a_missing_settings_document_answers_defaults_through_the_datastore():
    """The fallback above, reached the way the engine reaches it."""
    from elasticsearch import NotFoundError

    from edgeline.engine import load_settings

    class _Missing:
        async def get(self, **_kwargs):
            raise NotFoundError("index_not_found_exception", _Meta(), None)

    assert await load_settings(_Missing(), prefix="edgeline-") == Settings()


async def test_a_settings_read_that_fails_is_not_an_unseeded_datastore():
    """§4.4 rule 1 writes the document once, so *absent* means a new install.
    `load_settings` used to answer defaults for **any** exception, which meant a
    ten-second timeout against a fully seeded cluster silently became a full set
    of §3.2 defaults — and those are not a safe guess at what the user
    configured. `kill_switch` and `offline_mode` both default to off, so a
    blocked read could resume a system someone had deliberately paused.

    Measured 2026-09-15: every sleep/resume on this laptop drops the connection
    to the containerised cluster for a tick, and each one logged "no seeded
    settings … using §3.2 defaults" against a datastore that was fully seeded.
    """
    from elastic_transport import ConnectionTimeout

    from edgeline.engine import load_settings

    class _Timeout:
        async def get(self, **_kwargs):
            raise ConnectionTimeout("Connection timed out")

    with pytest.raises(ConnectionTimeout):
        await load_settings(_Timeout(), prefix="edgeline-")


def test_stored_document_overrides_only_the_keys_it_carries():
    settings = settings_from_document({"kelly_fraction": 0.1, "kill_switch": True})
    assert settings.kelly_fraction == 0.1
    assert settings.kill_switch is True
    # Untouched keys keep the spec defaults rather than becoming None.
    assert settings.paper_mode is True
    assert settings.max_stake_cents == 25000


def test_unknown_keys_are_ignored_not_fatal():
    """`dynamic: false` storage means an older build can meet a newer document."""
    settings = settings_from_document({"paper_mode": True, "invented_later": 42})
    assert settings == Settings()
    assert "invented_later" not in settings.model_dump()


def test_paper_mode_defaults_true():
    """§1 and §16.2 — the flag the implementer may never flip."""
    assert Settings().paper_mode is True
    assert DEFAULT_SETTINGS["paper_mode"] is True


def test_devig_method_is_constrained_to_the_four_named_methods():
    with pytest.raises(Exception):
        Settings(devig_method="vibes")


# ---- poll_schedule (§3.2, added 2026-09-23) --------------------------------


def _slot(**overrides):
    return {"days": ["sat"], "time": "10:30", "sport": "americanfootball_ncaaf", **overrides}


@pytest.mark.parametrize(
    "bad",
    [
        _slot(time="25:00"),
        _slot(time="9:30"),  # the cron needs HH:MM, and so does anyone reading it
        _slot(time="10:30pm"),
        _slot(days=[]),
        _slot(days=["saturday"]),
        _slot(sport="NFL"),  # the likeliest thing to type, and not a sport key
        _slot(sport=""),
    ],
    ids=["hour 25", "one-digit hour", "12-hour clock", "no days", "long day name",
         "display name", "empty sport"],
)
def test_a_malformed_slot_is_refused_rather_than_scheduled(bad):
    """A slot that validated but meant nothing would register a job that polls
    the wrong thing, or never fires — both silently. `PUT /api/settings`
    validates through this model, so a refusal here is a 422 there."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings.model_validate({"poll_schedule": [bad]})


def test_a_day_named_twice_in_one_slot_is_one_day():
    settings = Settings.model_validate({"poll_schedule": [_slot(days=["sat", "sun", "sat"])]})
    assert settings.poll_schedule[0].days == ["sat", "sun"]


def test_an_empty_plan_is_valid_and_means_the_interval():
    """§13: the empty list is how the interval comes back, so it must validate."""
    assert Settings.model_validate({"poll_schedule": []}).poll_schedule == []


def test_secrets_and_settings_do_not_overlap():
    """§3: secrets never reach Elasticsearch, settings never reach `.env`."""
    assert not set(Secrets.model_fields) & set(Settings.model_fields)
    for secret_key in ("odds_api_key", "discord_bot_token", "discord_channel_id"):
        assert secret_key not in DEFAULT_SETTINGS


def test_missing_secret_names_the_file_to_fix():
    empty = Secrets(odds_api_key="", _env_file=None)
    with pytest.raises(MissingSecretError) as excinfo:
        empty.require("odds_api_key")
    assert "ODDS_API_KEY" in str(excinfo.value)


def test_es_url_has_a_localhost_default():
    """§4.1 — ES binds to 127.0.0.1 only while security is disabled."""
    assert "localhost" in Secrets(_env_file=None).es_url

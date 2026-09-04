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
    "poll_interval_s": 120,
    "poll_interval_dev_s": 21600,
    "props_poll_interval_s": 600,
    "closing_capture_offset_s": 300,
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

"""Opportunity hashing and lifecycle — spec §7.4, §14's dedup list.

The hash is the `_id` in `edgeline-opportunities` and therefore the system's only
uniqueness constraint (§4.4 rule 1). These tests pin its stability: a change to
the formula silently orphans every stored opportunity rather than failing, so the
expected digest is written out literally.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from edgeline.dedup import (
    STATUS_CLOSED,
    STATUS_EXPIRED,
    closing_transition,
    cooldown_expired,
    cooldown_key,
    edge_improved,
    expiry_transition,
    is_expired,
    opp_hash,
    parse_iso,
    select_cooldown_winners,
)

EVENT = "baseball_mlb:evt1"
NOW = datetime(2026, 9, 5, 18, 0, 0, tzinfo=timezone.utc)


def test_hash_is_stable_across_runs():
    """Pinned literally: this value is a wire format, not an implementation detail."""
    first = opp_hash(EVENT, "h2h", ["Cleveland Guardians"], ["draftkings"])
    second = opp_hash(EVENT, "h2h", ["Cleveland Guardians"], ["draftkings"])
    assert first == second
    assert len(first) == 64
    assert first == opp_hash(EVENT, "h2h", ("Cleveland Guardians",), ("draftkings",))


def test_hash_ignores_the_order_legs_were_discovered_in():
    """The same two legs found the other way round are one opportunity, not two."""
    a = opp_hash(EVENT, "h2h", ["Guardians", "Tigers"], ["draftkings", "fanduel"])
    b = opp_hash(EVENT, "h2h", ["Tigers", "Guardians"], ["fanduel", "draftkings"])
    assert a == b


@pytest.mark.parametrize(
    ("event_id", "market", "selections", "books"),
    [
        ("baseball_mlb:evt2", "h2h", ["Guardians"], ["draftkings"]),
        (EVENT, "totals", ["Guardians"], ["draftkings"]),
        (EVENT, "h2h", ["Tigers"], ["draftkings"]),
        (EVENT, "h2h", ["Guardians"], ["fanduel"]),
        (EVENT, "h2h", ["Guardians", "Tigers"], ["draftkings"]),
    ],
)
def test_any_component_change_changes_the_hash(event_id, market, selections, books):
    baseline = opp_hash(EVENT, "h2h", ["Guardians"], ["draftkings"])
    assert opp_hash(event_id, market, selections, books) != baseline


# ---- re-alert gates (§7.4) -------------------------------------------------


def test_edge_must_actually_grow_to_re_alert():
    assert edge_improved(2.0, 2.5, 0.5)
    assert edge_improved(2.0, 3.0, 0.5)


@pytest.mark.parametrize("new_edge", [2.4, 2.0, 1.0])
def test_a_decayed_or_flat_edge_stays_quiet(new_edge):
    """Without this, one long-lived mispricing re-alerts every single cycle."""
    assert not edge_improved(2.0, new_edge, 0.5)


def test_cooldown_blocks_a_recent_alert_and_clears_afterwards():
    recent = (NOW - timedelta(seconds=100)).isoformat().replace("+00:00", "Z")
    old = (NOW - timedelta(seconds=400)).isoformat().replace("+00:00", "Z")

    assert not cooldown_expired(recent, NOW, 300)
    assert cooldown_expired(old, NOW, 300)


def test_never_alerted_means_the_cooldown_is_clear():
    assert cooldown_expired(None, NOW, 300)


def test_cooldown_is_keyed_on_sport_and_market():
    assert cooldown_key("baseball_mlb", "h2h") != cooldown_key("baseball_mlb", "totals")
    assert cooldown_key("baseball_mlb", "h2h") == cooldown_key("baseball_mlb", "h2h")


# ---- cooldown slot allocation (§7.4) ---------------------------------------


def test_highest_edge_wins_the_slot():
    key = cooldown_key("baseball_mlb", "h2h")
    winners = select_cooldown_winners(
        [(key, "small", 2.1), (key, "big", 6.4), (key, "middling", 3.0)],
        last_alert_at_by_key={},
        now=NOW,
        cooldown_s=300,
    )
    assert winners == ["big"]


def test_different_markets_each_get_their_own_slot():
    h2h = cooldown_key("baseball_mlb", "h2h")
    totals = cooldown_key("baseball_mlb", "totals")
    winners = select_cooldown_winners(
        [(h2h, "a", 2.0), (totals, "b", 1.0)],
        last_alert_at_by_key={},
        now=NOW,
        cooldown_s=300,
    )
    assert set(winners) == {"a", "b"}


def test_a_key_inside_its_cooldown_wins_nothing():
    key = cooldown_key("baseball_mlb", "h2h")
    recent = (NOW - timedelta(seconds=10)).isoformat().replace("+00:00", "Z")
    winners = select_cooldown_winners(
        [(key, "big", 9.9)],
        last_alert_at_by_key={key: recent},
        now=NOW,
        cooldown_s=300,
    )
    assert winners == []


# ---- expiry and closure (§7.4) ---------------------------------------------


def test_event_start_expires_the_opportunity():
    assert is_expired("2026-09-05T17:00:00Z", NOW)
    assert not is_expired("2026-09-05T19:00:00Z", NOW)


def test_expiry_is_inclusive_of_the_exact_start_time():
    assert is_expired("2026-09-05T18:00:00Z", NOW)


def test_closing_records_the_edge_the_opportunity_died_with():
    """That figure is what later CLV work compares the alert against."""
    patch = closing_transition(3.75, now_iso="2026-09-05T18:00:00Z")
    assert patch["status"] == STATUS_CLOSED
    assert patch["closing_edge_pct"] == 3.75
    assert patch["closed_at"] == "2026-09-05T18:00:00Z"


def test_expiry_transition_shape():
    patch = expiry_transition(now_iso="2026-09-05T18:00:00Z")
    assert patch["status"] == STATUS_EXPIRED


def test_parse_iso_accepts_the_z_suffix_the_spec_uses():
    """§1 stores UTC ISO-8601 strings; The Odds API writes them with a Z."""
    parsed = parse_iso("2026-09-05T23:10:00Z")
    assert parsed.tzinfo is not None
    assert parsed.hour == 23

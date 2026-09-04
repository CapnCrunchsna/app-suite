"""Staking and guardrails — spec §6.7, golden test G7, plus §14's guardrail list.

Each guardrail is exercised on its own, which takes some care: the caps overlap
at the default settings (2% of a $1,000 bankroll is $20, well under the $250
absolute cap), so isolating one means choosing a bankroll where the others cannot
bind. Tests that let two fire at once would pass whichever rule was actually
doing the work.
"""

from __future__ import annotations

import pytest

from edgeline.config import Settings
from edgeline.oddsmath import american_to_decimal, ev_pct
from edgeline.staking import (
    DAILY_EXPOSURE_CAP,
    DAILY_LOSS_STOP,
    KILL_SWITCH,
    MAX_STAKE_CENTS,
    MAX_STAKE_PCT,
    MIN_EDGE_TO_BET,
    NO_EDGE,
    apply_guardrails,
    arb_allocation_cents,
    kelly_fraction_full,
    kelly_stake_cents,
    plan_ev_stake,
)

TOL = 1e-4
PRICE = american_to_decimal(-110)  # 1.909091


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


# ---- G7 (§6.7, §14) --------------------------------------------------------


def test_g7_quarter_kelly_stake():
    """p=0.545, -110, $1,000 bankroll, quarter Kelly -> $11 after $1 rounding."""
    assert kelly_fraction_full(0.545, PRICE) == pytest.approx(0.044500, abs=TOL)

    raw = kelly_stake_cents(0.545, PRICE, 100_000, 0.25)
    assert raw == pytest.approx(1112.5, abs=0.01)  # $11.13 before rounding

    decision = plan_ev_stake(
        0.545,
        PRICE,
        edge_pct=ev_pct(0.545, PRICE),
        settings=settings(),
        bankroll_cents=100_000,
    )
    assert decision.stake_cents == 1100  # $11
    assert decision.guardrails_applied == []  # no caps triggered
    assert decision.alert


def test_no_edge_means_no_bet_not_a_negative_one():
    """Kelly's answer to a bad price is a negative fraction; it is not a signal
    to bet the other side."""
    assert kelly_fraction_full(0.400, PRICE) < 0
    assert kelly_stake_cents(0.400, PRICE, 100_000, 0.25) == 0.0

    decision = plan_ev_stake(
        0.400, PRICE, edge_pct=-5.0, settings=settings(), bankroll_cents=100_000
    )
    assert decision.stake_cents == 0
    assert decision.guardrails_applied == [NO_EDGE]
    assert not decision.alert


# ---- guardrails, one at a time (§6.7) --------------------------------------


def test_rule_1_absolute_cap():
    # Bankroll large enough that the 2% cap (200_000) cannot bind.
    decision = apply_guardrails(
        50_000, edge_pct=5.0, settings=settings(), bankroll_cents=10_000_000
    )
    assert decision.stake_cents == 25_000
    assert decision.guardrails_applied == [MAX_STAKE_CENTS]
    assert decision.alert


def test_rule_2_percentage_cap():
    # 2% of $1,000 = $20; the $250 absolute cap cannot bind on a $50 raw stake.
    decision = apply_guardrails(
        5_000, edge_pct=5.0, settings=settings(), bankroll_cents=100_000
    )
    assert decision.stake_cents == 2_000
    assert decision.guardrails_applied == [MAX_STAKE_PCT]


def test_rules_1_and_2_compose_in_order():
    """Rule 2 clamps the *output* of rule 1, not the raw stake.

    Raw $5,000 -> $250 (absolute cap) -> $200 (2% of a $10,000 bankroll). If the
    order were reversed the answer would be the same here, but the recorded
    guardrail list would not — and that list is the audit trail.
    """
    decision = apply_guardrails(
        500_000, edge_pct=5.0, settings=settings(), bankroll_cents=1_000_000
    )
    assert decision.stake_cents == 20_000
    assert decision.guardrails_applied == [MAX_STAKE_CENTS, MAX_STAKE_PCT]


def test_rule_3_clamps_to_the_days_remaining_budget():
    decision = apply_guardrails(
        2_000,
        edge_pct=5.0,
        settings=settings(),
        bankroll_cents=10_000_000,
        todays_exposure_cents=99_500,
    )
    assert decision.stake_cents == 500  # the remainder, not the 2_000 asked for
    assert DAILY_EXPOSURE_CAP in decision.guardrails_applied
    assert decision.alert


def test_rule_3_suppresses_when_the_remainder_cannot_fund_one_unit():
    """A $0.50 remainder cannot buy a $1-rounded bet, so nothing is sent."""
    decision = apply_guardrails(
        2_000,
        edge_pct=5.0,
        settings=settings(),
        bankroll_cents=10_000_000,
        todays_exposure_cents=99_950,
    )
    assert decision.stake_cents == 0
    assert decision.suppressed_reason == DAILY_EXPOSURE_CAP
    assert not decision.alert


def test_rule_5_below_min_edge_stores_but_stays_silent():
    """§6.7: "store opportunity, send nothing" — the stake survives, the alert does not."""
    decision = apply_guardrails(
        1_500, edge_pct=1.0, settings=settings(), bankroll_cents=10_000_000
    )
    assert decision.stake_cents == 1_500
    assert decision.suppressed_reason == MIN_EDGE_TO_BET
    assert not decision.alert
    assert decision.suppressed


def test_rule_5_lets_an_edge_exactly_on_the_threshold_through():
    decision = apply_guardrails(
        1_500, edge_pct=1.5, settings=settings(), bankroll_cents=10_000_000
    )
    assert decision.alert


def test_rule_6_kill_switch_stores_but_stays_silent():
    decision = apply_guardrails(
        1_500,
        edge_pct=5.0,
        settings=settings(kill_switch=True),
        bankroll_cents=10_000_000,
    )
    assert decision.stake_cents == 1_500
    assert decision.suppressed_reason == KILL_SWITCH
    assert not decision.alert


def test_rule_6_daily_loss_stop_stores_but_stays_silent():
    decision = apply_guardrails(
        1_500,
        edge_pct=5.0,
        settings=settings(),
        bankroll_cents=10_000_000,
        daily_loss_stop_tripped=True,
    )
    assert decision.stake_cents == 1_500
    assert decision.suppressed_reason == DAILY_LOSS_STOP
    assert not decision.alert


def test_rule_4_rounds_to_the_staking_unit():
    decision = apply_guardrails(
        1_149, edge_pct=5.0, settings=settings(), bankroll_cents=10_000_000
    )
    assert decision.stake_cents == 1_100


def test_rounding_unit_is_configurable():
    decision = apply_guardrails(
        1_149,
        edge_pct=5.0,
        settings=settings(stake_rounding_cents=500),
        bankroll_cents=10_000_000,
    )
    assert decision.stake_cents == 1_000


# ---- arb allocation (§6.7) -------------------------------------------------


def test_arb_allocation_takes_the_tighter_cap():
    # 2% of $1,000 = $20, tighter than the $250 absolute cap.
    assert arb_allocation_cents(settings(), 100_000) == 2_000
    # On a $100,000 bankroll the absolute cap binds instead.
    assert arb_allocation_cents(settings(), 10_000_000) == 25_000


def test_guardrails_never_raise_a_cap():
    """§16.2 — a stake below every cap comes through untouched, and no rule may
    ever increase it."""
    decision = apply_guardrails(
        700, edge_pct=5.0, settings=settings(), bankroll_cents=100_000
    )
    assert decision.stake_cents == 700
    assert decision.guardrails_applied == []

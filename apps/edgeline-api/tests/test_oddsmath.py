"""Golden tests G1-G6 and G8 — spec §14.

§0 rule 3: "If your implementation doesn't reproduce those numbers, the
implementation is wrong — not the test." The expected values below are
transcribed from §14's table, not computed from the code.

Tolerance is §14's `1e-4` unless a case states otherwise. G7 (Kelly stake) lives
in `test_staking.py`, which is where §15's T1.3 puts it — the formula it exercises
is in `staking.py`, not here.

These are pure functions and must never touch Elasticsearch (§14).
"""

from __future__ import annotations

import math

import pytest

from edgeline.oddsmath import (
    ArbSplit,
    american_to_decimal,
    arb_profit_pct,
    bet_first_index,
    clv_pct,
    consensus,
    decimal_to_american,
    devig,
    ev_pct,
    implied_prob,
    inverse_sum,
    is_arb,
    round_to_unit,
    split_arb_stakes,
    staleness,
    staleness_from_others,
)

TOL = 1e-4


# ---- G1: conversions (§6.1) -----------------------------------------------

G1 = [
    # american, decimal, implied prob
    (-110, 1.909091, 0.523810),
    (105, 2.05, 0.487805),
    (100, 2.0, 0.5),
    (-200, 1.5, 0.666667),
    (250, 3.5, 0.285714),
]


@pytest.mark.parametrize(("american", "decimal_odds", "prob"), G1)
def test_g1_conversions(american, decimal_odds, prob):
    assert american_to_decimal(american) == pytest.approx(decimal_odds, abs=TOL)
    assert implied_prob(american_to_decimal(american)) == pytest.approx(prob, abs=TOL)


@pytest.mark.parametrize(("american", "decimal_odds", "prob"), G1)
def test_g1_round_trips_back_to_american(american, decimal_odds, prob):
    assert decimal_to_american(american_to_decimal(american)) == american


def test_g1_boundary_between_the_two_american_branches():
    """d == 2.0 belongs to the `d >= 2` branch, giving +100 rather than -100."""
    assert decimal_to_american(2.0) == 100


@pytest.mark.parametrize("bad", [0.0, 1.0, 0.5, -3.0])
def test_conversions_reject_impossible_decimal_odds(bad):
    with pytest.raises(ValueError):
        implied_prob(bad)
    with pytest.raises(ValueError):
        decimal_to_american(bad)


def test_american_zero_is_rejected():
    with pytest.raises(ValueError):
        american_to_decimal(0)


# ---- G2: de-vig (§6.2) -----------------------------------------------------


def test_g2_devig_multiplicative():
    raw = [implied_prob(american_to_decimal(-120)), implied_prob(american_to_decimal(100))]
    assert raw[0] == pytest.approx(0.545455, abs=TOL)
    assert raw[1] == pytest.approx(0.500000, abs=TOL)
    assert math.fsum(raw) == pytest.approx(1.045455, abs=TOL)

    fair = devig(raw, "multiplicative")
    assert fair[0] == pytest.approx(0.521739, abs=TOL)
    assert fair[1] == pytest.approx(0.478261, abs=TOL)
    assert math.fsum(fair) == pytest.approx(1.0, abs=1e-12)


def test_devig_additive_also_sums_to_one():
    raw = [0.545455, 0.500000]
    fair = devig(raw, "additive")
    assert math.fsum(fair) == pytest.approx(1.0, abs=1e-12)
    # Additive removes the same absolute amount from each side, so the gap the
    # book quoted is preserved where multiplicative narrows it.
    assert fair[0] - fair[1] == pytest.approx(raw[0] - raw[1], abs=1e-12)


def test_devig_defaults_to_multiplicative():
    raw = [0.545455, 0.500000]
    assert devig(raw) == devig(raw, "multiplicative")


@pytest.mark.parametrize("method", ["power", "shin"])
def test_unimplemented_devig_methods_say_so(method):
    """§6.2 keeps the signature and defers the maths; it must not silently fall back."""
    with pytest.raises(NotImplementedError):
        devig([0.55, 0.50], method)


def test_devig_refuses_a_partial_market():
    """Overround only means something across every outcome of the market."""
    with pytest.raises(ValueError):
        devig([0.55])


def test_devig_rejects_an_unknown_method():
    with pytest.raises(ValueError):
        devig([0.55, 0.50], "vibes")


# ---- G3: consensus (§6.3) --------------------------------------------------


def test_g3_consensus_is_a_weighted_median():
    probs = {"A": 0.520, "B": 0.510, "C": 0.515, "D": 0.505}
    weights = {"default": 1, "A": 2}
    # expanded sorted: [0.505, 0.510, 0.515, 0.520, 0.520] -> median 0.515
    assert consensus(probs, weights) == pytest.approx(0.515, abs=TOL)


def test_consensus_median_resists_one_outlying_book():
    """The reason §6.3 specifies median rather than mean."""
    sane = {"A": 0.510, "B": 0.515, "C": 0.512}
    with_outlier = {**sane, "D": 0.900}
    assert consensus(with_outlier) == pytest.approx(0.5135, abs=TOL)
    assert abs(consensus(with_outlier) - consensus(sane)) < 0.005


def test_consensus_weight_zero_drops_a_book():
    probs = {"A": 0.50, "B": 0.60, "C": 0.70}
    assert consensus(probs, {"default": 1, "B": 0}) == pytest.approx(0.60, abs=TOL)


def test_consensus_needs_a_quoting_book():
    with pytest.raises(ValueError):
        consensus({})


# ---- G4: +EV (§6.4) --------------------------------------------------------


def test_g4_ev_pct():
    assert ev_pct(0.545, 1.909091) == pytest.approx(4.0455, abs=TOL)


def test_g4_clears_the_default_threshold():
    """§3.2's ev_threshold_pct default is 2.0."""
    assert ev_pct(0.545, 1.909091) >= 2.0


def test_ev_is_negative_when_the_price_is_worse_than_fair():
    assert ev_pct(0.500, 1.909091) < 0


# ---- G5: arbitrage (§6.5) --------------------------------------------------


def test_g5_arbitrage_split_and_rounding_recheck():
    # Ravens +110 at book X, Chiefs -102 at book Y. The American odds are the
    # source of truth; §14's 1.980392 is that price shown to six figures.
    prices = [american_to_decimal(110), american_to_decimal(-102)]
    assert prices[0] == pytest.approx(2.10, abs=TOL)
    assert prices[1] == pytest.approx(1.980392, abs=TOL)

    assert inverse_sum(prices) == pytest.approx(0.981140, abs=TOL)
    assert is_arb(prices)
    # §6.5's own text says "profit 1.92%", which this matches. See
    # test_g5_profit_figure_differs_from_s14_by_one_rounding_step for why the
    # four-decimal figure in §14's table is 1.9223 rather than 1.9222.
    assert arb_profit_pct(prices) == pytest.approx(1.92215, abs=TOL)
    assert round(arb_profit_pct(prices), 2) == 1.92

    split = split_arb_stakes(10000, prices, rounding_cents=100, min_profit_pct=0.5)
    assert isinstance(split, ArbSplit)

    # Raw split, to the cent: $48.53 / $51.47.
    assert round(split.raw_stakes_cents[0] / 100, 2) == 48.53
    assert round(split.raw_stakes_cents[1] / 100, 2) == 51.47

    # Rounded to $1: $49 / $51.
    assert split.stakes_cents == [4900, 5100]

    # Payouts $102.90 / $101.00; worst case is the $101.00 leg.
    assert split.worst_case_return_cents == 10100
    assert split.worst_case_profit_cents == 100
    assert split.worst_case_profit_pct == pytest.approx(1.00, abs=TOL)
    assert split.accepted


def test_no_arb_when_the_inverse_sum_reaches_one():
    prices = [2.0, 2.0]  # inv == 1.0 exactly: a fair market, not an arb
    assert inverse_sum(prices) == pytest.approx(1.0, abs=1e-12)
    assert not is_arb(prices)


def test_g5_profit_figure_differs_from_s14_by_one_rounding_step():
    """Documents a genuine inconsistency inside the spec, and which side wins.

    §14's table gives G5's profit as 1.9223%. That value is only reachable by
    truncating `inv` to the six significant digits §6.5 *displays* (0.981140) and
    dividing that: (1/0.981140 - 1) x 100 = 1.92225 -> 1.9223. Carrying full
    precision, as §6's opening rule requires — "round only at display time, keep
    full float precision internally" — gives 1.92215 -> 1.9222.

    §6's precision rule wins: truncating intermediates to feed a later division
    is exactly what it forbids, and doing it here would mean doing it everywhere.
    The gap is 0.00015 percentage points, four orders of magnitude below
    `arb_min_profit_pct`'s 0.5 default, so no decision this system makes can turn
    on it. Every other number in G5 is unaffected and asserted exactly above.
    """
    prices = [american_to_decimal(110), american_to_decimal(-102)]
    full_precision = arb_profit_pct(prices)
    from_displayed_inv = (1.0 / 0.981140 - 1.0) * 100.0

    assert round(from_displayed_inv, 4) == 1.9223  # what §14 records
    assert round(full_precision, 4) == 1.9222  # what §6's rule produces
    assert abs(full_precision - from_displayed_inv) < 2e-4


def test_rounding_can_destroy_the_edge_and_the_recheck_catches_it():
    """The whole point of §6.5's re-verification step.

    The same arb as G5 on a small allocation: the proportional split clears the
    threshold comfortably, but $1 rounding pushes both legs to $1.00 — which
    overpays the short-priced side — and the worst case now *loses* money. Note
    that the pre-rounding figure alone would have accepted it.
    """
    prices = [american_to_decimal(110), american_to_decimal(-102)]
    split = split_arb_stakes(200, prices, rounding_cents=100, min_profit_pct=0.5)

    assert split.profit_pct > 0.5  # looked fine on paper
    assert split.stakes_cents == [100, 100]
    assert split.worst_case_profit_cents == -2  # not after rounding
    assert split.worst_case_profit_pct < 0.5
    assert not split.accepted


def test_arb_needs_at_least_two_outcomes():
    with pytest.raises(ValueError):
        inverse_sum([2.0])


@pytest.mark.parametrize(
    ("value", "unit", "expected"),
    [
        (4853.495, 100, 4900),
        (5146.505, 100, 5100),
        (1112.5014, 100, 1100),
        (150.0, 100, 200),  # exactly half rounds up, not to even
        (250.0, 100, 300),  # banker's rounding would give 200 here
        (99.0, 100, 100),
        (49.0, 100, 0),
    ],
)
def test_round_to_unit_is_half_up(value, unit, expected):
    assert round_to_unit(value, unit) == expected


def test_round_to_unit_rejects_a_nonsense_unit():
    with pytest.raises(ValueError):
        round_to_unit(100.0, 0)


# ---- G6: staleness (§6.6) --------------------------------------------------


def test_g6_staleness_scores_and_bet_first():
    betmgm = staleness(0.476, mu=0.511, sigma=0.005)
    fanduel = staleness(0.505, mu=0.512, sigma=0.005)

    assert betmgm == pytest.approx(7.0, abs=TOL)
    assert fanduel == pytest.approx(1.4, abs=TOL)
    # Leg 1 (BetMGM) is the one out of line with the field, so it is the price
    # most likely to move and gets placed first.
    assert bet_first_index([betmgm, fanduel]) == 0


def test_staleness_floor_prevents_a_divide_by_near_zero():
    """A field that agrees to four decimals must not manufacture a huge score."""
    others = [0.5000, 0.5001, 0.4999]
    scored = staleness_from_others(0.5100, others, sigma_floor=0.002)
    assert scored == pytest.approx(abs(0.51 - 0.5) / 0.002, abs=TOL)


def test_staleness_rejects_a_nonpositive_sigma():
    with pytest.raises(ValueError):
        staleness(0.5, mu=0.5, sigma=0.0)


def test_close_staleness_scores_return_no_verdict():
    """§6.6's tie rule needs snapshot history the detection batch does not have,
    so a tie reports None rather than picking a leg arbitrarily."""
    assert bet_first_index([3.0, 2.8]) is None
    assert bet_first_index([3.0, 2.4]) == 0


def test_bet_first_needs_two_legs():
    with pytest.raises(ValueError):
        bet_first_index([1.0])


# ---- G8: CLV (§6.8) --------------------------------------------------------


def test_g8_clv_pct():
    assert clv_pct(0.552, 1.909091) == pytest.approx(5.3818, abs=TOL)


def test_clv_is_negative_when_the_market_moved_against_the_bet():
    assert clv_pct(0.500, 1.909091) < 0

"""Odds math — spec §6. Pure functions, no I/O.

§6's opening rule governs the whole module: **round only at display time, keep
full float precision internally.** Every intermediate here stays a float; the one
place rounding is deliberate is the arbitrage stake split (§6.5), where the
rounding is part of the algorithm rather than presentation — and there the spec
requires re-verifying the edge *after* rounding, because a rounded split can
destroy the profit it was computed from.

Every function here has a golden test in §14 with exact expected numbers. Those
numbers are the contract: if an implementation does not reproduce them, the
implementation is wrong, not the test.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

DEFAULT_DEVIG_METHOD = "multiplicative"
SUPPORTED_DEVIG_METHODS = ("multiplicative", "additive", "power", "shin")


# ---- §6.1 conversions ------------------------------------------------------


def american_to_decimal(american: float) -> float:
    """American odds to decimal. ``a > 0 -> 1 + a/100``; ``a < 0 -> 1 + 100/|a|``."""
    if american == 0:
        raise ValueError("american odds of 0 do not exist")
    if american > 0:
        return 1.0 + american / 100.0
    return 1.0 + 100.0 / abs(american)


def decimal_to_american(decimal_odds: float) -> int:
    """Decimal odds to American. ``d >= 2 -> (d-1)*100``; ``1 < d < 2 -> -100/(d-1)``.

    Display-edge only (§1): decimal is the stored representation, and converting
    back is lossy, so nothing upstream of the UI should call this.
    """
    if decimal_odds <= 1.0:
        raise ValueError(f"decimal odds must exceed 1.0, got {decimal_odds}")
    if decimal_odds >= 2.0:
        return round((decimal_odds - 1.0) * 100.0)
    return round(-100.0 / (decimal_odds - 1.0))


def implied_prob(decimal_odds: float) -> float:
    """The book's implied probability, vig included: ``1/d``."""
    if decimal_odds <= 1.0:
        raise ValueError(f"decimal odds must exceed 1.0, got {decimal_odds}")
    return 1.0 / decimal_odds


# ---- §6.2 de-vig -----------------------------------------------------------


def devig(probs: list[float], method: str = DEFAULT_DEVIG_METHOD) -> list[float]:
    """Strip the book's margin from one market's implied probabilities.

    Input is every outcome of **one market at one book** — the overround only
    means anything across a complete market, so a partial quote cannot be
    de-vigged and callers must not pass one.
    """
    if len(probs) < 2:
        raise ValueError("de-vig needs every outcome of the market, at least 2")
    if any(p <= 0 for p in probs):
        raise ValueError("implied probabilities must be positive")

    if method == "multiplicative":
        total = math.fsum(probs)
        return [p / total for p in probs]

    if method == "additive":
        total = math.fsum(probs)
        excess = (total - 1.0) / len(probs)
        return [p - excess for p in probs]

    if method in ("power", "shin"):
        # The setting exists and the signature is stable, but v1 defaults to
        # multiplicative and these are deliberately not guessed at (§6.2).
        raise NotImplementedError(f"de-vig method {method!r} is not implemented in v1")

    raise ValueError(f"unknown de-vig method {method!r}")


# ---- §6.3 consensus --------------------------------------------------------


def consensus(book_probs: dict[str, float], weights: dict[str, int] | None = None) -> float:
    """Weighted-median fair probability across books.

    Weights are integers and applied by repetition (§6.3), so a book with weight
    3 contributes three values to the median. The median rather than the mean is
    what makes a single stale or mispriced book unable to drag the consensus.
    """
    if not book_probs:
        raise ValueError("consensus needs at least one quoting book")
    weights = weights or {"default": 1}
    default_weight = weights.get("default", 1)

    expanded: list[float] = []
    for book_key, prob in book_probs.items():
        weight = weights.get(book_key, default_weight)
        if weight < 0:
            raise ValueError(f"weight for {book_key!r} is negative")
        expanded.extend([prob] * weight)

    if not expanded:
        raise ValueError("every quoting book has weight 0")
    return statistics.median(expanded)


# ---- §6.4 +EV --------------------------------------------------------------


def ev_pct(consensus_prob: float, price_decimal: float) -> float:
    """Expected value of the bet as a percentage of stake."""
    return (consensus_prob * price_decimal - 1.0) * 100.0


# ---- §6.5 arbitrage --------------------------------------------------------


@dataclass(frozen=True)
class ArbSplit:
    """The result of splitting a bankroll allocation across an arb's legs."""

    total_cents: int
    raw_stakes_cents: list[float]
    stakes_cents: list[int]
    profit_pct: float  # from `inv`, before rounding
    worst_case_return_cents: int
    worst_case_profit_cents: int
    worst_case_profit_pct: float  # after rounding — the one that decides
    accepted: bool


def inverse_sum(prices_decimal: list[float]) -> float:
    """``inv = sum(1/d)``. Below 1.0 means the market can be bought whole for less
    than it always pays out."""
    if len(prices_decimal) < 2:
        raise ValueError("an arb needs at least two outcomes")
    return math.fsum(1.0 / d for d in prices_decimal)


def arb_profit_pct(prices_decimal: list[float]) -> float:
    """``(1/inv - 1) * 100``. Negative when no arb exists."""
    return (1.0 / inverse_sum(prices_decimal) - 1.0) * 100.0


def is_arb(prices_decimal: list[float]) -> bool:
    return inverse_sum(prices_decimal) < 1.0


def round_to_unit(value: float, unit: int) -> int:
    """Round to a whole number of ``unit`` cents, half away from zero.

    Deliberately not Python's ``round()``: that is banker's rounding, so a stake
    landing exactly on .5 units would round to even and make the split depend on
    which side of the market it happened to be. Half-up is what a person reading
    "round to the nearest dollar" expects.
    """
    if unit <= 0:
        raise ValueError("rounding unit must be positive")
    return int(math.floor(value / unit + 0.5)) * unit


def split_arb_stakes(
    total_cents: int,
    prices_decimal: list[float],
    *,
    rounding_cents: int,
    min_profit_pct: float,
) -> ArbSplit:
    """Split ``total_cents`` across the legs, then re-verify after rounding (§6.5).

    The re-verification is the part that matters. Stakes proportional to ``1/d``
    guarantee an equal return whichever outcome lands; rounding them to whole
    dollars breaks that equality, so the worst-case leg — not the average — has
    to clear ``arb_min_profit_pct`` on the actual rounded outlay.
    """
    inv = inverse_sum(prices_decimal)
    profit_pct = (1.0 / inv - 1.0) * 100.0

    raw = [total_cents * (1.0 / d) / inv for d in prices_decimal]
    stakes = [round_to_unit(value, rounding_cents) for value in raw]

    outlay = sum(stakes)
    # Round each payout to the cent rather than truncating. A return of
    # 10099.999999999998 cents is 10100 cents that floating point lost on the way
    # in — truncating would turn that into a phantom penny of loss on every leg,
    # and on a margin this thin a phantom penny can flip `accepted`.
    worst_return = min(
        round_to_unit(stake * price, 1) for stake, price in zip(stakes, prices_decimal)
    )
    worst_profit = worst_return - outlay
    worst_profit_pct = (worst_profit / outlay * 100.0) if outlay else 0.0

    return ArbSplit(
        total_cents=total_cents,
        raw_stakes_cents=raw,
        stakes_cents=stakes,
        profit_pct=profit_pct,
        worst_case_return_cents=worst_return,
        worst_case_profit_cents=worst_profit,
        worst_case_profit_pct=worst_profit_pct,
        accepted=inv < 1.0 and worst_profit_pct >= min_profit_pct,
    )


# ---- §6.6 staleness --------------------------------------------------------


def staleness(book_prob: float, *, mu: float, sigma: float) -> float:
    """How many sigma this book's fair probability sits from the field's median."""
    if sigma <= 0:
        raise ValueError("sigma must be positive; apply staleness_sigma_floor first")
    return abs(book_prob - mu) / sigma


def staleness_from_others(
    book_prob: float, others: list[float], *, sigma_floor: float
) -> float:
    """§6.6 with mu and sigma derived from every *other* book's de-vigged prob.

    The floor exists because a market where every book agrees to four decimals
    has a near-zero sigma, which would turn a trivial disagreement into an
    enormous score.
    """
    if not others:
        raise ValueError("staleness needs at least one other book")
    mu = statistics.median(others)
    spread = statistics.stdev(others) if len(others) > 1 else 0.0
    return staleness(book_prob, mu=mu, sigma=max(spread, sigma_floor))


def bet_first_index(scores: list[float], *, tie_delta: float = 0.5) -> int | None:
    """Which leg to place first: the one most likely to be the stale price (§6.6).

    Returns ``None`` on a tie. §6.6 breaks a tie by whichever price moved most
    recently, which needs two snapshots per book from ``edgeline-odds-snapshots``;
    the detection cycle works from an in-memory batch and has no history, so
    rather than pick arbitrarily this reports "no verdict" and lets the caller
    supply history if it has any.
    """
    if len(scores) < 2:
        raise ValueError("bet_first needs at least two legs")
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    best, runner_up = ranked[0], ranked[1]
    if scores[best] - scores[runner_up] < tie_delta:
        return None
    return best


# ---- §6.8 CLV --------------------------------------------------------------


def clv_pct(closing_consensus_prob: float, price_decimal_at_alert: float) -> float:
    """The alerted bet's EV re-evaluated at the closing consensus (§6.8).

    Same shape as ``ev_pct`` but a different question, and the more honest one:
    EV says what the edge looked like against a live field, CLV says whether the
    market ultimately agreed.
    """
    return (closing_consensus_prob * price_decimal_at_alert - 1.0) * 100.0

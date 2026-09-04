"""Staking — spec §6.7. Fractional Kelly plus the guardrail ladder.

**The guardrail order is load-bearing, not stylistic.** Each rule operates on the
output of the one before it, so re-ordering them changes the stake. Clamping to
the daily-exposure remainder before the percentage cap, for instance, would let a
bet exceed `max_stake_pct` whenever the day still had room. The order in
`apply_guardrails` is §6.7's, step for step, and `guardrails_applied` records
every rule that actually bound so a recommendation can be audited after the fact.

Two of the six rules do not change the stake at all — steps 5 and 6 leave it
intact and suppress the *alert*. That distinction matters: §6.7 says "store
opportunity, send nothing", so the detection is still recorded for later CLV
analysis; only the notification is withheld. `StakeDecision.alert` carries that,
never a silently zeroed stake.

§16.2: nothing here may raise a cap or disable a guardrail. The settings are read,
never written.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import Settings
from .oddsmath import round_to_unit

# guardrails_applied entries — the §3.2 setting key that bound.
MAX_STAKE_CENTS = "max_stake_cents"
MAX_STAKE_PCT = "max_stake_pct"
DAILY_EXPOSURE_CAP = "daily_exposure_cap_cents"
MIN_EDGE_TO_BET = "min_edge_to_bet_pct"
KILL_SWITCH = "kill_switch"
DAILY_LOSS_STOP = "daily_loss_stop_cents"
NO_EDGE = "no_edge"


@dataclass(frozen=True)
class StakeDecision:
    """What to stake, and whether anyone gets told about it."""

    stake_cents: int
    guardrails_applied: list[str] = field(default_factory=list)
    alert: bool = True
    suppressed_reason: str | None = None

    @property
    def suppressed(self) -> bool:
        return not self.alert


def kelly_fraction_full(consensus_prob: float, price_decimal: float) -> float:
    """Full-Kelly fraction of bankroll: ``(p*d - 1) / (d - 1)`` (§6.7).

    Negative when the price is worse than the consensus thinks it should be —
    Kelly's answer to a bad bet is a negative stake, which means "do not bet",
    never "bet the other side".
    """
    if price_decimal <= 1.0:
        raise ValueError(f"decimal odds must exceed 1.0, got {price_decimal}")
    b = price_decimal - 1.0
    return (consensus_prob * price_decimal - 1.0) / b


def kelly_stake_cents(
    consensus_prob: float,
    price_decimal: float,
    bankroll_cents: int,
    kelly_fraction: float,
) -> float:
    """Fractional-Kelly stake in cents, before any guardrail (§6.7).

    Returns 0.0 rather than a negative number when there is no edge: a negative
    stake is not a bet, and letting it flow into the guardrail ladder would make
    every clamp comparison meaningless.
    """
    f_full = kelly_fraction_full(consensus_prob, price_decimal)
    if f_full <= 0:
        return 0.0
    return f_full * kelly_fraction * bankroll_cents


def arb_allocation_cents(settings: Settings, bankroll_cents: int) -> int:
    """Total allocation ``B`` fed into §6.5's split: the tighter of the two caps."""
    pct_cap = bankroll_cents * settings.max_stake_pct / 100.0
    return int(min(settings.max_stake_cents, pct_cap))


def apply_guardrails(
    raw_stake_cents: float,
    *,
    edge_pct: float,
    settings: Settings,
    bankroll_cents: int,
    todays_exposure_cents: int = 0,
    daily_loss_stop_tripped: bool = False,
) -> StakeDecision:
    """§6.7's six rules, in §6.7's order.

    ``edge_pct`` is EV% for a +EV bet and profit% for an arb — whichever number
    the detection's threshold is expressed in.
    """
    applied: list[str] = []
    stake = float(raw_stake_cents)

    if stake <= 0:
        return StakeDecision(0, [NO_EDGE], alert=False, suppressed_reason=NO_EDGE)

    # 1. Absolute cap.
    if stake > settings.max_stake_cents:
        stake = float(settings.max_stake_cents)
        applied.append(MAX_STAKE_CENTS)

    # 2. Percentage-of-bankroll cap, applied to the result of step 1.
    pct_cap = bankroll_cents * settings.max_stake_pct / 100.0
    if stake > pct_cap:
        stake = pct_cap
        applied.append(MAX_STAKE_PCT)

    # 3. Daily exposure. Clamp to what is left of the day's budget; if the
    #    remainder cannot even fund one rounding unit, there is no bet to place
    #    and the alert is suppressed outright rather than rounded down to zero.
    remainder = settings.daily_exposure_cap_cents - todays_exposure_cents
    if todays_exposure_cents + stake > settings.daily_exposure_cap_cents:
        applied.append(DAILY_EXPOSURE_CAP)
        if remainder < settings.stake_rounding_cents:
            return StakeDecision(
                0, applied, alert=False, suppressed_reason=DAILY_EXPOSURE_CAP
            )
        stake = float(remainder)

    # 4. Round to the staking unit.
    stake_cents = round_to_unit(stake, settings.stake_rounding_cents)

    # 5. Below the betting threshold: record the opportunity, say nothing.
    if edge_pct < settings.min_edge_to_bet_pct:
        applied.append(MIN_EDGE_TO_BET)
        return StakeDecision(
            stake_cents, applied, alert=False, suppressed_reason=MIN_EDGE_TO_BET
        )

    # 6. Kill switch or the daily loss stop: same treatment, different cause.
    if settings.kill_switch:
        applied.append(KILL_SWITCH)
        return StakeDecision(
            stake_cents, applied, alert=False, suppressed_reason=KILL_SWITCH
        )
    if daily_loss_stop_tripped:
        applied.append(DAILY_LOSS_STOP)
        return StakeDecision(
            stake_cents, applied, alert=False, suppressed_reason=DAILY_LOSS_STOP
        )

    return StakeDecision(stake_cents, applied, alert=True)


def plan_ev_stake(
    consensus_prob: float,
    price_decimal: float,
    *,
    edge_pct: float,
    settings: Settings,
    bankroll_cents: int,
    todays_exposure_cents: int = 0,
    daily_loss_stop_tripped: bool = False,
) -> StakeDecision:
    """Kelly stake for a +EV detection, with the guardrail ladder applied."""
    raw = kelly_stake_cents(
        consensus_prob, price_decimal, bankroll_cents, settings.kelly_fraction
    )
    return apply_guardrails(
        raw,
        edge_pct=edge_pct,
        settings=settings,
        bankroll_cents=bankroll_cents,
        todays_exposure_cents=todays_exposure_cents,
        daily_loss_stop_tripped=daily_loss_stop_tripped,
    )

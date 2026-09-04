"""Canonical engine-internal I/O models — spec §5.

These four models are the contract between pipeline stages: the normalizer (§7.2)
emits ``BookOddsSnapshot``, detection (§6.4/§6.5) emits ``OpportunityLeg``, and
staking (§6.7) emits ``StakePlan``. They are transcribed from §5 field for field;
change them only by changing the spec first.

Two conventions from §1 are load-bearing here and are *not* re-derived elsewhere:
money is integer **cents**, and every timestamp is a UTC ISO-8601 **string**.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict


def utc_now_iso() -> str:
    """Current time as a UTC ISO-8601 string, second precision, ``Z``-suffixed.

    Shaped to match The Odds API's own timestamps so provider values and our own
    stamps sort lexicographically against each other without parsing (§1).
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class BookOddsSnapshot(BaseModel):
    """One price, from one book, for one selection — the normalizer's output row."""

    model_config = ConfigDict(extra="forbid")

    provider_event_id: str
    sport_key: str
    commence_time: str
    home_team: str
    away_team: str
    book_key: str
    market_key: str
    selection: str  # canonical form, §7.2
    line: float | None
    price_decimal: float
    fetched_at: str


class OpportunityLeg(BaseModel):
    """One side of a detected opportunity, priced and de-vigged."""

    model_config = ConfigDict(extra="forbid")

    book_key: str
    selection: str
    line: float | None
    price_decimal: float
    price_american: int
    devig_prob: float
    staleness: float | None = None
    bet_first: bool = False


class StakeLeg(BaseModel):
    """What to actually put down on one leg, and where the human goes to do it."""

    model_config = ConfigDict(extra="forbid")

    book_key: str
    selection: str
    stake_cents: int
    to_win_cents: int
    deep_link: str
    link_level: str  # 'betslip' | 'event' | 'book_home'


class StakePlan(BaseModel):
    """The full recommendation payload stored on a recommendation document."""

    model_config = ConfigDict(extra="forbid")

    total_cents: int
    legs: list[StakeLeg]
    method: str  # 'kelly' | 'arb_split'
    guardrails_applied: list[str]  # e.g. ['max_stake_pct']

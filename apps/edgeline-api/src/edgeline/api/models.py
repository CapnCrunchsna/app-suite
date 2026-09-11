"""Response shapes for §10.

These exist so `/api/openapi.json` carries real schemas rather than bare objects.
§11.3 has the UI import *only* from the generated client, which is worth nothing
if every call returns `unknown` — the types here are what make that rule buy
type-safety instead of just indirection.

They describe what the routes return, which is Elasticsearch documents with their
`_id` folded in. Fields the datastore may legitimately omit are optional: §4.3
leaves `md_licensed` unset until licensure is verified, `clv_pct` is null when no
closing line was captured, and a live opportunity has no `closed_at`. Modelling
those as required would make the API lie about data that is honestly absent.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class SportsbookRow(BaseModel):
    id: str
    display_name: str | None = None
    enabled: bool = False
    md_licensed: bool | None = None  # absent until a human verifies it (§4.3)
    priority: int | None = None
    link_templates: dict[str, Any] = Field(default_factory=dict)


class ProviderRow(BaseModel):
    id: str
    display_name: str | None = None
    enabled: bool | None = None
    quota_used: int | None = None
    quota_budget: int | None = None
    quota_reset_at: str | None = None
    config: dict[str, Any] | None = None


class OpportunityLegRow(BaseModel):
    book_key: str
    selection: str
    line: float | None = None
    price_decimal: float
    devig_prob: float | None = None
    staleness: float | None = None
    bet_first: bool = False


class EventRow(BaseModel):
    """The fixture an opportunity is about — §4.3's `edgeline-events` document.

    Joined onto every opportunity because `event_id` alone
    (`baseball_mlb:8dafff0a…`) is a primary key, not information: it tells a
    reader nothing about which game they are being asked to bet on. The engine
    has had these fields since §7.2's normalizer upserted them; they were simply
    never carried out to the API.

    Optional on the row rather than required: an opportunity outlives its event
    document only if something has gone wrong, but a table that 500s because one
    fixture was reaped is worse than a table with one thin row in it.
    """

    sport_key: str
    commence_time: str
    home_team: str
    away_team: str


class OpportunityRow(BaseModel):
    id: str
    type: str
    event_id: str
    event: EventRow | None = None
    market_key: str
    legs: list[OpportunityLegRow] = Field(default_factory=list)
    edge_pct: float
    status: str
    detected_at: str
    expires_at: str | None = None
    closed_at: str | None = None
    closing_edge_pct: float | None = None


class ResultRow(BaseModel):
    bet_id: str = ""
    outcome: str
    pnl_cents: int
    clv_pct: float | None = None  # null when no closing line was captured (§12.4)
    needs_manual: bool = False
    graded_at: str


class RecommendationRow(BaseModel):
    id: str
    opportunity_id: str
    stakes: dict[str, Any] = Field(default_factory=dict)
    paper: bool
    channel: str
    sent_at: str
    message_ref: str | None = None
    #: Joined in by the route, since Elasticsearch has no joins.
    opportunity: OpportunityRow | None = None
    result: ResultRow | None = None


class BetRow(BaseModel):
    id: str
    recommendation_id: str
    confirmed_via: str
    stake_actual_cents: int
    odds_actual_decimal: float
    placed_at: str


class LedgerEntry(BaseModel):
    # `@timestamp` is the §4.3 field name and not a Python identifier, so it is
    # aliased rather than renamed — the wire name is the one the UI sees.
    model_config = ConfigDict(populate_by_name=True)

    id: str
    book_key: str
    delta_cents: int
    reason: str
    ref_result_id: str = ""
    timestamp: str = Field(alias="@timestamp")


class BookBalance(BaseModel):
    book_key: str
    balance_cents: int


class BankrollResponse(BaseModel):
    total_cents: int
    by_book: list[BookBalance] = Field(default_factory=list)
    entries: list[LedgerEntry] = Field(default_factory=list)


class SummaryBucket(BaseModel):
    key: str
    graded: int
    pnl_cents: int
    avg_clv_pct: float | None = None
    wins: int
    settled: int
    #: Null rather than 0.0 when nothing has settled — "no data yet" and "you lose
    #: every bet" must not look the same on a dashboard.
    hit_rate: float | None = None
    executed: int
    executed_pnl_cents: int
    paper: int
    needs_manual: int


class SummaryTotals(BaseModel):
    graded: int
    pnl_cents: int
    avg_clv_pct: float | None = None
    wins: int = 0
    settled: int = 0
    hit_rate: float | None = None


class SummaryResponse(BaseModel):
    group: str
    buckets: list[SummaryBucket] = Field(default_factory=list)
    totals: SummaryTotals


class QuotaRow(BaseModel):
    provider: str
    quota_used: int | None = None
    quota_budget: int | None = None
    quota_reset_at: str | None = None


class HealthResponse(BaseModel):
    paper_mode: bool
    kill_switch: bool
    #: §3.2. Surfaced here because it is the difference between "the worker is
    #: dead" and "the worker is deliberately not polling" — and `runtime` alone
    #: cannot tell those apart: the heartbeat keeps ticking either way.
    offline_mode: bool = False
    #: §13's heartbeat stamps this; a stale value means polling has stopped even
    #: though the API is still answering.
    runtime: dict[str, Any] = Field(default_factory=dict)
    quota: list[QuotaRow] = Field(default_factory=list)
    sports_enabled: list[str] = Field(default_factory=list)


class KillSwitchResponse(BaseModel):
    kill_switch: bool


class UnmatchedRowResponse(BaseModel):
    id: str
    provider_key: str
    raw: dict[str, Any] = Field(default_factory=dict)
    reason: str
    resolved: bool
    created_at: str

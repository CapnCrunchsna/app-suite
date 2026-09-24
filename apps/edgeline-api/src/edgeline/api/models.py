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

from typing import Any, Literal

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


class ClvProvenance(BaseModel):
    """Where a scope's CLV figures came from (§12.4, §3.2 `closing_capture_mode`).

    `avg_clv_pct` above may mix a bought closing price with one derived from the
    last poll before kickoff, which can be twelve hours old. These make the mix
    visible rather than leaving one number to stand for two measurements.
    """

    clv_from_closing: int = 0
    clv_from_derived: int = 0
    #: The average over bought closing lines alone. `None` when there are none —
    #: which is the honest answer, not the mixed figure wearing a stronger label.
    avg_clv_pct_closing: float | None = None


class SummaryBucket(ClvProvenance):
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


class SummaryTotals(ClvProvenance):
    graded: int
    pnl_cents: int
    avg_clv_pct: float | None = None
    wins: int = 0
    settled: int = 0
    hit_rate: float | None = None
    #: Results marked `excluded_reason` and left out of every figure above —
    #: reported so the page can say rows were set aside rather than silently
    #: showing fewer of them (`audit.py`).
    excluded: int = 0


class SummaryResponse(BaseModel):
    group: str
    buckets: list[SummaryBucket] = Field(default_factory=list)
    totals: SummaryTotals


class QuotaRow(BaseModel):
    provider: str
    quota_used: int | None = None
    quota_budget: int | None = None
    quota_reset_at: str | None = None


class PollPlanStatus(BaseModel):
    """What sets the featured cadence — §3.2's `poll_schedule`, §13.

    Read from the stored settings, so it is what the next worker start will
    run. When the worker is up, `runtime.next_poll_at` says what the running
    process has actually registered.
    """

    #: `schedule` while the weekly plan is in effect (it has a slot and the
    #: budget is the free tier's); `interval` otherwise.
    mode: Literal["schedule", "interval"]
    #: Polls a week the plan makes, which §8.4 projects from. `None` on the interval.
    polls_per_week: int | None = None
    #: The plan's sports, in plan order. Empty on the interval.
    sports: list[str] = Field(default_factory=list)
    #: What `POST /api/system/poll` would poll right now: today's plan sports by
    #: the plan's Eastern calendar, else `sports_enabled`.
    poll_now_sports: list[str] = Field(default_factory=list)
    #: The clock the plan's times are written in.
    timezone: str


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
    poll_plan: PollPlanStatus | None = None


class KillSwitchResponse(BaseModel):
    kill_switch: bool


class PollCycleRow(BaseModel):
    """One sport's cycle inside a manual poll — §7.1's `CycleReport`, narrowed.

    The engine's report carries the detections themselves; this carries their
    counts. A button needs a number, and the rows are already on
    `/api/opportunities` for anyone who wants the detail.
    """

    sport_key: str
    snapshots: int = 0
    events: int = 0
    quarantined: int = 0
    detections: int = 0
    alerted: int = 0
    enabled_books: int = 0
    #: `offline_mode` stopped this cycle before any provider request (§3.2).
    offline: bool = False
    #: Polled, but did not alert — `kill_switch`, today (§7.1). Distinct from
    #: `offline`, which means nothing was fetched at all.
    skipped_reason: str | None = None


class PollNowResponse(BaseModel):
    """What the manual trigger did, totalled across the sports it polled."""

    offline: bool = False
    cycles: list[PollCycleRow] = Field(default_factory=list)
    snapshots: int = 0
    detections: int = 0
    alerted: int = 0
    #: From the last cycle's response headers, which are the only truth about
    #: credits (§8.3). `None` when nothing was fetched.
    quota_used: int | None = None
    quota_remaining: int | None = None


class UnmatchedRowResponse(BaseModel):
    id: str
    provider_key: str
    raw: dict[str, Any] = Field(default_factory=dict)
    reason: str
    resolved: bool
    created_at: str

"""Configuration — spec §3.

Two disjoint stores, and the split is a security boundary, not a style choice:

* **Secrets (§3.1)** live in ``.env`` only. They are never written to Elasticsearch,
  never logged, and never returned by the API. ``Secrets`` below is the only reader.
* **Settings (§3.2)** live in the single ``"global"`` document of ``edgeline-settings``
  and are editable from the UI. They are never put in ``.env`` — a value you can
  change from a web page has no business in a file you have to redeploy.

``Settings`` carries the §3.2 defaults as field defaults, so the engine has a
complete, typed configuration *before* Elasticsearch has ever been seeded (and on
a machine where the datastore is not running at all). ``DEFAULT_SETTINGS`` is the
seed payload ``es.ensure_indices()`` writes.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/edgeline-api/ — .env sits beside pyproject.toml, not inside the package.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"

DevigMethod = Literal["multiplicative", "additive", "power", "shin"]
ClosingCaptureMode = Literal["off", "recommended", "all"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
#: `datetime.weekday()` order, so `WEEKDAYS[d.weekday()]` names a date's day.
WEEKDAYS: tuple[Weekday, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


class MissingSecretError(RuntimeError):
    """Raised when a code path needs a secret that ``.env`` does not supply."""


class Secrets(BaseSettings):
    """The §3.1 ``.env`` keys. Absent values stay empty rather than raising.

    Import-time explosions would make the whole engine unimportable on a fresh
    checkout — including the tests, which need none of these. Call sites that
    genuinely require a secret ask for it through ``require()``.
    """

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    odds_api_key: str = ""
    discord_bot_token: str = ""
    # Kept as a string: `.env.example` ships this key empty, and an `int` field
    # would turn "copied the example and haven't filled it in yet" into a
    # validation crash at import.
    discord_channel_id: str = ""
    es_url: str = "http://localhost:9200"

    def require(self, name: str) -> str:
        value = getattr(self, name, "")
        if not value:
            raise MissingSecretError(
                f"{name.upper()} is not set. Copy .env.example to "
                f"{ENV_FILE} and fill it in (spec §3.1, §17)."
            )
        return value


class PollSlot(BaseModel):
    """One row of §3.2's `poll_schedule`: poll `sport` at `time` on each of `days`.

    `time` is a 24-hour ``HH:MM`` in **America/New_York**, not this machine's
    zone: the games are scheduled in Eastern time, so the plan is written in it,
    and the scheduler's cron follows DST from there (§13).
    """

    model_config = ConfigDict(extra="ignore")

    days: list[Weekday] = Field(min_length=1)
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    #: A The Odds API sport key. Lower-case by construction, so "NFL" — the
    #: likeliest thing to type — is refused rather than polled as a sport that
    #: does not exist and answered with nothing.
    sport: str = Field(pattern=r"^[a-z0-9_]+$")

    @field_validator("days")
    @classmethod
    def _each_day_once(cls, days: list[str]) -> list[str]:
        return list(dict.fromkeys(days))


def _default_poll_schedule() -> list[PollSlot]:
    """§3.2's weekly plan, placed from data on 2026-09-23 — see §8.4.

    Each poll sits about ninety minutes before its sport's first big window of
    starts that day: late enough that inactives, goalies and injury news are out
    and books are re-pricing at different speeds, early enough that the whole
    slate is still pre-game. 14 polls a week at markets x regions each is the same
    ~360 credits a month the 12-hour interval cost.
    """
    return [
        PollSlot(days=["sun"], time="11:30", sport="americanfootball_nfl"),
        PollSlot(days=["sun"], time="15:00", sport="americanfootball_nfl"),
        PollSlot(days=["mon", "thu"], time="18:45", sport="americanfootball_nfl"),
        PollSlot(days=["sat"], time="10:30", sport="americanfootball_ncaaf"),
        PollSlot(days=["sat"], time="17:30", sport="americanfootball_ncaaf"),
        PollSlot(days=["tue", "wed", "thu", "fri"], time="17:30", sport="icehockey_nhl"),
        PollSlot(days=["mon", "tue", "wed", "fri"], time="17:30", sport="basketball_nba"),
    ]


class Settings(BaseModel):
    """The complete §3.2 default set, typed, with the spec's defaults verbatim.

    ``extra="ignore"``: the settings document is stored ``dynamic: false`` (§4.2),
    so a key added by a newer build and read back by an older one must degrade to
    "unknown key, ignored" rather than crash the worker.
    """

    model_config = ConfigDict(extra="ignore", validate_assignment=True)

    # Mode and safety. paper_mode starts true and only the user may flip it (§16.2).
    paper_mode: bool = True
    kill_switch: bool = False
    #: When true, **no job makes a provider request** — the worker, the API, the
    #: UI, grading and the §7.4 lifecycle all keep running on what is already
    #: stored. Added 2026-09-10, after a spent monthly allowance stopped every
    #: kind of development at once, including the kinds that never needed the
    #: provider.
    #:
    #: The mirror of `kill_switch`, which stops alerting and keeps polling. This
    #: stops polling and keeps everything else, so the two together cover both
    #: halves of "run, but not that part".
    #:
    #: It deliberately does **not** replay recorded fixtures into the live
    #: indices. §12 computes CLV from those rows, and fabricated prices sitting
    #: beside real ones would corrupt the one measurement that says whether the
    #: detector works. Replay belongs against a separate index prefix, which is
    #: what the test suite already does.
    offline_mode: bool = False

    # Staking
    kelly_fraction: float = 0.25
    bankroll_start_cents: int = 100_000  # $1,000 — ASK USER for the real value (§17)

    # Detection thresholds
    ev_threshold_pct: float = 2.0
    min_edge_to_bet_pct: float = 1.5
    min_books_for_consensus: int = 4
    arb_min_profit_pct: float = 0.5

    # Guardrails
    max_stake_cents: int = 25_000
    max_stake_pct: float = 2.0
    daily_exposure_cap_cents: int = 100_000
    daily_loss_stop_cents: int = 50_000
    stake_rounding_cents: int = 100

    # Odds math
    devig_method: DevigMethod = "multiplicative"
    consensus_weights: dict[str, int] = Field(default_factory=lambda: {"default": 1})
    staleness_sigma_floor: float = 0.002

    # Alerting
    edge_improve_delta_pct: float = 0.5
    alert_cooldown_s: int = 300

    # Coverage
    sports_enabled: list[str] = Field(default_factory=lambda: ["baseball_mlb"])
    markets_featured: list[str] = Field(
        default_factory=lambda: ["h2h", "spreads", "totals"]
    )
    markets_props: list[str] = Field(
        default_factory=lambda: ["batter_home_runs", "pitcher_strikeouts"]
    )
    #: The Odds API region buckets to request (§8). Not in §3.2's original table —
    #: added 2026-09-09 because it turned out to be the setting that decides
    #: whether detection can work at all, and it had been hardcoded to "us".
    #:
    #: `us` alone returns only four Maryland-legal books for MLB, and §6.4 needs a
    #: consensus from four *other* books, so nothing was ever priced. `us2` brings
    #: a fifth (espnbet), which is exactly enough. Each extra region multiplies the
    #: credit cost (§8.4), which is why `poll_interval_dev_s` doubled alongside it.
    regions: list[str] = Field(default_factory=lambda: ["us", "us2"])

    # Cadence
    poll_interval_s: int = 120
    #: 12 h, not §3.2's original 6 h. Requesting two regions doubles the per-poll
    #: credit cost, so halving the poll rate keeps the dev cadence at the same
    #: 360 credits/month it always cost — inside the free tier's 500 (§8.4).
    #:
    #: Since 2026-09-23 only the fallback: it applies on the free tier when
    #: `poll_schedule` is empty.
    poll_interval_dev_s: int = 43_200
    #: The free tier's cadence as fixed Eastern-time polls, per sport, by weekday
    #: (§8.4, §13). Added 2026-09-23: an interval anchored to worker start landed
    #: its two daily polls wherever the process was last restarted, and the only
    #: polls that ever found anything were ones that happened to land in the
    #: afternoon. An empty list restores `poll_interval_dev_s`; a budget above the
    #: free tier's selects `poll_interval_s` and ignores this.
    poll_schedule: list[PollSlot] = Field(default_factory=_default_poll_schedule)
    props_poll_interval_s: int = 600
    closing_capture_offset_s: int = 300
    #: Whether to **buy** closing lines, and for which events (§12.4). Added
    #: 2026-09-11, when the real cost was measured rather than assumed.
    #:
    #: * ``off`` — buy none. CLV falls back to the last stored price before the
    #:   event started, which costs nothing because that poll was already paid
    #:   for. Weaker (up to a poll interval stale) but universal: it covers every
    #:   event, including ones no recommendation was made on.
    #: * ``recommended`` — buy one targeted snapshot per event that has an
    #:   ungraded recommendation. True closing lines where CLV actually decides
    #:   something. Measured at roughly 90 credits/month on this fixture list.
    #: * ``all`` — buy one for every event in the window. What the code did
    #:   before this setting existed, at **1,188 credits/month against a 500
    #:   budget** — 2.4x the whole allowance, spent mostly on events nobody bet.
    #:
    #: `off` is the default because it is the only one that cannot overspend, and
    #: flipping to `recommended` on a paid tier is a one-setting change.
    closing_capture_mode: ClosingCaptureMode = "off"

    #: Fills the literal `{state}` some provider deep links carry — BetMGM and
    #: betPARX both return `https://sports.{state}.betmgm.com/…` style URLs
    #: (§9.4, 2026-09-12). Lower-case two-letter code; it is the state whose
    #: sportsbook you hold an account with, which is the Maryland this whole
    #: project assumes. A wrong value here does not error, it sends someone to
    #: another state's site, so it is a setting rather than a constant.
    book_state: str = "md"

    # Provider budget
    quota_monthly_budget: int = 500


#: The seed payload for ``edgeline-settings/_doc/global`` (§3.2, §4.3).
DEFAULT_SETTINGS: dict[str, Any] = Settings().model_dump()

#: The ``"runtime"`` settings document is written only by the scheduler (§4.3); it
#: is seeded empty so the document exists for partial updates from cycle one.
DEFAULT_RUNTIME: dict[str, Any] = {}


@lru_cache(maxsize=1)
def get_secrets() -> Secrets:
    """Process-wide secrets, read once from ``.env`` (and the real environment)."""
    return Secrets()


def settings_from_document(doc: dict[str, Any] | None) -> Settings:
    """Typed settings from a stored ``edgeline-settings`` document.

    Every key the document omits falls back to its §3.2 default, which is what
    makes the engine runnable before T0.3's seed has ever run.
    """
    return Settings.model_validate(doc or {})


def es_url() -> str:
    return get_secrets().es_url

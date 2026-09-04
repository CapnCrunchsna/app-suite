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

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# apps/edgeline-api/ — .env sits beside pyproject.toml, not inside the package.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"

DevigMethod = Literal["multiplicative", "additive", "power", "shin"]


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

    # Cadence
    poll_interval_s: int = 120
    poll_interval_dev_s: int = 21_600
    props_poll_interval_s: int = 600
    closing_capture_offset_s: int = 300

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

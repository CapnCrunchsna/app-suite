"""The Odds API v1 adapter — spec §8.

Endpoint table, HTTP policy and quota accounting are transcribed from §8. Three
things in here are deliberate and easy to undo by accident:

1. **``oddsFormat=decimal`` on every odds request.** §1 stores decimal odds as
   REAL and converts to American only at display edges; asking the provider for
   American odds would put a lossy conversion at *ingest*, where it can never be
   undone.
2. **Quota comes from the response headers, never from our own arithmetic** (§8).
   A retried request, a cached response or a second process would all desynchronise
   a local counter; ``x-requests-used`` cannot.
3. **429 is the only status that retries.** §8 gives each failure a different
   pipeline consequence — 401 kills the cycle, 5xx skips it — and retrying either
   of those would turn a clear signal into a delayed, noisier version of itself.

The fixture recorder writes response *bodies* only. The API key travels as a query
parameter, so it must never reach a fixture file, a log line, or an exception
message; error text here quotes the endpoint path, never the request URL.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from ..config import PROJECT_ROOT, get_secrets
from ..schemas import utc_now_iso
from .base import (
    ProviderAuthError,
    ProviderBudgetExceeded,
    ProviderError,
    ProviderQuotaExhausted,
    ProviderRateLimited,
    ProviderResponse,
    ProviderUnavailable,
    QuotaStatus,
    register_provider,
)

log = logging.getLogger(__name__)


def _month_elapsed_fraction(now: datetime) -> float:
    """How far through the calendar month we are, in [0, 1].

    The Odds API resets the allowance at the start of the month (verified by the
    user, 2026-09-10), so the month boundary is the right denominator.
    """
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        nxt = start.replace(year=start.year + 1, month=1)
    else:
        nxt = start.replace(month=start.month + 1)
    return (now - start).total_seconds() / (nxt - start).total_seconds()

BASE_URL = "https://api.the-odds-api.com/v4"
#: How far ahead of the calendar the spend may run before requests are refused.
#: Not zero, because real usage is lumpy — a busy Saturday is not a runaway. 15%
#: of a 500-credit month is 75 credits of slack, which covers a heavy day and
#: still catches the failure that prompted this: 80% of the budget gone with 30%
#: of the month elapsed would have tripped it inside the first hour.
DEFAULT_PACE_HEADROOM = 0.15
#: Endpoints The Odds API documents as costing nothing. The pace guard must
#: never refuse one: refusing a free request buys no credits back and would
#: block `arm_budget_guard`, which is how the guard learns what has been spent.
FREE_PATH_SUFFIXES = ("/sports", "/events")
ODDS_FORMAT = "decimal"  # §8 — never change this without re-reading §1
DEFAULT_REGIONS = "us"
TIMEOUT_S = 15.0
MAX_ATTEMPTS = 4  # §8: "back off ×2 up to 4 tries"
INITIAL_BACKOFF_S = 1.0
DEFAULT_FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures"
RECORD_FIXTURES_ENV = "EDGELINE_RECORD_FIXTURES"


@register_provider
class TheOddsApiProvider:
    """v1 odds feed. One instance owns one ``httpx.AsyncClient``."""

    key = "the_odds_api"

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = BASE_URL,
        timeout_s: float = TIMEOUT_S,
        max_attempts: int = MAX_ATTEMPTS,
        initial_backoff_s: float = INITIAL_BACKOFF_S,
        client: httpx.AsyncClient | None = None,
        record_fixtures: bool | None = None,
        fixture_dir: Path | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        monthly_budget: int | None = None,
        pace_headroom: float = DEFAULT_PACE_HEADROOM,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.max_attempts = max_attempts
        self.initial_backoff_s = initial_backoff_s
        self._client = client
        self._owns_client = client is None
        self.record_fixtures = (
            _env_flag(RECORD_FIXTURES_ENV) if record_fixtures is None else record_fixtures
        )
        self.fixture_dir = fixture_dir or DEFAULT_FIXTURE_DIR
        self._sleep = sleep
        #: Whatever the last response's headers reported (§8).
        self.quota = QuotaStatus()
        #: `quota_monthly_budget` (§3.2). `None` disables the pace guard, which
        #: is what tests and the fixture recorder want. The scheduler refreshes
        #: it from settings each tick, so changing it in the UI takes effect
        #: without a restart.
        self.monthly_budget = monthly_budget
        self.pace_headroom = pace_headroom
        self._now = now

    # ---- §8 endpoint table -------------------------------------------------

    async def list_sports(self) -> ProviderResponse:
        return await self._request("sports", "/sports", {})

    async def arm_budget_guard(self) -> QuotaStatus:
        """Learn what has been spent, for free, before spending anything.

        `_check_pace` needs `x-requests-used`, which only arrives on a response —
        so a freshly started process would get one unguarded paid request, and a
        process that restarts often would get one each time. `/sports` costs
        nothing and returns the quota headers, so this buys the guard its
        starting number at no cost. Failures are swallowed: an unarmed guard is
        the behaviour we already had, and refusing to start the worker because a
        courtesy call failed would be worse than the problem.
        """
        try:
            await self.list_sports()
        except Exception:
            log.warning("could not arm the budget guard; first request is unguarded")
        return self.quota

    async def fetch_odds(
        self,
        sport_key: str,
        markets: list[str],
        *,
        regions: str = DEFAULT_REGIONS,
    ) -> ProviderResponse:
        return await self._request(
            "odds",
            f"/sports/{sport_key}/odds",
            {
                "regions": regions,
                "markets": ",".join(markets),
                "oddsFormat": ODDS_FORMAT,
            },
            sport_key=sport_key,
        )

    async def fetch_events(self, sport_key: str) -> ProviderResponse:
        return await self._request(
            "events", f"/sports/{sport_key}/events", {}, sport_key=sport_key
        )

    async def fetch_event_odds(
        self,
        sport_key: str,
        event_id: str,
        markets: list[str],
        *,
        regions: str = DEFAULT_REGIONS,
    ) -> ProviderResponse:
        return await self._request(
            "event_odds",
            f"/sports/{sport_key}/events/{event_id}/odds",
            {
                "regions": regions,
                "markets": ",".join(markets),
                "oddsFormat": ODDS_FORMAT,
            },
            sport_key=sport_key,
        )

    async def fetch_scores(self, sport_key: str, *, days_from: int = 2) -> ProviderResponse:
        return await self._request(
            "scores",
            f"/sports/{sport_key}/scores",
            {"daysFrom": days_from},
            sport_key=sport_key,
        )

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    # ---- HTTP policy (§8) --------------------------------------------------

    async def _request(
        self,
        endpoint: str,
        path: str,
        params: dict[str, Any],
        *,
        sport_key: str | None = None,
    ) -> ProviderResponse:
        self._check_pace(path)
        url = f"{self.base_url}{path}"
        query = {"apiKey": self._resolve_key(), **params}
        backoff = self.initial_backoff_s
        client = self._get_client()

        for attempt in range(1, self.max_attempts + 1):
            try:
                response = await client.get(url, params=query)
            except httpx.HTTPError as exc:
                # Transport-level failure is indistinguishable from a sick
                # upstream, so it takes the 5xx path: skip the cycle, keep going.
                raise ProviderUnavailable(
                    f"The Odds API {path} unreachable: {type(exc).__name__}"
                ) from exc

            status = response.status_code

            if status == 401:
                raise self._explain_401(path, response)

            if status == 429:
                if attempt < self.max_attempts:
                    log.warning(
                        "The Odds API %s rate-limited (429), attempt %d/%d, "
                        "backing off %.1fs",
                        path,
                        attempt,
                        self.max_attempts,
                        backoff,
                    )
                    await self._sleep(backoff)
                    backoff *= 2
                    continue
                raise ProviderRateLimited(
                    f"The Odds API {path} still rate-limited after "
                    f"{self.max_attempts} attempts"
                )

            if status >= 500:
                raise ProviderUnavailable(
                    f"The Odds API {path} returned {status}; skipping cycle"
                )

            if status >= 400:
                raise ProviderError(f"The Odds API {path} returned {status}")

            self.quota = QuotaStatus.from_headers(response.headers)
            payload = response.json()

            if self.record_fixtures:
                self._record(endpoint, sport_key, payload)

            return ProviderResponse(
                provider_key=self.key,
                endpoint=endpoint,
                payload=payload,
                quota=self.quota,
                fetched_at=utc_now_iso(),
                sport_key=sport_key,
            )

        # Unreachable: the loop either returns or raises on its final attempt.
        raise ProviderError(f"The Odds API {path} exhausted attempts without a verdict")

    def _check_pace(self, path: str) -> None:
        """Refuse a request that would spend past this month's own pace.

        Two facts, no model: `x-requests-used` as the provider last reported it,
        and where we are in the calendar month. If a third of the month has gone
        and four fifths of the allowance is spent, something is wrong — and this
        says so without needing to know *what*, which is the whole point. The
        §13 projection is a model; it knew about one of the three jobs that
        spend, and read 360/500 while the real burn was ~6 credits a minute.

        `None` budget disables it, and `quota.used` is `None` until a response
        has been seen — so a fresh process gets one unguarded request. Call the
        free `/sports` endpoint first to arm it (see `arm_budget_guard`).
        """
        budget = self.monthly_budget
        used = self.quota.used
        if not budget or used is None:
            return
        if path.endswith(FREE_PATH_SUFFIXES):
            return

        if used >= budget:
            raise ProviderBudgetExceeded(
                f"refusing {path}: {used} of {budget} monthly credits already "
                f"spent. Nothing was sent. Raise `quota_monthly_budget` (T4.1) "
                f"or set `offline_mode` to keep working without the provider."
            )

        elapsed = _month_elapsed_fraction(self._now())
        allowed = budget * min(1.0, elapsed + self.pace_headroom)
        if used > allowed:
            raise ProviderBudgetExceeded(
                f"refusing {path}: {used} of {budget} monthly credits spent "
                f"({used / budget:.0%}) but only {elapsed:.0%} of the month has "
                f"elapsed, which is past the {self.pace_headroom:.0%} headroom. "
                f"Nothing was sent. Something is spending faster than the month "
                f"can pay for — check what, rather than raising the budget."
            )

    @staticmethod
    def _explain_401(path: str, response: httpx.Response) -> ProviderError:
        """Decide which kind of 401 this is, and say so in the message.

        The Odds API returns 401 both for a bad key and for a spent monthly
        allowance, so the status alone cannot tell them apart — and the second
        is the one a free-tier install actually hits. `x-requests-remaining` is
        the reliable signal when present; the body is the fallback, because the
        listing endpoints that do not report quota still explain themselves.

        Whichever it is, the message carries the numbers. "API key invalid" on a
        key that was valid cost a real investigation its first hour.
        """
        quota = QuotaStatus.from_headers(response.headers)
        try:
            body = response.text.strip()
        except Exception:  # a body that will not decode is not worth failing over
            body = ""
        said = f" Provider said: {body[:200]}" if body else ""

        spent = quota.remaining == 0 or any(
            word in body.lower() for word in ("quota", "usage limit", "upgrade")
        )
        if spent:
            return ProviderQuotaExhausted(
                f"The Odds API {path} refused the request (401): the monthly credit "
                f"allowance is spent (used {quota.used}, remaining {quota.remaining}). "
                f"The key is valid — this resolves when the allowance resets or the "
                f"plan changes, not by retrying. Set `offline_mode` to keep working "
                f"without the provider (§3.2).{said}"
            )
        return ProviderAuthError(
            f"The Odds API {path} rejected the key (401): API key invalid. "
            f"Check ODDS_API_KEY in .env (§3.1).{said}"
        )

    # ---- fixture recorder (§8, debug flag) ---------------------------------

    def _record(self, endpoint: str, sport_key: str | None, payload: Any) -> Path:
        """Write one raw response body to ``tests/fixtures/`` (§8).

        Bodies only — the API key rides in the query string and must never land
        in a file that gets committed. Colons are illegal in Windows filenames,
        so the timestamp is the compact ISO basic form.
        """
        self.fixture_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = self.fixture_dir / f"{sport_key or 'all'}_{endpoint}_{stamp}.json"
        target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log.info("recorded fixture %s", target)
        return target

    # ---- internals ---------------------------------------------------------

    def _resolve_key(self) -> str:
        if self._api_key:
            return self._api_key
        return get_secrets().require("odds_api_key")

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_s))
            self._owns_client = True
        return self._client


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}

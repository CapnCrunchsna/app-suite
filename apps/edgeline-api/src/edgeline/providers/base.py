"""The ``OddsProvider`` protocol and its shared vocabulary — spec §8, §7.2.

The three error types exist because §8 assigns each HTTP failure a *different
pipeline consequence*, and the caller has to be able to tell them apart without
inspecting status codes:

    401 -> ProviderAuthError    kill the cycle, surface "API key invalid" in the UI
    5xx -> ProviderUnavailable  skip this cycle, log, try again next tick
    429 -> ProviderRateLimited  only after the ×2 backoff has been exhausted

``QuotaStatus`` carries what the provider's response headers said. Per §8 the
header is truth: we never track quota by counting our own requests.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


class ProviderError(RuntimeError):
    """Base class for every provider failure the pipeline is expected to handle."""


class ProviderAuthError(ProviderError):
    """401 — credentials rejected. Kills the cycle; retrying cannot help."""


class ProviderUnavailable(ProviderError):
    """5xx or a transport failure — skip this cycle, keep the schedule."""


class ProviderRateLimited(ProviderError):
    """429 that survived the full backoff ladder (§8)."""


@dataclass(frozen=True)
class QuotaStatus:
    """Credit accounting as reported by the provider's own response headers.

    Either field may be ``None`` when the endpoint does not report it (the free
    ``/sports`` listing, for instance). ``None`` means "unknown", never "zero" —
    the §8.4 budget check must not read a missing header as spare capacity.
    """

    used: int | None = None
    remaining: int | None = None

    @classmethod
    def from_headers(cls, headers: Any) -> "QuotaStatus":
        return cls(
            used=_int_or_none(headers.get("x-requests-used")),
            remaining=_int_or_none(headers.get("x-requests-remaining")),
        )


@dataclass(frozen=True)
class ProviderResponse:
    """One decoded provider response plus the quota headers that came with it."""

    provider_key: str
    endpoint: str
    payload: Any
    quota: QuotaStatus
    fetched_at: str
    sport_key: str | None = None


@runtime_checkable
class OddsProvider(Protocol):
    """What the engine requires of any odds feed (§8's endpoint table)."""

    key: str

    async def list_sports(self) -> ProviderResponse: ...

    async def fetch_odds(
        self,
        sport_key: str,
        markets: list[str],
        *,
        regions: str = "us",
    ) -> ProviderResponse: ...

    async def fetch_events(self, sport_key: str) -> ProviderResponse: ...

    async def fetch_event_odds(
        self,
        sport_key: str,
        event_id: str,
        markets: list[str],
        *,
        regions: str = "us",
    ) -> ProviderResponse: ...

    async def fetch_scores(self, sport_key: str, *, days_from: int = 2) -> ProviderResponse: ...

    async def aclose(self) -> None: ...


_REGISTRY: dict[str, type] = {}


def register_provider(cls: type) -> type:
    """Class decorator: make an adapter reachable by its ``key`` (§7.2)."""
    _REGISTRY[cls.key] = cls
    return cls


def get_provider(key: str) -> type:
    """Look up a registered adapter class. Unknown keys fail loudly, never silently."""
    try:
        return _REGISTRY[key]
    except KeyError:
        known = ", ".join(sorted(_REGISTRY)) or "none registered"
        raise KeyError(f"unknown provider {key!r} (known: {known})") from None


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None

"""Odds providers. The engine talks to the ``OddsProvider`` protocol, never to a
concrete adapter, so a premium feed can be added without touching the pipeline
(§7.2)."""

from __future__ import annotations

from .base import (
    OddsProvider,
    ProviderAuthError,
    ProviderError,
    ProviderRateLimited,
    ProviderResponse,
    ProviderUnavailable,
    QuotaStatus,
    get_provider,
    register_provider,
)

__all__ = [
    "OddsProvider",
    "ProviderAuthError",
    "ProviderError",
    "ProviderRateLimited",
    "ProviderResponse",
    "ProviderUnavailable",
    "QuotaStatus",
    "get_provider",
    "register_provider",
]

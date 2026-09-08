"""System — spec §10, §13.

`/health` is what tells you the worker is alive: §13's heartbeat stamps the
`runtime` settings document every 60 seconds, so a stale `last_heartbeat_at` is
the signal that polling has stopped even though the API is still answering.

`/kill` and `/resume` flip `kill_switch`. Killing tightens a guardrail and is
always allowed; resuming loosens one, so it is logged loudly — §16.2 reserves
that to an explicit user action, and pressing this button is exactly that.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends

from ...indices import PROVIDERS_INDEX, SETTINGS_INDEX
from ..deps import Context, get_context, hits, load_settings_doc, search
from ..models import HealthResponse, KillSwitchResponse

log = logging.getLogger(__name__)
router = APIRouter(prefix="/system", tags=["system"])


@router.get("/health", operation_id="getHealth")
async def health(context: Context = Depends(get_context)) -> HealthResponse:
    settings = await load_settings_doc(context)

    runtime: dict[str, Any] = {}
    try:
        found = await context.client.get(
            index=context.index(SETTINGS_INDEX), id="runtime"
        )
        runtime = found["_source"]
    except Exception:
        runtime = {}

    providers = hits(await search(context, PROVIDERS_INDEX, size=10, query={"match_all": {}}))

    return {
        "paper_mode": settings.paper_mode,
        "kill_switch": settings.kill_switch,
        "runtime": runtime,
        "quota": [
            {
                "provider": provider["id"],
                "quota_used": provider.get("quota_used"),
                "quota_budget": provider.get("quota_budget"),
                "quota_reset_at": provider.get("quota_reset_at"),
            }
            for provider in providers
        ],
        "sports_enabled": settings.sports_enabled,
    }


@router.post("/kill", operation_id="engageKillSwitch")
async def kill(context: Context = Depends(get_context)) -> KillSwitchResponse:
    """Stop alerting. Polling continues, for data continuity (§7.1)."""
    await _set_kill_switch(context, True)
    log.warning("kill switch ENGAGED via the API; alerting paused")
    return {"kill_switch": True}


@router.post("/resume", operation_id="releaseKillSwitch")
async def resume(context: Context = Depends(get_context)) -> KillSwitchResponse:
    await _set_kill_switch(context, False)
    log.warning(
        "kill switch RELEASED via the API; alerting resumed. If §12's daily loss "
        "stop set it, check today's P&L before leaving this off."
    )
    return {"kill_switch": False}


async def _set_kill_switch(context: Context, value: bool) -> None:
    await context.client.update(
        index=context.index(SETTINGS_INDEX),
        id="global",
        doc={"kill_switch": value},
        doc_as_upsert=True,
        refresh="wait_for",
    )

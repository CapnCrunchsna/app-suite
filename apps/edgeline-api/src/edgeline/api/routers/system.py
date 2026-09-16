"""System — spec §10, §13.

`/health` is what tells you the worker is alive: §13's heartbeat stamps the
`runtime` settings document every 60 seconds, so a stale `last_heartbeat_at` is
the signal that polling has stopped even though the API is still answering.

`/kill` and `/resume` flip `kill_switch`. Killing tightens a guardrail and is
always allowed; resuming loosens one, so it is logged loudly — §16.2 reserves
that to an explicit user action, and pressing this button is exactly that.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ...indices import PROVIDERS_INDEX, SETTINGS_INDEX
from ..deps import Context, get_context, get_provider, hits, load_settings_doc, search
from ..models import (
    HealthResponse,
    KillSwitchResponse,
    PollCycleRow,
    PollNowResponse,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/system", tags=["system"])

#: One manual cycle at a time. A second press while the first is still fetching
#: buys the same market twice, and §8.4's budget pays for the cadence rather than
#: for how often someone presses a button.
_poll_in_flight = asyncio.Lock()


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
        "offline_mode": settings.offline_mode,
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


@router.post("/poll", operation_id="pollNow")
async def poll_now(
    context: Context = Depends(get_context),
    provider: Any = Depends(get_provider),
) -> PollNowResponse:
    """Run one featured cycle now — §8.4's "manual trigger", from the UI.

    **Why a button exists at all.** §13's cadence is an interval anchored to
    worker start, so the two daily polls land at whatever times the process
    happened to be restarted, and a slot inside a laptop sleep runs on wake
    rather than while the games are still pre-game. A cycle is only worth
    anything before first pitch (§7.4 refuses an event that has started), so the
    person watching needs a way to put one where they want it.

    It is an ordinary poll in every other respect: `markets × regions` credits
    per enabled sport, through the same pace guard as every other request, and
    it stamps `last_poll_at` the way a scheduled poll does. That stamp matters —
    a manual cycle *is* a poll, so `poll_is_due` must see it or the next worker
    restart pays for another one.

    Settings come from the engine's strict loader rather than
    `load_settings_doc`: this is the one route that spends money, and a read that
    fails must not become a set of §3.2 defaults — that would hand the pace guard
    the free tier's budget, or turn off an `offline_mode` someone set on purpose.

    §16.1 is untouched. This fetches prices and writes documents.
    """
    from ...engine import load_settings, run_once
    from ...providers.base import ProviderBudgetExceeded
    from ...scheduler import record_quota, record_run

    if _poll_in_flight.locked():
        raise HTTPException(status_code=409, detail="a manual poll is already running")

    async with _poll_in_flight:
        settings = await load_settings(context.client, prefix=context.prefix)
        if not settings.sports_enabled:
            raise HTTPException(
                status_code=409,
                detail="no sport is enabled; set sports_enabled (§3.2) first",
            )

        if not settings.offline_mode:
            # The two lines the worker runs at startup, for the same reason: the
            # guard needs a starting number, and `/sports` costs nothing. Without
            # it this request would be the one unguarded request per press.
            if hasattr(provider, "monthly_budget"):
                provider.monthly_budget = settings.quota_monthly_budget
            if hasattr(provider, "arm_budget_guard"):
                await provider.arm_budget_guard()

        response = PollNowResponse()
        polled = False
        refusal: ProviderBudgetExceeded | None = None

        for sport_key in settings.sports_enabled:
            try:
                report = await run_once(
                    provider,
                    context.client,
                    sport_key=sport_key,
                    prefix=context.prefix,
                    settings=settings,
                )
            except ProviderBudgetExceeded as refused:
                # Nothing was sent. Stop asking for the remaining sports — the
                # guard's answer will not change between them.
                refusal = refused
                break

            response.cycles.append(
                PollCycleRow(
                    sport_key=report.sport_key,
                    snapshots=report.snapshots,
                    events=report.events,
                    quarantined=report.quarantined,
                    detections=len(report.detections),
                    alerted=len(report.alerted),
                    enabled_books=report.enabled_books,
                    offline=report.offline,
                    skipped_reason=report.skipped_reason,
                )
            )
            if report.offline:
                continue
            polled = True
            response.snapshots += report.snapshots
            response.detections += len(report.detections)
            response.alerted += len(report.alerted)
            response.quota_used = report.quota_used
            response.quota_remaining = report.quota_remaining

        response.offline = bool(response.cycles) and all(
            row.offline for row in response.cycles
        )

        if polled:
            # Stamped for what actually landed, even when a later sport was
            # refused: the poll that happened happened.
            await record_run(context.client, prefix=context.prefix, job="poll")
            await record_quota(
                context.client, provider.key, provider.quota, prefix=context.prefix
            )
            log.info(
                "manual poll: %d snapshots, %d detections, %d alerted (quota %s/%s)",
                response.snapshots,
                response.detections,
                response.alerted,
                response.quota_used,
                settings.quota_monthly_budget,
            )

        if refusal is not None:
            raise HTTPException(status_code=409, detail=str(refusal))
        return response


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

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
    PollPlanStatus,
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
        "poll_plan": _poll_plan(settings),
    }


def _poll_plan(settings) -> PollPlanStatus:
    """§13's cadence as the stored settings define it."""
    from ...scheduler import PLAN_TIMEZONE, scheduled_polls, sports_for_poll_now

    polls = scheduled_polls(settings)
    return PollPlanStatus(
        mode="schedule" if polls else "interval",
        polls_per_week=len(polls) if polls else None,
        sports=list(dict.fromkeys(poll.sport for poll in polls)),
        poll_now_sports=sports_for_poll_now(settings),
        timezone=PLAN_TIMEZONE,
    )


@router.post("/poll", operation_id="pollNow")
async def poll_now(
    context: Context = Depends(get_context),
    provider: Any = Depends(get_provider),
) -> PollNowResponse:
    """Run one featured cycle now — §8.4's "manual trigger", from the UI.

    **Why a button exists at all.** A cycle is only worth anything before the
    games start (§7.4 refuses an event that has), and no cadence knows about
    the news that makes one worth buying *now*. The interval §13 started with
    landed wherever the worker was last restarted; the weekly plan that replaced
    it on 2026-09-23 lands at fixed times, which is better and still not this.

    **What it polls.** Today's sports in the weekly plan, by the plan's Eastern
    calendar — a press on a Tuesday buys Tuesday's slate — or `sports_enabled`
    when the plan is empty, not in effect, or has nothing today
    (`sports_for_poll_now`).

    It is an ordinary poll in every other respect: `markets × regions` credits
    per sport, through the same pace guard as every other request, and it
    stamps the poll the way a scheduled one does — globally and per sport, with
    `manual` as its source. That stamp matters: a manual cycle *is* a poll, so
    `poll_is_due` must see it or the next worker restart pays for another, and a
    slot of the plan due within three hours stands down on it rather than buying
    the same sport twice.

    Settings come from the engine's strict loader rather than
    `load_settings_doc`: this is the one route that spends money, and a read that
    fails must not become a set of §3.2 defaults — that would hand the pace guard
    the free tier's budget, or turn off an `offline_mode` someone set on purpose.

    §16.1 is untouched. This fetches prices and writes documents.
    """
    from ...engine import load_settings, run_once
    from ...providers.base import ProviderBudgetExceeded
    from ...scheduler import record_poll, record_quota, sports_for_poll_now

    if _poll_in_flight.locked():
        raise HTTPException(status_code=409, detail="a manual poll is already running")

    async with _poll_in_flight:
        settings = await load_settings(context.client, prefix=context.prefix)
        sports = sports_for_poll_now(settings)
        if not sports:
            raise HTTPException(
                status_code=409,
                detail=(
                    "nothing to poll: the weekly plan has no sport today and none "
                    "is enabled; set poll_schedule or sports_enabled (§3.2) first"
                ),
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

        for sport_key in sports:
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
            # Per sport, as each lands, so a refusal for a later sport leaves the
            # earlier ones stamped: the poll that happened happened.
            await record_poll(
                context.client, prefix=context.prefix, sport_key=sport_key, source="manual"
            )
            response.snapshots += report.snapshots
            response.detections += len(report.detections)
            response.alerted += len(report.alerted)
            response.quota_used = report.quota_used
            response.quota_remaining = report.quota_remaining

        response.offline = bool(response.cycles) and all(
            row.offline for row in response.cycles
        )

        if polled:
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

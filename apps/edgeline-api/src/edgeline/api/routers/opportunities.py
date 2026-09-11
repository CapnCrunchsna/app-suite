"""Opportunities — spec §10. The detection table."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ...indices import EVENTS_INDEX, OPPORTUNITIES_INDEX
from ..deps import Context, get_context, hits, mget, search
from ..models import OpportunityRow

router = APIRouter(prefix="/opportunities", tags=["opportunities"])


@router.get("", operation_id="listOpportunities")
async def list_opportunities(
    status: Literal["open", "alerted", "closed", "expired"] | None = None,
    type: Literal["ev", "arb"] | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    context: Context = Depends(get_context),
) -> list[OpportunityRow]:
    """Newest first. `status` and `type` are the §4.3 enums, validated by name so
    a typo is a 422 rather than a silently empty table."""
    filters: list[dict[str, Any]] = []
    if status:
        filters.append({"term": {"status": status}})
    if type:
        filters.append({"term": {"type": type}})

    response = await search(
        context,
        OPPORTUNITIES_INDEX,
        size=limit,
        query={"bool": {"filter": filters}} if filters else {"match_all": {}},
        sort=[{"detected_at": {"order": "desc"}}],
    )
    return await attach_events(context, hits(response))


async def attach_events(
    context: Context, rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Join each row's `edgeline-events` document in as `event`.

    §4.3 makes an opportunity's `event_id` the events index `_id`, so this is one
    `mget` over the ids the caller already has — shared with the recommendations
    router, which embeds opportunities and needs them to carry the matchup for
    exactly the same reason.
    """
    if not rows:
        return rows
    events = await mget(context, EVENTS_INDEX, [row.get("event_id", "") for row in rows])
    for row in rows:
        # `mget` folds the document's own `_id` in; the event's id is already on
        # the opportunity as `event_id`, and repeating it inside the nested object
        # would put the same string on the row twice under two names.
        found = events.get(row.get("event_id", ""))
        row["event"] = {key: value for key, value in found.items() if key != "id"} if found else None
    return rows

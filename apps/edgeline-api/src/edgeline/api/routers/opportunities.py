"""Opportunities — spec §10. The detection table."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from ...indices import OPPORTUNITIES_INDEX
from ..deps import Context, get_context, hits, search

router = APIRouter(prefix="/opportunities", tags=["opportunities"])


@router.get("")
async def list_opportunities(
    status: Literal["open", "alerted", "closed", "expired"] | None = None,
    type: Literal["ev", "arb"] | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    context: Context = Depends(get_context),
) -> list[dict[str, Any]]:
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
    return hits(response)

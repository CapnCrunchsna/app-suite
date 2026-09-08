"""Sportsbooks — spec §10, §4.3.

This is where a human supplies what §16.3 forbids the implementer from guessing:
`md_licensed`, once Maryland licensure is actually verified, and `link_templates`,
once a real event URL has been opened and generalised (T4.3). Both arrive here
because a person checked, which is the only way they may arrive at all.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...indices import SPORTSBOOKS_INDEX
from ..deps import Context, get_context, hits, search
from ..models import SportsbookRow

log = logging.getLogger(__name__)
router = APIRouter(prefix="/sportsbooks", tags=["sportsbooks"])


class SportsbookPatch(BaseModel):
    """Every field optional — this is a patch, not a replacement."""

    display_name: str | None = None
    enabled: bool | None = None
    md_licensed: bool | None = None
    priority: int | None = Field(default=None, ge=0)
    link_templates: dict[str, Any] | None = None


@router.get("", operation_id="listSportsbooks")
async def list_sportsbooks(context: Context = Depends(get_context)) -> list[SportsbookRow]:
    response = await search(
        context, SPORTSBOOKS_INDEX, size=100, sort=[{"priority": {"order": "asc"}}]
    )
    return hits(response)


@router.patch("/{key}", operation_id="patchSportsbook")
async def patch_sportsbook(
    key: str, patch: SportsbookPatch, context: Context = Depends(get_context)
) -> SportsbookRow:
    doc = patch.model_dump(exclude_none=True)
    if not doc:
        raise HTTPException(status_code=400, detail="empty patch")

    if doc.get("enabled"):
        # Worth a log line: enabling a book is what makes it eligible for real
        # recommendations, and §4.3 asks for licensure to be verified first.
        log.info("sportsbook %s enabled (md_licensed=%s)", key, doc.get("md_licensed"))

    try:
        await context.client.update(
            index=context.index(SPORTSBOOKS_INDEX),
            id=key,
            doc=doc,
            refresh="wait_for",
        )
    except Exception:
        raise HTTPException(status_code=404, detail=f"sportsbook {key} not found") from None

    found = await context.client.get(index=context.index(SPORTSBOOKS_INDEX), id=key)
    return {"id": key, **found["_source"]}

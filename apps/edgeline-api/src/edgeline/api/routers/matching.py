"""Quarantine queue — spec §10, §7.3.

Everything the normalizer refused to guess at lands here with its raw JSON.
Resolution is manual (§7.3), which is the point: these are the fragments where
guessing would have produced a plausible wrong selection, and a human deciding is
the only correct fix.

Resolving marks `resolved: true` rather than deleting. §4.4 rule 5 does permit
deleting from this index — it is the only one it permits — but a resolved row is
the evidence of what the feed sent and why it did not parse, which is exactly
what you want when the same shape turns up again.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from ...indices import UNMATCHED_INDEX
from ..deps import Context, get_context, hits, search

router = APIRouter(prefix="/matching", tags=["matching"])


@router.get("")
async def list_unmatched(
    resolved: bool = False,
    limit: int = Query(default=200, ge=1, le=1000),
    context: Context = Depends(get_context),
) -> list[dict[str, Any]]:
    response = await search(
        context,
        UNMATCHED_INDEX,
        size=limit,
        query={"bool": {"filter": [{"term": {"resolved": resolved}}]}},
        sort=[{"created_at": {"order": "desc"}}],
    )
    return hits(response)


@router.post("/{unmatched_id}/resolve")
async def resolve(
    unmatched_id: str, context: Context = Depends(get_context)
) -> dict[str, Any]:
    try:
        await context.client.update(
            index=context.index(UNMATCHED_INDEX),
            id=unmatched_id,
            doc={"resolved": True},
            refresh="wait_for",
        )
    except Exception:
        raise HTTPException(
            status_code=404, detail=f"unmatched row {unmatched_id} not found"
        ) from None
    found = await context.client.get(index=context.index(UNMATCHED_INDEX), id=unmatched_id)
    return {"id": unmatched_id, **found["_source"]}

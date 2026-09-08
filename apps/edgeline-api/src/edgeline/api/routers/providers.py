"""Providers — spec §10, §4.3. Enable/disable, budget, quota status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ...indices import PROVIDERS_INDEX
from ..deps import Context, get_context, hits, search
from ..models import ProviderRow

router = APIRouter(prefix="/providers", tags=["providers"])


class ProviderPatch(BaseModel):
    display_name: str | None = None
    enabled: bool | None = None
    quota_budget: int | None = Field(default=None, ge=0)
    config: dict[str, Any] | None = None


@router.get("", operation_id="listProviders")
async def list_providers(context: Context = Depends(get_context)) -> list[ProviderRow]:
    return hits(await search(context, PROVIDERS_INDEX, size=50, query={"match_all": {}}))


@router.patch("/{key}", operation_id="patchProvider")
async def patch_provider(
    key: str, patch: ProviderPatch, context: Context = Depends(get_context)
) -> ProviderRow:
    doc = patch.model_dump(exclude_none=True)
    if not doc:
        raise HTTPException(status_code=400, detail="empty patch")

    # `quota_used` is deliberately not patchable: §8 makes the provider's own
    # response header the sole source of truth for it, and a hand-edited value
    # would desynchronise the §8.4 budget check from reality.
    await context.client.update(
        index=context.index(PROVIDERS_INDEX),
        id=key,
        doc=doc,
        doc_as_upsert=True,
        refresh="wait_for",
    )
    found = await context.client.get(index=context.index(PROVIDERS_INDEX), id=key)
    return {"id": key, **found["_source"]}

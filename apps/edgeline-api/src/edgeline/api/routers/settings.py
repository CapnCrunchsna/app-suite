"""Settings — spec §10, §3.2.

`PUT` is a **patch**: the body carries only the keys being changed, they are
validated against §3.2's key set and types, and the merged result is written
whole so the stored document is always a complete, valid settings map.

Unknown keys are rejected rather than ignored. The settings index is
`dynamic: false` (§4.2), so a typo'd key would be accepted by Elasticsearch,
stored, and then silently ignored by every reader — a setting that looks saved
and does nothing.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from ...config import Settings
from ...indices import SETTINGS_INDEX
from ..deps import Context, get_context, load_settings_doc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
async def read_settings(context: Context = Depends(get_context)) -> dict[str, Any]:
    """The full §3.2 map, defaults filled in for anything unseeded."""
    return (await load_settings_doc(context)).model_dump()


@router.put("")
async def update_settings(
    patch: dict[str, Any], context: Context = Depends(get_context)
) -> dict[str, Any]:
    unknown = sorted(set(patch) - set(Settings.model_fields))
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown settings keys (not in §3.2): {unknown}",
        )

    current = await load_settings_doc(context)
    try:
        merged = Settings.model_validate({**current.model_dump(), **patch})
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from None

    if current.paper_mode and not merged.paper_mode:
        # §16.2 and §15's Phase 4 gate: only the user may do this, and it is the
        # single most consequential flag in the system. Loud, and on the record.
        log.warning(
            "paper_mode set FALSE via the API. Recommendations are now live-money "
            "advice. §15's go-live gate expects a reviewed CLV report first."
        )

    await context.client.update(
        index=context.index(SETTINGS_INDEX),
        id="global",
        doc=merged.model_dump(),
        doc_as_upsert=True,
        refresh="wait_for",  # §4.4 rule 2: the UI reads this straight back
    )
    return merged.model_dump()

"""Settings — spec §10, §3.2.

`PUT` is a **patch**: the body carries only the keys being changed, they are
validated against §3.2's key set and types, and the merged result is written
whole so the stored document is always a complete, valid settings map.

Unknown keys are rejected rather than ignored. The settings index is
`dynamic: false` (§4.2), so a typo'd key would be accepted by Elasticsearch,
stored, and then silently ignored by every reader — a setting that looks saved
and does nothing.

Writing the merge whole makes the read it merges into part of the write, so
`PUT` reads strictly and `GET`, which only displays, keeps the lenient loader
(2026-09-23). `_stored_settings` has the why.
"""

from __future__ import annotations

import logging
from typing import Any

from elasticsearch import ApiError, TransportError
from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from ...config import Settings
from ...indices import SETTINGS_INDEX
from ..deps import Context, get_context, load_settings_doc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", operation_id="getSettings")
async def read_settings(context: Context = Depends(get_context)) -> Settings:
    """The full §3.2 map, defaults filled in for anything unseeded."""
    return (await load_settings_doc(context)).model_dump()


@router.put("", operation_id="updateSettings")
async def update_settings(
    patch: dict[str, Any], context: Context = Depends(get_context)
) -> Settings:
    """Merge a patch of §3.2 keys into the stored map and write the result whole.

    503, with nothing written, when the stored map cannot be read: the merge
    needs it, and §3.2's defaults in its place would reset every key the patch
    did not name.
    """
    unknown = sorted(set(patch) - set(Settings.model_fields))
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown settings keys (not in §3.2): {unknown}",
        )

    current = await _stored_settings(context)
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


async def _stored_settings(context: Context) -> Settings:
    """What a patch merges into, read strictly because the merge is written whole.

    Not `load_settings_doc`, which answers §3.2's defaults for *any* failed read.
    Merged into and written back, those defaults are a reset of every key the
    patch did not name — `kill_switch` and `offline_mode` back off,
    `quota_monthly_budget` back to the free tier's, `poll_schedule` back to the
    default plan — so a save of `kelly_fraction` could quietly resume a system
    someone had paused. Every sleep/resume on this laptop drops one
    Elasticsearch request (measured 2026-09-15), and a save whose read was that
    request would have written them.

    The engine's loader treats only an absent document as unseeded, and that is
    still an answer: a fresh install has to be configurable before anything has
    seeded it. Any other failure from the datastore is a 503 with nothing
    written. Anything else — a stored map that no longer validates, say — is not
    an outage, and stays a 500.
    """
    from ...engine import load_settings

    # The client's two roots: no answer at all (`TransportError` — a timeout, a
    # refused connection) and an error answer (`ApiError` — a 503 while shards
    # recover). `NotFoundError` is an `ApiError` too, but `load_settings` has
    # already turned that one into the defaults.
    try:
        return await load_settings(context.client, prefix=context.prefix)
    except (ApiError, TransportError) as exc:
        log.warning("settings read failed (%s); the save wrote nothing", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail=(
                f"could not read the stored settings ({type(exc).__name__}), "
                "so nothing was saved; try again in a moment"
            ),
        ) from exc

"""Bankroll — spec §10, §4.4 rule 3.

**Balances are aggregations, never stored fields.** The ledger is append-only
deltas and the balance is a `sum` over them, because Elasticsearch has no
multi-document transactions and a stored running total would drift the first time
a write half-failed. That is a design decision from §4.4, not an implementation
detail, so this endpoint computes and never caches.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ...indices import BANKROLL_LEDGER_INDEX
from ...schemas import utc_now_iso
from ..deps import Context, get_context, hits, search

log = logging.getLogger(__name__)
router = APIRouter(prefix="/bankroll", tags=["bankroll"])

#: §4.3's reason enum, minus the two that only grading may write. A human
#: adjusting the ledger by hand is making a deposit, a withdrawal or a
#: correction; recording a bet outcome is §12's job and its provenance matters.
MANUAL_REASONS = ("deposit", "withdrawal", "manual_adjust")


class AdjustBody(BaseModel):
    book_key: str = Field(min_length=1)
    delta_cents: int
    reason: Literal["deposit", "withdrawal", "manual_adjust"] = "manual_adjust"


@router.get("")
async def read_bankroll(
    limit: int = Query(default=200, ge=1, le=1000),
    context: Context = Depends(get_context),
) -> dict[str, Any]:
    """Total and per-book balances as sum aggregations, plus recent ledger rows."""
    response = await search(
        context,
        BANKROLL_LEDGER_INDEX,
        size=limit,
        query={"match_all": {}},
        sort=[{"@timestamp": {"order": "desc"}}],
        aggs={
            "total_cents": {"sum": {"field": "delta_cents"}},
            "by_book": {
                "terms": {"field": "book_key", "size": 50},
                "aggs": {"balance_cents": {"sum": {"field": "delta_cents"}}},
            },
        },
    )
    aggregations = response.get("aggregations") or {}
    by_book = [
        {"book_key": bucket["key"], "balance_cents": int(bucket["balance_cents"]["value"] or 0)}
        for bucket in aggregations.get("by_book", {}).get("buckets", [])
    ]
    return {
        "total_cents": int((aggregations.get("total_cents") or {}).get("value") or 0),
        "by_book": by_book,
        "entries": hits(response),
    }


@router.post("/adjust", status_code=201)
async def adjust(
    body: AdjustBody, context: Context = Depends(get_context)
) -> dict[str, Any]:
    """Append a manual ledger row. Deltas only — there is no balance to set."""
    document = {
        "book_key": body.book_key,
        "delta_cents": body.delta_cents,
        "reason": body.reason,
        "ref_result_id": "",
        "@timestamp": utc_now_iso(),
    }
    created = await context.client.index(
        index=context.index(BANKROLL_LEDGER_INDEX),
        document=document,
        refresh="wait_for",
    )
    log.info(
        "manual ledger entry: %s %+d cents (%s)",
        body.book_key,
        body.delta_cents,
        body.reason,
    )
    return {"id": created["_id"], **document}

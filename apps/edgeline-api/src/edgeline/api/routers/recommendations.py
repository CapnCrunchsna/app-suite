"""Recommendations — spec §10, §9.3.

`POST /{id}/confirm` is the UI's equivalent of §9.3's ✅ button: it records that
**a human placed a bet**, with `confirmed_via='ui'`. It does not place anything,
and cannot — §16.1 makes that an architectural boundary, not a missing feature.

The row it writes is what promotes a recommendation from paper to executed, which
is what lets §12 step 5 move the bankroll ledger. So the stake and odds in the
body are the *actual* ones the human got, not the ones we recommended; they will
differ, and that difference is the point of recording them.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ...indices import (
    BETS_INDEX,
    OPPORTUNITIES_INDEX,
    RECOMMENDATIONS_INDEX,
    RESULTS_INDEX,
)
from ...schemas import utc_now_iso
from ..deps import Context, get_context, hits, search
from ..models import BetRow, RecommendationRow

log = logging.getLogger(__name__)
router = APIRouter(prefix="/recommendations", tags=["recommendations"])


class ConfirmBody(BaseModel):
    """What the human actually got on the book."""

    stake_actual_cents: int = Field(ge=0)
    odds_actual_decimal: float = Field(gt=1.0)


@router.get("", operation_id="listRecommendations")
async def list_recommendations(
    paper: bool | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    context: Context = Depends(get_context),
) -> list[RecommendationRow]:
    """History, with each row's opportunity and result joined in.

    Elasticsearch has no joins, so this is two `mget`s over the ids the first
    query returned — bounded by `limit` and therefore cheap, and far better than
    making the UI issue N+1 requests to assemble a table.
    """
    filters: list[dict[str, Any]] = []
    if paper is not None:
        filters.append({"term": {"paper": paper}})
    date_range: dict[str, str] = {}
    if from_:
        date_range["gte"] = from_
    if to:
        date_range["lte"] = to
    if date_range:
        filters.append({"range": {"sent_at": date_range}})

    response = await search(
        context,
        RECOMMENDATIONS_INDEX,
        size=limit,
        query={"bool": {"filter": filters}} if filters else {"match_all": {}},
        sort=[{"sent_at": {"order": "desc"}}],
    )
    rows = hits(response)
    if not rows:
        return []

    opportunities = await _mget(
        context, OPPORTUNITIES_INDEX, [r.get("opportunity_id", "") for r in rows]
    )
    results = await _mget(context, RESULTS_INDEX, [r["id"] for r in rows])

    for row in rows:
        row["opportunity"] = opportunities.get(row.get("opportunity_id", ""))
        row["result"] = results.get(row["id"])
    return rows


@router.post("/{recommendation_id}/confirm", status_code=201, operation_id="confirmRecommendation")
async def confirm(
    recommendation_id: str,
    body: ConfirmBody,
    context: Context = Depends(get_context),
) -> BetRow:
    try:
        await context.client.get(
            index=context.index(RECOMMENDATIONS_INDEX), id=recommendation_id
        )
    except Exception:
        raise HTTPException(
            status_code=404, detail=f"recommendation {recommendation_id} not found"
        ) from None

    document = {
        "recommendation_id": recommendation_id,
        "confirmed_via": "ui",
        "stake_actual_cents": body.stake_actual_cents,
        "odds_actual_decimal": body.odds_actual_decimal,
        "placed_at": utc_now_iso(),
    }
    created = await context.client.index(
        index=context.index(BETS_INDEX), document=document, refresh="wait_for"
    )
    log.info(
        "bet recorded for recommendation %s: %d cents at %.4f (placed by a human)",
        recommendation_id,
        body.stake_actual_cents,
        body.odds_actual_decimal,
    )
    return {"id": created["_id"], **document}


async def _mget(
    context: Context, index: str, ids: list[str]
) -> dict[str, dict[str, Any]]:
    wanted = sorted({doc_id for doc_id in ids if doc_id})
    if not wanted:
        return {}
    try:
        found = await context.client.mget(index=context.index(index), ids=wanted)
    except Exception:
        return {}
    # Fold `_id` in, exactly as `hits()` does for a search: the joined
    # opportunity is a row the UI addresses by id like any other.
    return {
        doc["_id"]: {"id": doc["_id"], **doc["_source"]}
        for doc in found["docs"]
        if doc.get("found")
    }

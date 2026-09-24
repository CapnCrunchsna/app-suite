"""Which settled results may count as evidence — spec §12, §15's go-live gate.

`python -m edgeline.audit` lists what it would exclude; `--apply` marks it.

**Why this exists.** Every opportunity stored before 2026-09-11 was detected after
its event had already started — dead pre-game lines books had not taken down,
like betPARX showing 7.5 on the Marlins 3h40m after first pitch. Five of them
became paper recommendations and were settled, and they were still in the Results
page's figures on 2026-09-23: −$39.03 and a 33% hit rate, over a real record of
one bet, +$6.52. That page is what the go-live gate reads.

`detect_opportunities` has refused a started event since the fix, so no new row of
this kind can appear. This marks the old ones, and it decides from the data rather
than from a list of ids: a result counts as evidence only if the opportunity
behind it was detected before its event's `commence_time`, which is exactly the
rule detection now enforces. Rows are marked, never deleted — `excluded_reason`
says why, and the summary reports how many it left out.

Idempotent, and conservative in one direction: a result whose recommendation,
opportunity or event cannot be found is left counted. Excluding evidence needs a
reason that can be shown, not the absence of one.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from typing import Any

from .dedup import parse_iso
from .indices import (
    EVENTS_INDEX,
    OPPORTUNITIES_INDEX,
    RECOMMENDATIONS_INDEX,
    RESULTS_INDEX,
    with_prefix,
)

log = logging.getLogger(__name__)

DETECTED_AFTER_START = "detected_after_start"


async def _mget(client, index: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    wanted = sorted({doc_id for doc_id in ids if doc_id})
    if not wanted:
        return {}
    found = await client.mget(index=index, ids=wanted)
    return {doc["_id"]: doc["_source"] for doc in found["docs"] if doc.get("found")}


async def find_results_detected_after_start(client, *, prefix: str) -> list[str]:
    """Result ids whose opportunity was detected at or after its event started."""
    response = await client.search(
        index=with_prefix(RESULTS_INDEX, prefix),
        size=10_000,
        query={"bool": {"must_not": [{"exists": {"field": "excluded_reason"}}]}},
        source=False,
    )
    # A result's `_id` is its recommendation's id (§12 step 2).
    result_ids = [hit["_id"] for hit in response["hits"]["hits"]]

    recommendations = await _mget(
        client, with_prefix(RECOMMENDATIONS_INDEX, prefix), result_ids
    )
    opportunities = await _mget(
        client,
        with_prefix(OPPORTUNITIES_INDEX, prefix),
        [rec.get("opportunity_id", "") for rec in recommendations.values()],
    )
    events = await _mget(
        client,
        with_prefix(EVENTS_INDEX, prefix),
        [opp.get("event_id", "") for opp in opportunities.values()],
    )

    stale: list[str] = []
    for result_id in result_ids:
        opportunity = opportunities.get(
            recommendations.get(result_id, {}).get("opportunity_id", "")
        )
        if not opportunity:
            continue
        event = events.get(opportunity.get("event_id", ""))
        detected, commence = opportunity.get("detected_at"), (event or {}).get("commence_time")
        if not detected or not commence:
            continue
        if parse_iso(detected) >= parse_iso(commence):
            stale.append(result_id)
    return stale


async def exclude_results_detected_after_start(client, *, prefix: str) -> list[str]:
    """Mark those results `excluded_reason: detected_after_start`. Returns their ids."""
    stale = await find_results_detected_after_start(client, prefix=prefix)
    for result_id in stale:
        await client.update(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=result_id,
            doc={"excluded_reason": DETECTED_AFTER_START},
            refresh="wait_for",
        )
    return stale


async def _run(apply: bool) -> int:
    from .es import close_client, ensure_indices, get_client

    client = get_client()
    try:
        # Additive only: gives an install created before `excluded_reason` existed
        # the field, which a `dynamic: strict` index would otherwise refuse.
        await ensure_indices(client)
        prefix = "edgeline-"
        if apply:
            marked = await exclude_results_detected_after_start(client, prefix=prefix)
            verb = "excluded"
        else:
            marked = await find_results_detected_after_start(client, prefix=prefix)
            verb = "would exclude"
        print(f"{verb} {len(marked)} result(s) detected after their event started")
        for result_id in marked:
            print(f"  {result_id}")
        if marked and not apply:
            print("re-run with --apply to mark them")
        return 0
    finally:
        await close_client()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m edgeline.audit",
        description="Mark settled results that must not count as evidence (§12).",
    )
    parser.add_argument("--apply", action="store_true", help="mark them; default is a dry run")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING)
    return asyncio.run(_run(args.apply))


if __name__ == "__main__":
    raise SystemExit(main())

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

**A second rule since 2026-10-01: the repeat alert.** Utah State at betPARX was
recommended at 18:00 and again at 19:30 ET on 2026-09-30, on one opportunity. The
alerts were staked at 12.5 and 13.0, but grading values every recommendation of an
opportunity at the opportunity's own leg — the price it was first detected at, 11.5
here — so the record holds the same bet at the same price twice: one piece of
evidence counted twice. A recommendation is `duplicate_alert` when an earlier one
exists for the same opportunity; grading applies that as it writes each result
(`is_duplicate_recommendation`), and this applies it to results graded before. If
grading ever values a recommendation at its own alert price, this rule must compare
those prices instead.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections import defaultdict
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
DUPLICATE_ALERT = "duplicate_alert"


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


# ---- the repeat alert (2026-10-01) -----------------------------------------


def repeated_recommendations(recommendations: dict[str, dict[str, Any]]) -> set[str]:
    """Ids among `recommendations` that repeat an earlier one of the same opportunity.

    Same opportunity means same graded price: `grading._grade_one` values every
    leg at the opportunity's own `price_decimal`, never the recommendation's, so
    a second recommendation of one opportunity adds a copy of the first one's CLV
    and outcome. The earliest of a run is the one that counts.
    """
    by_opportunity: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for rec_id, source in recommendations.items():
        opportunity_id = source.get("opportunity_id")
        if opportunity_id:
            by_opportunity[opportunity_id].append((source.get("sent_at") or "", rec_id))
    repeats: set[str] = set()
    for runs in by_opportunity.values():
        repeats.update(rec_id for _sent_at, rec_id in sorted(runs)[1:])
    return repeats


async def _recommendations_for(
    client, opportunity_ids: list[str], *, prefix: str
) -> dict[str, dict[str, Any]]:
    """Every recommendation naming one of `opportunity_ids`, keyed by id."""
    wanted = sorted({opportunity_id for opportunity_id in opportunity_ids if opportunity_id})
    if not wanted:
        return {}
    found = await client.search(
        index=with_prefix(RECOMMENDATIONS_INDEX, prefix),
        size=10_000,
        query={"terms": {"opportunity_id": wanted}},
    )
    return {hit["_id"]: hit["_source"] for hit in found["hits"]["hits"]}


async def is_duplicate_recommendation(
    client, rec_id: str, source: dict[str, Any], *, prefix: str
) -> bool:
    """Grading's question for one recommendation: is it a repeat (§12)?

    Raises when the datastore cannot answer; grading decides what not knowing
    means.
    """
    siblings = await _recommendations_for(
        client, [source.get("opportunity_id", "")], prefix=prefix
    )
    siblings[rec_id] = source
    return rec_id in repeated_recommendations(siblings)


async def find_duplicate_results(client, *, prefix: str) -> list[str]:
    """Counted result ids whose recommendation repeats an earlier one."""
    response = await client.search(
        index=with_prefix(RESULTS_INDEX, prefix),
        size=10_000,
        query={"bool": {"must_not": [{"exists": {"field": "excluded_reason"}}]}},
        source=False,
    )
    result_ids = [hit["_id"] for hit in response["hits"]["hits"]]
    recommendations = await _mget(
        client, with_prefix(RECOMMENDATIONS_INDEX, prefix), result_ids
    )
    siblings = await _recommendations_for(
        client,
        [rec.get("opportunity_id", "") for rec in recommendations.values()],
        prefix=prefix,
    )
    repeats = repeated_recommendations({**siblings, **recommendations})
    return [result_id for result_id in result_ids if result_id in repeats]


async def exclude_duplicate_results(client, *, prefix: str) -> list[str]:
    """Mark those results `excluded_reason: duplicate_alert`. Returns their ids."""
    repeats = await find_duplicate_results(client, prefix=prefix)
    for result_id in repeats:
        await client.update(
            index=with_prefix(RESULTS_INDEX, prefix),
            id=result_id,
            doc={"excluded_reason": DUPLICATE_ALERT},
            refresh="wait_for",
        )
    return repeats


#: `(reason, what it means, find, exclude)` — the order the CLI applies them in.
#: Detected-after-start goes first, so a repeat of a dead-line bet is reported
#: under the reason that would have excluded it anyway.
RULES = (
    (
        DETECTED_AFTER_START,
        "detected after their event started",
        find_results_detected_after_start,
        exclude_results_detected_after_start,
    ),
    (
        DUPLICATE_ALERT,
        "repeating an earlier recommendation of the same opportunity",
        find_duplicate_results,
        exclude_duplicate_results,
    ),
)


async def _run(apply: bool) -> int:
    from .es import close_client, ensure_indices, get_client

    client = get_client()
    try:
        # Additive only: gives an install created before `excluded_reason` existed
        # the field, which a `dynamic: strict` index would otherwise refuse.
        await ensure_indices(client)
        prefix = "edgeline-"
        verb = "excluded" if apply else "would exclude"
        listed: set[str] = set()
        for _reason, meaning, find, exclude in RULES:
            # Applied, an earlier rule's marks take its rows out of the next
            # rule's search; dry, the same row is simply not listed twice.
            marked = [
                result_id
                for result_id in await (exclude if apply else find)(client, prefix=prefix)
                if result_id not in listed
            ]
            listed.update(marked)
            print(f"{verb} {len(marked)} result(s) {meaning}")
            for result_id in marked:
                print(f"  {result_id}")
        if listed and not apply:
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

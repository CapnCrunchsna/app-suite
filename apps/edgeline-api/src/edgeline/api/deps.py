"""Shared request dependencies.

One `Context` carries the Elasticsearch client and the index prefix, injected
through FastAPI's dependency system so tests can point the whole API at the
`edgeline-test-` prefix with a single override instead of monkeypatching modules.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..config import Settings, settings_from_document
from ..indices import INDEX_PREFIX, SETTINGS_INDEX, with_prefix
from . import datastore
from .datastore import raise_if_unavailable


@dataclass
class Context:
    """Everything a route needs to reach the datastore."""

    client: Any
    prefix: str = INDEX_PREFIX

    def index(self, name: str) -> str:
        return with_prefix(name, self.prefix)


async def get_context() -> Context:
    """The live context. Overridden wholesale in tests.

    Every route that reaches the datastore comes through here, so this is where
    a down cluster is caught: `datastore.gate` answers in at most half a second, and a
    route never starts the client's 8-second way of finding out (`datastore`).
    """
    from ..es import get_client

    await datastore.gate.check()
    return Context(client=get_client(), prefix=INDEX_PREFIX)


async def get_provider() -> AsyncIterator[Any]:
    """One odds provider per request, closed when the request ends.

    A dependency rather than a module-level instance for the same reason
    `get_context` is one: a test overrides it with a recorder and never reaches
    the live API. Only the manual poll route uses it — every other route in §10
    answers from the datastore, and this one is the seam where a request can
    spend credits.
    """
    from ..providers.the_odds_api import TheOddsApiProvider

    provider = TheOddsApiProvider()
    try:
        yield provider
    finally:
        await provider.aclose()


async def load_settings_doc(context: Context) -> Settings:
    """Current settings for display, falling back to the §3.2 defaults when
    unseeded — **or when the read fails for any reason at all.**

    Right for a page that only shows them, where rendering beats an error — **except
    when the datastore itself cannot answer** (2026-10-13). Defaults painted over
    an outage are a picture of an unconfigured install, so that one failure is a
    503 (`datastore.raise_if_unavailable`). Never
    for a route that writes or spends on them: defaults are not a safe guess at
    what the user configured (`kill_switch` and `offline_mode` both default to
    off), so `PUT /api/settings` and `POST /api/system/poll` read through
    `engine.load_settings`, which raises on anything but an absent document.
    """
    try:
        found = await context.client.get(index=context.index(SETTINGS_INDEX), id="global")
    except Exception as exc:
        raise_if_unavailable(exc)
        return settings_from_document(None)
    return settings_from_document(found["_source"])


async def search(context: Context, index: str, **body: Any) -> dict[str, Any]:
    """Search, turning a missing index into an empty result rather than a 500.

    A freshly bootstrapped install has indices but no documents; a *partially*
    bootstrapped one may not have the index at all, and the UI asking for an
    empty table should see an empty table. An unreachable or recovering cluster
    is not an empty table, and raises (`datastore.raise_if_unavailable`).
    """
    try:
        return await context.client.search(index=context.index(index), **body)
    except Exception as exc:
        raise_if_unavailable(exc)
        return {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}


def hits(response: dict[str, Any]) -> list[dict[str, Any]]:
    """`_source` rows with their `_id` folded in, which is what the UI wants."""
    return [
        {"id": hit["_id"], **hit["_source"]} for hit in response.get("hits", {}).get("hits", [])
    ]


async def mget(context: Context, index: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    """Fetch many documents by id, keyed by id, skipping the ones that are gone.

    Elasticsearch has no joins, so every table this API assembles from two indices
    does it this way: one search, then one `mget` over the ids that search
    returned. Bounded by the caller's `limit`, and the alternative is the UI
    issuing N+1 requests to fill in a column.

    A missing index yields `{}` rather than raising, for the same reason `search`
    does: the joined-in field is an enrichment, and a table that renders without
    the matchup is better than a 500. An unreachable cluster used to as well; it
    raises now, like `search`, since the search before this would have.
    """
    wanted = sorted({doc_id for doc_id in ids if doc_id})
    if not wanted:
        return {}
    try:
        found = await context.client.mget(index=context.index(index), ids=wanted)
    except Exception as exc:
        raise_if_unavailable(exc)
        return {}
    # Fold `_id` in, exactly as `hits()` does for a search: a joined document is a
    # row the UI addresses by id like any other.
    return {
        doc["_id"]: {"id": doc["_id"], **doc["_source"]}
        for doc in found["docs"]
        if doc.get("found")
    }


def require_found(value: Any, what: str) -> Any:
    if value is None:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return value

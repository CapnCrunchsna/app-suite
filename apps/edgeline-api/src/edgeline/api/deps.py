"""Shared request dependencies.

One `Context` carries the Elasticsearch client and the index prefix, injected
through FastAPI's dependency system so tests can point the whole API at the
`edgeline-test-` prefix with a single override instead of monkeypatching modules.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..config import Settings, settings_from_document
from ..indices import INDEX_PREFIX, SETTINGS_INDEX, with_prefix


@dataclass
class Context:
    """Everything a route needs to reach the datastore."""

    client: Any
    prefix: str = INDEX_PREFIX

    def index(self, name: str) -> str:
        return with_prefix(name, self.prefix)


def get_context() -> Context:
    """The live context. Overridden wholesale in tests."""
    from ..es import get_client

    return Context(client=get_client(), prefix=INDEX_PREFIX)


async def load_settings_doc(context: Context) -> Settings:
    """Current settings, falling back to the §3.2 defaults when unseeded."""
    try:
        found = await context.client.get(index=context.index(SETTINGS_INDEX), id="global")
    except Exception:
        return settings_from_document(None)
    return settings_from_document(found["_source"])


async def search(context: Context, index: str, **body: Any) -> dict[str, Any]:
    """Search, turning a missing index into an empty result rather than a 500.

    A freshly bootstrapped install has indices but no documents; a *partially*
    bootstrapped one may not have the index at all, and the UI asking for an
    empty table should see an empty table.
    """
    try:
        return await context.client.search(index=context.index(index), **body)
    except Exception:
        return {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}


def hits(response: dict[str, Any]) -> list[dict[str, Any]]:
    """`_source` rows with their `_id` folded in, which is what the UI wants."""
    return [
        {"id": hit["_id"], **hit["_source"]} for hit in response.get("hits", {}).get("hits", [])
    ]


def require_found(value: Any, what: str) -> Any:
    if value is None:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return value

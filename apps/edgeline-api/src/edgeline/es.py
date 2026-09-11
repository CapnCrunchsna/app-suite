"""Elasticsearch client factory and bootstrap — spec §4.2.

``ensure_indices()`` is called at both engine and worker startup and must be safe
to call on every start. It is therefore strictly additive: it creates indices that
are missing and writes seed documents that are missing, and it never touches an
index or a document that already exists.

That last part is not a nicety. The settings seed contains ``paper_mode: true``;
a bootstrap that re-wrote the ``"global"`` document on every start would silently
revert whatever the user had configured — including, one day, flipping a live
system back to paper or a paper system back to live. Seeds go in with
``op_type="create"``, so an existing document makes the write fail and be skipped
rather than win.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from functools import lru_cache

from elasticsearch import AsyncElasticsearch, ConflictError

from .config import es_url
from .indices import INDEX_MAPPINGS, INDEX_PREFIX, SEEDS, with_prefix

log = logging.getLogger(__name__)


@dataclass
class BootstrapReport:
    """What ``ensure_indices()`` actually changed — logged, and asserted on in tests."""

    created_indices: list[str] = field(default_factory=list)
    existing_indices: list[str] = field(default_factory=list)
    updated_mappings: list[str] = field(default_factory=list)
    seeded_documents: list[str] = field(default_factory=list)
    existing_documents: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.created_indices or self.updated_mappings or self.seeded_documents)


@lru_cache(maxsize=1)
def get_client() -> AsyncElasticsearch:
    """The process-wide async client, pointed at ``ES_URL`` (§3.1)."""
    return AsyncElasticsearch(hosts=[es_url()])


async def close_client() -> None:
    """Close and forget the cached client. Safe to call when none was created."""
    if get_client.cache_info().currsize:
        await get_client().close()
        get_client.cache_clear()


async def _sync_mapping(es, index: str, mapping: dict, report: "BootstrapReport") -> None:
    """Add any §4.3 properties an existing index does not have yet.

    Every index here is `dynamic: strict`, so a field added to a mapping in code
    is *rejected* by an index created before it — the write fails, and it fails
    at grading time rather than at startup. Creation-only bootstrap made adding a
    field a silent trap on every existing install.

    Elasticsearch permits adding properties to a live mapping and refuses to
    change the type of one that exists. That is the behaviour wanted here, so the
    refusal is logged loudly rather than swallowed: a genuine type conflict needs
    a reindex and a person, and pretending otherwise would corrupt the data it is
    trying to protect.
    """
    properties = mapping.get("properties")
    if not properties:
        return
    try:
        current = await es.indices.get_mapping(index=index)
        live = current[index]["mappings"].get("properties", {})
    except Exception:
        live = {}

    missing = {name: spec for name, spec in properties.items() if name not in live}
    if not missing:
        return
    try:
        await es.indices.put_mapping(index=index, properties=missing)
    except Exception as exc:
        log.error(
            "could not add %s to %s: %s. The index needs a reindex by hand.",
            ", ".join(sorted(missing)),
            index,
            exc,
        )
        return
    report.updated_mappings.append(index)
    log.info("added %s to %s", ", ".join(sorted(missing)), index)


async def ensure_indices(
    client: AsyncElasticsearch | None = None,
    *,
    prefix: str = INDEX_PREFIX,
    seed: bool = True,
) -> BootstrapReport:
    """Create every missing index with its §4.3 mapping, then write missing seeds.

    ``prefix`` lets the test suite bootstrap a parallel ``edgeline-test-`` set
    against the same cluster (§4.2). ``seed=False`` gives mappings without the
    §3.2/§4.3 seed documents, for tests that want empty indices.
    """
    es = client or get_client()
    report = BootstrapReport()

    for name, mapping in INDEX_MAPPINGS.items():
        index = with_prefix(name, prefix)
        if await es.indices.exists(index=index):
            report.existing_indices.append(index)
            await _sync_mapping(es, index, mapping, report)
            continue
        await es.indices.create(index=index, mappings=mapping)
        report.created_indices.append(index)
        log.info("created index %s", index)

    if seed:
        for name, documents in SEEDS.items():
            index = with_prefix(name, prefix)
            for doc_id, document in documents.items():
                ref = f"{index}/{doc_id}"
                try:
                    # op_type="create" is the whole safety story: an existing
                    # document conflicts instead of being overwritten (§4.4 rule 1).
                    # refresh="wait_for" because startup code reads settings back
                    # in the same breath (§4.4 rule 2).
                    await es.index(
                        index=index,
                        id=doc_id,
                        document=document,
                        op_type="create",
                        refresh="wait_for",
                    )
                except ConflictError:
                    report.existing_documents.append(ref)
                else:
                    report.seeded_documents.append(ref)
                    log.info("seeded %s", ref)

    return report

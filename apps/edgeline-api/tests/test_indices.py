"""Index catalog and mappings — spec §4.2, §4.3.

``"dynamic": "strict"`` makes a mapping the schema rather than a hint: a field the
mapping omits cannot be written at all, and a field given the wrong type is wrong
for the life of the index (Elasticsearch will not re-type a live field). Both
failures are silent until production data hits them, so §4.2's conventions are
re-derived here from the field name and checked against every mapping.
"""

from __future__ import annotations

import pytest

from edgeline.config import DEFAULT_SETTINGS
from edgeline.indices import (
    BANKROLL_LEDGER_INDEX,
    INDEX_MAPPINGS,
    INDEX_PREFIX,
    OPPORTUNITIES_INDEX,
    SEEDS,
    SETTINGS_INDEX,
    SPORTSBOOK_SEEDS,
    SPORTSBOOKS_INDEX,
    TEST_INDEX_PREFIX,
    all_index_names,
    event_doc_id,
    with_prefix,
)

# §4.3's catalog, verbatim.
EXPECTED_INDICES = {
    "edgeline-settings",
    "edgeline-providers",
    "edgeline-sportsbooks",
    "edgeline-events",
    "edgeline-odds-snapshots",
    "edgeline-opportunities",
    "edgeline-recommendations",
    "edgeline-bets",
    "edgeline-results",
    "edgeline-bankroll-ledger",
    "edgeline-unmatched",
}

BLOB_FIELDS = {"config", "link_templates", "stakes", "raw"}
FLAG_FIELDS = {
    "enabled",
    "md_licensed",
    "completed",
    "is_closing",
    "paper",
    "needs_manual",
    "resolved",
    "bet_first",
}
# §4.3 asks for `integer` specifically on these; they are counts, not money.
INTEGER_FIELDS = {"home_score", "away_score", "priority"}
COUNT_FIELDS = {"quota_used", "quota_budget"}


def expected_es_type(field: str) -> str:
    """§4.2's field-type conventions, applied to a field name."""
    if field in BLOB_FIELDS:
        return "blob"
    if field.endswith("_cents") or field in COUNT_FIELDS:
        return "long"
    if field.endswith("_at") or field in {"@timestamp", "commence_time"}:
        return "date"
    if field in INTEGER_FIELDS:
        return "integer"
    if (
        field.endswith(("_pct", "_prob", "_decimal"))
        or field in {"line", "staleness"}
    ):
        return "double"
    if field in FLAG_FIELDS:
        return "boolean"
    return "keyword"  # ids, keys, enums


def iter_fields():
    """Every leaf ``(index, field, definition)`` in the catalog, legs' own fields included.

    Object containers such as ``legs`` are skipped: they carry no value of their
    own, so the name-based conventions do not apply to them. Their shape is
    checked by ``test_legs_is_a_plain_object_array_not_nested`` instead.
    """
    for index, mapping in INDEX_MAPPINGS.items():
        for field, definition in (mapping.get("properties") or {}).items():
            children = definition.get("properties") or {}
            if children:
                for sub, sub_def in children.items():
                    yield index, sub, sub_def
                continue
            yield index, field, definition


def test_catalog_matches_the_spec():
    assert set(INDEX_MAPPINGS) == EXPECTED_INDICES


def test_every_index_is_prefixed():
    assert all(name.startswith(INDEX_PREFIX) for name in INDEX_MAPPINGS)


@pytest.mark.parametrize(
    "index", sorted(EXPECTED_INDICES - {SETTINGS_INDEX})
)
def test_mappings_are_strict(index):
    """Unknown fields must fail loudly, never be silently indexed (§4.2)."""
    assert INDEX_MAPPINGS[index]["dynamic"] == "strict"


def test_settings_is_the_documented_exception():
    """Read/written whole by `_id`; nothing in it needs indexing (§4.2)."""
    mapping = INDEX_MAPPINGS[SETTINGS_INDEX]
    assert mapping["dynamic"] is False
    assert "properties" not in mapping


@pytest.mark.parametrize(
    ("index", "field", "definition"),
    [pytest.param(i, f, d, id=f"{i}:{f}") for i, f, d in iter_fields()],
)
def test_field_types_follow_the_conventions(index, field, definition):
    expected = expected_es_type(field)
    if expected == "blob":
        # Stored in _source, never indexed.
        assert definition == {"type": "object", "enabled": False}
    else:
        assert definition["type"] == expected


def test_legs_is_a_plain_object_array_not_nested():
    """§4.3: no query correlates fields across two legs, so nested buys nothing."""
    legs = INDEX_MAPPINGS[OPPORTUNITIES_INDEX]["properties"]["legs"]
    assert legs["type"] == "object"
    assert set(legs["properties"]) == {
        "book_key",
        "selection",
        "line",
        "price_decimal",
        "devig_prob",
        "staleness",
        "bet_first",
    }


def test_ledger_stores_no_balance():
    """§4.4 rule 3 — balances are sum aggregations, never a stored field."""
    fields = INDEX_MAPPINGS[BANKROLL_LEDGER_INDEX]["properties"]
    assert "balance" not in fields
    assert not any("balance" in name for name in fields)


def test_settings_seed_is_the_full_default_set():
    assert SEEDS[SETTINGS_INDEX]["global"] == DEFAULT_SETTINGS


def test_sportsbook_seed_matches_the_spec_list_and_starts_disabled():
    assert set(SPORTSBOOK_SEEDS) == {
        # §4.3's original eight.
        "draftkings",
        "fanduel",
        "betmgm",
        "williamhill_us",
        "betrivers",
        "espnbet",
        "fanatics",
        "bet365",
        # Confirmed Maryland-legal by the user on 2026-09-09, after the `us2`
        # region feed surfaced them.
        "betparx",
        "ballybet",
    }
    assert all(book["enabled"] is False for book in SPORTSBOOK_SEEDS.values())


def test_an_excluded_book_is_not_seeded():
    """§16.3 — being in the feed and looking plausible is not the same as being
    usable, and every exclusion carries the reason it was excluded for.

    `hardrockbet` was the open case and is now a closed one: the user confirmed
    on 2026-09-09 that it is not Maryland-legal, so it stays out on a verified
    answer rather than on a missing one.
    """
    from edgeline.indices import EXCLUDED_BOOKS

    assert "hardrockbet" in EXCLUDED_BOOKS
    for key, reason in EXCLUDED_BOOKS.items():
        assert key not in SPORTSBOOK_SEEDS, key
        assert reason, key


def test_sportsbook_seed_records_the_confirmed_maryland_licensure():
    """§4.3's "verify Maryland licensure before enabling".

    All eight were confirmed licensed by the user on 2026-09-08. Before that the
    field was absent rather than `False`, because an unverified negative is as
    much of a claim as an unverified positive.
    """
    for key, book in SPORTSBOOK_SEEDS.items():
        assert book["md_licensed"] is True, key


def test_sportsbook_seed_guesses_no_deep_link_schema():
    """§16.3 — a URL *schema* may only come from a verified event URL (T4.3).

    `book_home` is not a schema: it is one landing page, fetched and identified
    on 2026-09-11, with no placeholders to get wrong. The rungs that would need
    a schema stay empty, and that is what this pins — the ladder returning
    "no link" for a market is correct; sending someone to the wrong market on a
    real sportsbook with money in hand is the failure worth preventing.
    """
    for key, book in SPORTSBOOK_SEEDS.items():
        templates = book["link_templates"]
        assert "event" not in templates, key
        assert "betslip" not in templates, key
        assert set(templates) <= {"book_home"}, key


def test_every_seeded_home_link_is_a_plain_verified_url():
    """A `book_home` with a placeholder in it would be a guessed schema wearing
    the safe rung's name, and `.format()` would fill it silently."""
    for key, book in SPORTSBOOK_SEEDS.items():
        home = book["link_templates"].get("book_home")
        if home is None:
            continue
        assert home.startswith("https://"), key
        assert "{" not in home and "}" not in home, key


def test_the_two_unverifiable_books_are_recorded_as_absent_not_guessed():
    """§16.3 cuts the same way it did for `hardrockbet`: unreachable is not the
    same as unknown-and-therefore-invented. `espnbet` did not resolve from this
    machine and `bet365` answered Cloudflare's bot check, so both keep `{}`
    until a person supplies the URL."""
    for key in ("espnbet", "bet365"):
        assert SPORTSBOOK_SEEDS[key]["link_templates"] == {}, key


def test_licensed_does_not_mean_enabled():
    """Two different questions. §4.3 reserves enabling to the user, and it is the
    switch that decides which books' prices reach detection at all."""
    assert all(book["md_licensed"] for book in SPORTSBOOK_SEEDS.values())
    assert not any(book["enabled"] for book in SPORTSBOOK_SEEDS.values())


def test_seed_documents_only_use_mapped_fields():
    """A seed with a stray field would fail against `dynamic: strict` at bootstrap."""
    for index, documents in SEEDS.items():
        mapping = INDEX_MAPPINGS[index]
        if mapping.get("dynamic") is False:
            continue
        allowed = set(mapping["properties"])
        for doc_id, document in documents.items():
            assert set(document) <= allowed, f"{index}/{doc_id}"


def test_prefix_swap_is_reversible():
    names = all_index_names(TEST_INDEX_PREFIX)
    assert all(name.startswith(TEST_INDEX_PREFIX) for name in names)
    assert len(names) == len(INDEX_MAPPINGS)
    assert with_prefix(SPORTSBOOKS_INDEX, TEST_INDEX_PREFIX) == "edgeline-test-sportsbooks"


def test_event_doc_id_shape():
    assert event_doc_id("baseball_mlb", "abc123") == "baseball_mlb:abc123"


@pytest.mark.es
async def test_ensure_indices_bootstraps_then_is_idempotent(es_url, test_index_prefix):
    """The real §4.2 contract: create what is missing, never overwrite what exists."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.es import ensure_indices

    client = AsyncElasticsearch(hosts=[es_url])
    try:
        for name in all_index_names(test_index_prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)

        first = await ensure_indices(client, prefix=test_index_prefix)
        assert len(first.created_indices) == len(INDEX_MAPPINGS)
        assert f"{test_index_prefix}settings/global" in first.seeded_documents

        # A user edit that a second bootstrap must not clobber.
        await client.index(
            index=f"{test_index_prefix}settings",
            id="global",
            document={**DEFAULT_SETTINGS, "kelly_fraction": 0.05},
            refresh="wait_for",
        )

        second = await ensure_indices(client, prefix=test_index_prefix)
        assert second.created_indices == []
        assert second.seeded_documents == []
        assert not second.changed

        stored = await client.get(index=f"{test_index_prefix}settings", id="global")
        assert stored["_source"]["kelly_fraction"] == 0.05
    finally:
        for name in all_index_names(test_index_prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)
        await client.close()

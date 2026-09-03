"""Shared pytest fixtures.

Datastore-backed tests run against the local dev Elasticsearch under the
``edgeline-test-`` index prefix and are skipped when nothing answers at
``ES_URL``, so the suite still passes on a machine where the datastore is not
running (spec §14). Pure-math tests (G1-G8) never touch Elasticsearch.
"""

from __future__ import annotations

import os
from functools import lru_cache

import httpx
import pytest

ES_URL = os.environ.get("ES_URL", "http://localhost:9200")
TEST_INDEX_PREFIX = "edgeline-test-"


@lru_cache(maxsize=1)
def es_reachable() -> bool:
    try:
        return httpx.get(ES_URL, timeout=2.0).status_code == 200
    except Exception:
        return False


def pytest_collection_modifyitems(config, items):
    if es_reachable():
        return
    skip_es = pytest.mark.skip(reason=f"no Elasticsearch at {ES_URL}")
    for item in items:
        if "es" in item.keywords:
            item.add_marker(skip_es)


@pytest.fixture(scope="session")
def es_url() -> str:
    return ES_URL


@pytest.fixture(scope="session")
def test_index_prefix() -> str:
    return TEST_INDEX_PREFIX

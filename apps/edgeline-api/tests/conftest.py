"""Shared pytest fixtures.

Datastore-backed tests run against the local dev Elasticsearch under the
``edgeline-test-`` index prefix and are skipped when nothing answers at
``ES_URL``, so the suite still passes on a machine where the datastore is not
running (spec §14). Pure-math tests (G1-G8) never touch Elasticsearch.

Provider tests replay the recorded responses in ``tests/fixtures/`` through
``respx``. Per §16.4 no test ever calls the live API; the only thing that talks
to The Odds API is the §8 fixture recorder, run by hand.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import pytest

ES_URL = os.environ.get("ES_URL", "http://localhost:9200")
TEST_INDEX_PREFIX = "edgeline-test-"
FIXTURE_DIR = Path(__file__).parent / "fixtures"


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


def load_fixture(pattern: str) -> Any:
    """Newest recorded response matching ``pattern``.

    The §8 recorder stamps every filename with the capture time, so tests match
    by glob and take the latest. Re-recording therefore refreshes what the suite
    replays without anyone editing a test.
    """
    matches = sorted(FIXTURE_DIR.glob(pattern))
    if not matches:
        raise AssertionError(
            f"no fixture matching {pattern!r} in {FIXTURE_DIR}. "
            "Re-record with the §8 fixture recorder (EDGELINE_RECORD_FIXTURES=1)."
        )
    return json.loads(matches[-1].read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def es_url() -> str:
    return ES_URL


@pytest.fixture(scope="session")
def test_index_prefix() -> str:
    return TEST_INDEX_PREFIX


@pytest.fixture(scope="session")
def mlb_odds_payload() -> Any:
    """Recorded featured-markets response (h2h + spreads + totals, 9 books)."""
    return load_fixture("baseball_mlb_odds_*.json")


@pytest.fixture(scope="session")
def mlb_event_odds_payload() -> Any:
    """Recorded single-event player-props response."""
    return load_fixture("baseball_mlb_event_odds_*.json")


@pytest.fixture(scope="session")
def mlb_events_payload() -> Any:
    """Recorded event-list response."""
    return load_fixture("baseball_mlb_events_*.json")

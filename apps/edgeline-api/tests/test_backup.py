"""Backups — `edgeline.backup`, added 2026-10-21.

Against a real cluster under this file's own prefix, for the reason
`test_api.py` gives: the shared `edgeline-test-` prefix is created and deleted
by the other ES files, and two strategies on one prefix interfere.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timedelta, timezone

import pytest

from edgeline.config import Settings

PREFIX = "edgeline-backuptest-"
NOW = datetime(2026, 10, 21, 7, 0, tzinfo=timezone.utc)


@pytest.fixture
async def client(es_url):
    from elasticsearch import AsyncElasticsearch

    from edgeline.es import ensure_indices

    es = AsyncElasticsearch(hosts=[es_url])
    await _drop(es)
    await ensure_indices(es, prefix=PREFIX)
    yield es
    await _drop(es)
    await es.close()


async def _drop(es) -> None:
    """By name: ES 9 refuses a wildcard delete (`action.destructive_requires_name`)."""
    from edgeline.indices import all_index_names

    await es.indices.delete(index=all_index_names(PREFIX), ignore_unavailable=True)


async def _seed(es) -> None:
    from edgeline.indices import EVENTS_INDEX, ODDS_SNAPSHOTS_INDEX, with_prefix

    await es.index(
        index=with_prefix(EVENTS_INDEX, PREFIX),
        id="basketball_nba:g1",
        document={
            "sport_key": "basketball_nba",
            "commence_time": "2026-10-21T23:00:00Z",
            "home_team": "Boston Celtics",
            "away_team": "New York Knicks",
            "completed": False,
        },
    )
    for n in range(3):
        await es.index(
            index=with_prefix(ODDS_SNAPSHOTS_INDEX, PREFIX),
            id=f"snap-{n}",
            document={
                "@timestamp": "2026-10-21T21:30:00Z",
                "event_id": "basketball_nba:g1",
                "book_key": f"book{n}",
                "market_key": "h2h",
                "selection": "Boston Celtics",
                "price_decimal": 1.9 + n / 100,
                "is_closing": False,
            },
        )
    await es.indices.refresh(index=f"{PREFIX}*")


async def _sources(es, index_name: str) -> dict[str, dict]:
    from edgeline.indices import with_prefix

    index = with_prefix(index_name, PREFIX)
    await es.indices.refresh(index=index)
    found = await es.search(index=index, size=100, query={"match_all": {}})
    return {hit["_id"]: hit["_source"] for hit in found["hits"]["hits"]}


@pytest.mark.es
async def test_a_backup_restores_into_an_empty_store_exactly(client, tmp_path):
    from edgeline.backup import export_backup, read_backup, restore_backup
    from edgeline.es import ensure_indices
    from edgeline.indices import EVENTS_INDEX, ODDS_SNAPSHOTS_INDEX, SETTINGS_INDEX

    await _seed(client)
    before = {
        name: await _sources(client, name)
        for name in (EVENTS_INDEX, ODDS_SNAPSHOTS_INDEX, SETTINGS_INDEX)
    }

    report = await export_backup(client, tmp_path, prefix=PREFIX, now=NOW)
    header, documents = read_backup(report.path)
    assert report.path.name == "edgeline-backup-20261021T070000Z.ndjson.gz"
    assert header["counts"]["odds-snapshots"] == 3
    assert header["counts"]["events"] == 1
    assert len(documents) == report.documents

    # A new disk: nothing but what bootstrap seeds.
    await _drop(client)
    await ensure_indices(client, prefix=PREFIX)

    restored = await restore_backup(client, report.path, prefix=PREFIX)
    assert restored["odds-snapshots"] == 3
    for name, sources in before.items():
        assert await _sources(client, name) == sources


@pytest.mark.es
async def test_a_restore_will_not_merge_into_live_data_unless_forced(client, tmp_path):
    from edgeline.backup import BackupRefused, export_backup, restore_backup

    await _seed(client)
    report = await export_backup(client, tmp_path, prefix=PREFIX, now=NOW)

    with pytest.raises(BackupRefused):
        await restore_backup(client, report.path, prefix=PREFIX)

    assert (await restore_backup(client, report.path, prefix=PREFIX, force=True))["events"] == 1


@pytest.mark.es
async def test_only_the_newest_backups_are_kept_and_nothing_partial_is_left(client, tmp_path):
    from edgeline.backup import export_backup

    for day in range(4):
        await export_backup(client, tmp_path, prefix=PREFIX, keep=2, now=NOW + timedelta(days=day))

    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "edgeline-backup-20261023T070000Z.ndjson.gz",
        "edgeline-backup-20261024T070000Z.ndjson.gz",
    ]


def test_a_file_that_is_not_a_backup_is_refused(tmp_path):
    from edgeline.backup import read_backup

    stray = tmp_path / "edgeline-backup-x.ndjson.gz"
    with gzip.open(stray, "wt", encoding="utf-8") as out:
        out.write(json.dumps({"format": "something-else"}) + "\n")

    with pytest.raises(ValueError, match="not an edgeline-backup/1 file"):
        read_backup(stray)


def test_the_worker_backs_up_daily_only_when_a_directory_is_set(tmp_path):
    from edgeline.scheduler import build_scheduler

    off = build_scheduler(provider=None, client=None, settings=Settings())
    on = build_scheduler(provider=None, client=None, settings=Settings(), backup_dir=tmp_path)

    assert "backup" not in {job.id for job in off.get_jobs()}
    job = on.get_job("backup")
    assert str(job.trigger) == "cron[hour='7', minute='0']"

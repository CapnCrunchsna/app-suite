"""Backups of the Edgeline indices — added 2026-10-21.

Everything Edgeline has learned lives in one Docker volume on this laptop's
system SSD: the odds snapshots, recommendations, the results ledger and the CLV
history. None of it is in git. On 2026-10-21 that SSD had logged 1,252
bad-block errors in six days, and Windows had twice found file-system
corruption on C:. So this writes the whole store to a directory that is
somewhere else, which here is Google Drive (`G:\\My Drive\\Edgeline backups`).

**Format.** One gzipped NDJSON file per backup,
``edgeline-backup-<UTC stamp>.ndjson.gz``. The first line is a header (format
version, when, which prefix, document count per index); every line after it is
one document: ``{"index": <name without prefix>, "id": ..., "source": {...}}``.
Mappings are not stored: they are code (`indices.INDEX_MAPPINGS`), and restore
creates the indices through `ensure_indices`, the same as a fresh install. The
whole store was 12 MB uncompressed on the day this was written, so a dump is
simpler than Elasticsearch's snapshot API. A snapshot needs `path.repo` and a
mounted volume, and its repository is a tree of files that would have to be
copied out of the failing disk anyway.

**Written whole or not at all.** Each file is written beside its final name and
renamed into place, so Drive never uploads half of one and a crash leaves a
``.partial`` file rather than a truncated backup. The newest `KEEP` are kept;
older ones are deleted.

**Restore refuses to merge.** Into indices that already hold data it stops,
unless told `force`. Restoring is for a new disk or a wiped volume, and
overwriting live documents by id with week-old ones is never what a restore
into a running system means. Seeded documents (settings, sportsbooks,
providers) do not count as data: a fresh install has them before anything else.

Run by the worker daily when ``EDGELINE_BACKUP_DIR`` is set (§13 job ``backup``),
and by hand:

    uv run python -m edgeline.backup export [--dir DIR]
    uv run python -m edgeline.backup restore FILE [--force]
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .indices import INDEX_MAPPINGS, INDEX_PREFIX, SEEDS, with_prefix

log = logging.getLogger(__name__)

FORMAT = "edgeline-backup/1"
FILE_PREFIX = "edgeline-backup-"
FILE_SUFFIX = ".ndjson.gz"
#: A month of dailies. At ~3 MB each that is under 100 MB of a 15 GB Drive.
KEEP = 30
#: Documents per bulk request on restore.
BULK_CHUNK = 2000


class BackupRefused(RuntimeError):
    """A restore that would overwrite live data without `force`."""


@dataclass
class BackupReport:
    path: Path
    counts: dict[str, int] = field(default_factory=dict)
    pruned: list[Path] = field(default_factory=list)

    @property
    def documents(self) -> int:
        return sum(self.counts.values())


def backup_name(now: datetime) -> str:
    return f"{FILE_PREFIX}{now.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}{FILE_SUFFIX}"


def existing_backups(directory: Path) -> list[Path]:
    """This module's files in `directory`, oldest first. The stamp sorts as text."""
    return sorted(
        p for p in directory.glob(f"{FILE_PREFIX}*{FILE_SUFFIX}") if p.is_file()
    )


async def export_backup(
    client,
    directory: Path,
    *,
    prefix: str = INDEX_PREFIX,
    keep: int = KEEP,
    now: datetime | None = None,
) -> BackupReport:
    """Write every index under `prefix` to one new file in `directory`."""
    from elasticsearch.helpers import async_scan

    now = now or datetime.now(timezone.utc)
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / backup_name(now)
    partial = final.with_name(final.name + ".partial")
    report = BackupReport(path=final)

    # Counted as they are written, then put in the header — so the body is
    # streamed to a scratch file first and the header joins it at the end.
    # Counting first instead would race the worker, which writes snapshots
    # while this reads, and restore checks the header against the body. The
    # scratch file is local, so Drive never sees it.
    scratch = tempfile.TemporaryDirectory(prefix="edgeline-backup-")
    body = Path(scratch.name) / "body.ndjson.gz"
    try:
        with gzip.open(body, "wt", encoding="utf-8") as out:
            for name in INDEX_MAPPINGS:
                index = with_prefix(name, prefix)
                if not await client.indices.exists(index=index):
                    continue
                short = name.removeprefix(INDEX_PREFIX)
                count = 0
                async for hit in async_scan(
                    client, index=index, query={"query": {"match_all": {}}}, size=1000
                ):
                    out.write(
                        json.dumps(
                            {"index": short, "id": hit["_id"], "source": hit["_source"]},
                            separators=(",", ":"),
                        )
                    )
                    out.write("\n")
                    count += 1
                report.counts[short] = count

        header = {
            "format": FORMAT,
            "created_at": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "prefix": prefix,
            "counts": report.counts,
        }
        with gzip.open(partial, "wt", encoding="utf-8") as out:
            out.write(json.dumps(header, separators=(",", ":")) + "\n")
            with gzip.open(body, "rt", encoding="utf-8") as lines:
                for line in lines:
                    out.write(line)
        os.replace(partial, final)
    finally:
        scratch.cleanup()
        partial.unlink(missing_ok=True)

    if keep > 0:
        for old in existing_backups(directory)[:-keep]:
            old.unlink(missing_ok=True)
            report.pruned.append(old)
    return report


def read_backup(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The header and the documents of one backup file."""
    with gzip.open(path, "rt", encoding="utf-8") as lines:
        header = json.loads(next(lines))
        if header.get("format") != FORMAT:
            raise ValueError(f"{path.name}: not an {FORMAT} file ({header.get('format')!r})")
        documents = [json.loads(line) for line in lines if line.strip()]
    return header, documents


async def live_documents(client, *, prefix: str) -> dict[str, int]:
    """Non-seed documents per index under `prefix` — what a restore would clobber."""
    found: dict[str, int] = {}
    for name in INDEX_MAPPINGS:
        index = with_prefix(name, prefix)
        if not await client.indices.exists(index=index):
            continue
        await client.indices.refresh(index=index)
        total = (await client.count(index=index))["count"]
        seeded = len(SEEDS.get(name, {}))
        if total > seeded:
            found[name.removeprefix(INDEX_PREFIX)] = total
    return found


async def restore_backup(
    client, path: Path, *, prefix: str = INDEX_PREFIX, force: bool = False
) -> dict[str, int]:
    """Load one backup file into the indices under `prefix`. Returns counts."""
    from elasticsearch.helpers import async_bulk

    from .es import ensure_indices

    header, documents = read_backup(path)
    await ensure_indices(client, prefix=prefix)

    if not force:
        live = await live_documents(client, prefix=prefix)
        if live:
            raise BackupRefused(
                f"indices under {prefix!r} already hold data ({live}); restore is for an "
                "empty store. Pass force to overwrite documents by id."
            )

    actions = (
        {
            "_op_type": "index",
            "_index": with_prefix(INDEX_PREFIX + doc["index"], prefix),
            "_id": doc["id"],
            "_source": doc["source"],
        }
        for doc in documents
    )
    await async_bulk(client, actions, chunk_size=BULK_CHUNK, refresh="wait_for")

    restored: dict[str, int] = {}
    for doc in documents:
        restored[doc["index"]] = restored.get(doc["index"], 0) + 1
    expected = {k: v for k, v in header["counts"].items() if v}
    if restored != expected:
        raise ValueError(f"{path.name}: header counts {expected} but body held {restored}")
    return restored


def backup_dir() -> Path | None:
    """`EDGELINE_BACKUP_DIR` from `.env` or the environment, if set."""
    from .config import get_secrets

    value = get_secrets().edgeline_backup_dir.strip()
    return Path(value) if value else None


def main(argv: list[str] | None = None) -> int:
    import argparse
    import asyncio

    parser = argparse.ArgumentParser(prog="python -m edgeline.backup", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="write a backup file")
    export.add_argument("--dir", type=Path, help="target directory (default: EDGELINE_BACKUP_DIR)")
    restore = commands.add_parser("restore", help="load a backup file into an empty store")
    restore.add_argument("file", type=Path)
    restore.add_argument("--force", action="store_true", help="overwrite documents already present")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # One line per scroll page otherwise: ~170 for the snapshots alone.
    logging.getLogger("elastic_transport").setLevel(logging.WARNING)

    async def run() -> int:
        from .es import close_client, get_client

        client = get_client()
        try:
            if args.command == "export":
                directory = args.dir or backup_dir()
                if directory is None:
                    parser.error("no --dir given and EDGELINE_BACKUP_DIR is not set")
                report = await export_backup(client, directory)
                # Stamped like the worker's run, so the dashboard counts a backup
                # taken by hand as the most recent one.
                from .scheduler import record_run

                await record_run(client, prefix=INDEX_PREFIX, job="backup")
                log.info(
                    "backup: %d documents in %s (%.1f MB); %d old backup(s) pruned",
                    report.documents,
                    report.path,
                    report.path.stat().st_size / 1e6,
                    len(report.pruned),
                )
            else:
                restored = await restore_backup(client, args.file, force=args.force)
                log.info("restore: %d documents from %s: %s", sum(restored.values()), args.file, restored)
            return 0
        finally:
            await close_client()

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())

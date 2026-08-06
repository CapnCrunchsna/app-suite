/**
 * The SQLite handle, and the only place in the workspace that names
 * `better-sqlite3`.
 *
 * §2.2: `data` is "the only lib that knows a store exists", and the lint rule
 * behind that is what keeps the later Elasticsearch move mechanical. The
 * corollary inside this lib is that the driver type stops here — every
 * repository takes `Database`, and `Database` is re-exported as a type so that
 * nothing above `data` ever has to import the driver to hold a handle.
 *
 * Synchronous, no daemon, single file: §3 chose it because that is correct for
 * one local user, and because a synchronous driver makes `db.transaction(...)`
 * an actual atomic block rather than a promise chain that can interleave.
 */

import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;
export type { Statement } from 'better-sqlite3';

export interface OpenDatabaseOptions {
  /** A filesystem path, or `:memory:`. Tests use the latter. */
  readonly filename: string;
  readonly readonly?: boolean;
}

/**
 * Pragmas, and why each one is here rather than left at its default.
 *
 * `foreign_keys` is **off** by default in SQLite, which would quietly turn every
 * `ON DELETE RESTRICT` in §3.2 into a comment. That section's whole argument is
 * that cascading deletes "would let one bad import delete findings and series
 * silently"; unenforced restrictions are worse than cascades, because they let
 * the orphan happen without even the delete.
 *
 * `journal_mode = WAL` lets the API read while a commit is writing, which is
 * exactly the import path: the review screen polls while `POST /commit` runs.
 * `synchronous = NORMAL` is the documented safe pairing for WAL — durable
 * against process crash, which is the failure this app actually has.
 *
 * `busy_timeout` turns "database is locked" from an immediate throw into a wait.
 */
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
];

export function openDatabase(options: OpenDatabaseOptions): Database {
  const db = new BetterSqlite3(options.filename, { readonly: options.readonly ?? false });
  for (const pragma of PRAGMAS) {
    db.pragma(pragma.replace(/^PRAGMA\s+/, ''));
  }
  return db;
}

/**
 * A consistent on-disk copy of the live database (`POST /api/data/backup`).
 *
 * `db.backup()` rather than a filesystem copy: under WAL the `.sqlite` file
 * alone is not the whole database, so copying it while the API is running can
 * produce a backup missing the most recent commits. The online backup API walks
 * pages under a read lock and yields a file that opens cleanly.
 */
export function backupDatabase(db: Database, destination: string): Promise<void> {
  return db.backup(destination).then(() => undefined);
}

/**
 * Numbered SQL migrations, applied at boot, tracked in `schema_migrations`
 * (§3, opening paragraph).
 *
 * The migrations are real `.sql` files under the lib's `migrations/` directory,
 * listed here in order. The list is code rather than a directory scan for one
 * reason: a scan makes a missing or misnamed file a *silently shorter* schema,
 * and the next thing that happens is an INSERT failing against a table that was
 * never created. An explicit list makes the same mistake a loud ENOENT at boot.
 *
 * The SQL sits at the package root rather than beside this file so that there is
 * nothing to copy at build time. `rootDir: src` / `outDir: dist` makes `dist/`
 * mirror `src/`, so `../../../migrations/` resolves to the same one real
 * directory from `src/lib/migrations/runner.ts` and from
 * `dist/lib/migrations/runner.js`. One copy of the schema, read identically by
 * a vitest run against sources and by the built API.
 *
 * Each migration runs inside its own transaction together with the
 * `schema_migrations` row that records it, so a migration that fails halfway
 * leaves the database on the previous version rather than in a state no version
 * number describes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
}

/** In order. Append; never renumber, never edit one that has shipped. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001-initial-schema' },
];

/**
 * `schema_migrations` gets the same three columns as every other table (§3.1),
 * with no exemption for being the bootstrap table — `schema-invariants.spec.ts`
 * asserts the rule over `sqlite_master` with no allow-list, and an allow-list of
 * one is how an allow-list of six starts.
 */
const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_schema_migrations_version ON schema_migrations (version);
`;

function readMigrationSql(name: string): string {
  const path = fileURLToPath(new URL(`../../../migrations/${name}.sql`, import.meta.url));
  return readFileSync(path, 'utf8');
}

export interface MigrationOutcome {
  readonly applied: readonly Migration[];
  readonly alreadyAtVersion: number;
}

export function applyMigrations(db: Database, clock: Clock): MigrationOutcome {
  db.exec(CREATE_SCHEMA_MIGRATIONS);

  const appliedVersions = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version)
  );

  const applied: Migration[] = [];

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    const sql = readMigrationSql(migration.name);
    const timestamp = clock.now();

    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        `INSERT INTO schema_migrations (id, version, name, applied_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(clock.newId(), migration.version, migration.name, timestamp, timestamp, timestamp);
    })();

    applied.push(migration);
  }

  const current = db
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations')
    .get();

  return { applied, alreadyAtVersion: current?.version ?? 0 };
}

/**
 * Versioned, forward-only migrations (meal-planner-spec.md §12 Phase 0).
 *
 * Migration 1 is §3's DDL verbatim, plus indexes that change no data shape: the
 * foreign-key lookups every screen makes, and the partial unique index that is §3's
 * "UNIQUE among non-deleted" comment on `plans.plan_date` made real.
 *
 * Applied versions are recorded in `_migrations`, not `PRAGMA user_version`: the
 * Capacitor SQLite plugin manages `user_version` itself for its own upgrade mechanism,
 * and two owners of one counter is how a migration runs twice or never.
 *
 * Never edit a shipped migration. Add the next one.
 */

import type { SqlDb } from './sql.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'spec §3 schema',
    sql: `
CREATE TABLE products (
  id              TEXT PRIMARY KEY,
  barcode         TEXT,
  name            TEXT NOT NULL,
  brand           TEXT,
  package_unit    TEXT NOT NULL CHECK (package_unit IN ('COUNT','G','ML')),
  package_amount  REAL NOT NULL,
  nutrition_basis TEXT NOT NULL CHECK (nutrition_basis IN ('PER_100','PER_UNIT')),
  kcal            REAL,
  protein_g       REAL,
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('off','usda','manual','seed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_products_barcode ON products(barcode);

CREATE TABLE pantry_items (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  quantity    REAL NOT NULL,
  expires_on  TEXT,
  acquired_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_pantry_items_product ON pantry_items(product_id);

CREATE TABLE meals (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  servings       REAL NOT NULL DEFAULT 1,
  slots          TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','import','seed')),
  source_url     TEXT,
  kcal_per_serving    REAL NOT NULL,
  protein_per_serving REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE meal_ingredients (
  id           TEXT PRIMARY KEY,
  meal_id      TEXT NOT NULL REFERENCES meals(id),
  product_id   TEXT,
  quantity     REAL,
  unit         TEXT CHECK (unit IN ('COUNT','G','ML')),
  display_text TEXT NOT NULL,
  to_taste     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_meal_ingredients_meal ON meal_ingredients(meal_id);

CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  plan_date      TEXT NOT NULL,
  kcal_budget    REAL NOT NULL,
  protein_target REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX idx_plans_live_date ON plans(plan_date) WHERE deleted_at IS NULL;

CREATE TABLE plan_slots (
  id        TEXT PRIMARY KEY,
  plan_id   TEXT NOT NULL REFERENCES plans(id),
  slot_type TEXT NOT NULL CHECK (slot_type IN ('breakfast','lunch','dinner','snack')),
  position  INTEGER NOT NULL,
  meal_id   TEXT,
  pinned    INTEGER NOT NULL DEFAULT 0,
  cooked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plan_slots_plan ON plan_slots(plan_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    // §8 step 6 lets the person trust a recipe site's nutrition over the computed one.
    // Without a record of that choice, the next recompute (a product's kcal corrected,
    // say) would silently overwrite it.
    version: 2,
    name: 'meals.nutrition_source',
    sql: `
ALTER TABLE meals ADD COLUMN nutrition_source TEXT NOT NULL DEFAULT 'ingredients'
  CHECK (nutrition_source IN ('ingredients','site'));
`,
  },
];

/** Applies every migration newer than the database, each in its own transaction. Returns the resulting version. */
export async function migrate(db: SqlDb, clock: { now(): string }, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const rows = await db.all<{ version: number | null }>('SELECT MAX(version) AS version FROM _migrations');
  let current = rows[0]?.version ?? 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        clock.now(),
      ]);
    });
    current = migration.version;
  }
  return current;
}

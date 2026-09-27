/**
 * Settings' Export data and Delete all data (meal-planner-spec.md §10).
 *
 * The export is every row of every table, soft-deleted ones included: it is a dump of the
 * database, not a view of what the screens show, so nothing the app knows is missing
 * from it. The one exception is the USDA API key — a credential, and this file exists to
 * be shared.
 *
 * Delete all data soft-deletes (§2: rows are never hard-deleted, for a future sync to
 * see). Settings have no deletion stamp, so they are written back to their defaults,
 * which also forgets the key. The seed version stays recorded, so the starter library
 * does not reappear on the next launch: the person asked for an empty app.
 */

import { DEFAULT_SETTINGS, SettingsRepo } from './settings.js';
import type { Clock, SqlDb, SqlValue } from './sql.js';

export const EXPORT_FORMAT = 'metrum-meal-planner-export';

/** Tables in dependency order, and whether each carries `deleted_at`. */
const TABLES: readonly { readonly name: string; readonly softDelete: boolean }[] = [
  { name: 'products', softDelete: true },
  { name: 'pantry_items', softDelete: true },
  { name: 'meals', softDelete: true },
  { name: 'meal_ingredients', softDelete: true },
  { name: 'plans', softDelete: true },
  { name: 'plan_slots', softDelete: false },
  { name: 'settings', softDelete: false },
];

const SECRET_SETTINGS = new Set(['usda_api_key']);

export interface DataExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly tables: Readonly<Record<string, readonly Record<string, SqlValue>[]>>;
}

export async function exportAll(db: SqlDb, clock: Clock): Promise<DataExport> {
  const version = await db.all<{ version: number | null }>('SELECT MAX(version) AS version FROM _migrations');
  const tables: Record<string, Record<string, SqlValue>[]> = {};
  for (const { name } of TABLES) {
    const rows = await db.all<Record<string, SqlValue>>(`SELECT * FROM ${name} ORDER BY rowid`);
    tables[name] = name === 'settings' ? rows.filter((r) => !SECRET_SETTINGS.has(String(r['key']))) : rows;
  }
  return { format: EXPORT_FORMAT, schemaVersion: version[0]?.version ?? 0, exportedAt: clock.now(), tables };
}

export async function deleteAll(db: SqlDb, clock: Clock): Promise<void> {
  await db.transaction(async (tx) => {
    const now = clock.now();
    for (const { name, softDelete } of TABLES) {
      if (softDelete) await tx.run(`UPDATE ${name} SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL`, [now, now]);
    }
  });
  await new SettingsRepo(db).write(DEFAULT_SETTINGS);
}

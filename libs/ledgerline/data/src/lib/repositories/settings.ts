/**
 * Settings (§3.1 `settings`, §2.3's `/api/settings`).
 *
 * §7.4 is why this table matters more than it looks: "Every threshold in §5 is a
 * default in a config object; Settings overrides it [...] No analyzer reads a
 * module-level constant." Tuning a threshold has to be a normal write, not a
 * schema migration.
 */

import { newStamp } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

export class SettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock
  ) {}

  get<T>(key: string): T | null {
    const row = this.db
      .prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE "key" = ?')
      .get(key);
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  set(key: string, value: unknown): void {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO settings (id, "key", value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT ("key") DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(stamp.id, key, JSON.stringify(value), stamp.createdAt, stamp.updatedAt);
  }

  all(): Record<string, unknown> {
    const rows = this.db
      .prepare<[], { key: string; value_json: string }>(
        'SELECT "key" AS key, value_json FROM settings ORDER BY "key"'
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
  }
}

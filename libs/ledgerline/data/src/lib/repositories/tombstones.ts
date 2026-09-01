/**
 * Tombstones (§3.4).
 *
 * "A watermark query cannot see deletions, and this app deletes: import
 * removal, account merge, wipe. The `tombstone` table records
 * `(entity_type, entity_id, deleted_at)` and the re-index consumes it in the
 * same pass. Without it, a deleted import's transactions would live forever in
 * the ES index and every aggregate would be wrong."
 *
 * Which is why every delete in this lib goes through a repository method that
 * writes one, inside the same transaction as the delete. A tombstone written
 * after a committed delete is a tombstone that can be lost.
 */

import { newStamp } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import type { TombstoneRecord } from '../records.js';

/**
 * A closed set rather than a string, so the re-index (§3.4) has a fixed list of
 * entity types to route on. `recurring_series` joined it when analysis started
 * writing: a re-run that re-groups a merchant's charges deletes the superseded
 * series, and a watermark query cannot see that any more than it can see a
 * deleted import. `category` joined it when §6.8's taxonomy editor made a
 * category something a person can remove.
 */
export type TombstoneEntity =
  | 'account'
  | 'statement_import'
  | 'transaction'
  | 'raw_row'
  | 'recurring_series'
  | 'category';

interface TombstoneRow {
  id: string;
  entity_type: string;
  entity_id: string;
  deleted_at: string;
}

export class TombstoneRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock
  ) {}

  record(entityType: TombstoneEntity, entityId: string): void {
    this.recordMany(entityType, [entityId]);
  }

  recordMany(entityType: TombstoneEntity, entityIds: readonly string[]): void {
    if (entityIds.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO tombstone (id, entity_type, entity_id, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const entityId of entityIds) {
      const stamp = newStamp(this.clock);
      insert.run(stamp.id, entityType, entityId, stamp.createdAt, stamp.createdAt, stamp.updatedAt);
    }
  }

  /** The re-index side: everything deleted at or after a watermark (§3.4). */
  listSince(deletedAtIso: string): TombstoneRecord[] {
    return this.db
      .prepare<[string], TombstoneRow>(
        `SELECT id, entity_type, entity_id, deleted_at
           FROM tombstone
          WHERE deleted_at >= ?
          ORDER BY deleted_at, id`
      )
      .all(deletedAtIso)
      .map((row) => ({
        id: row.id,
        entityType: row.entity_type,
        entityId: row.entity_id,
        deletedAt: row.deleted_at,
      }));
  }

  countFor(entityType: TombstoneEntity): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM tombstone WHERE entity_type = ?'
        )
        .get(entityType)?.n ?? 0
    );
  }
}

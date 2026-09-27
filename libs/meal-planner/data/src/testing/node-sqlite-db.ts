/**
 * `SqlDb` over better-sqlite3, for this lib's tests only (excluded from the build).
 *
 * The point is that migrations, repositories and the §11 decrement run against real
 * SQLite — the same engine the phone uses — rather than against a mock that agrees with
 * whatever the code under test assumes.
 */

import Database from 'better-sqlite3';
import type { Clock, SqlDb, SqlExecutor, SqlValue } from '../lib/sql.js';

export function nodeSqliteDb(): SqlDb & { close(): void } {
  const raw = new Database(':memory:');
  const executor: SqlExecutor = {
    async exec(sql: string) {
      raw.exec(sql);
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      raw.prepare(sql).run(...params);
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return raw.prepare(sql).all(...params) as T[];
    },
  };
  return {
    ...executor,
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      raw.exec('BEGIN');
      try {
        const result = await fn(executor);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => raw.close(),
  };
}

/** Ids `id-1`, `id-2`, …; each `now()` one second after the last, from 2026-09-27. */
export function testClock(): Clock & { tick(seconds: number): void } {
  let n = 0;
  let t = Date.parse('2026-09-27T12:00:00.000Z');
  return {
    newId: () => `id-${++n}`,
    now: () => {
      t += 1000;
      return new Date(t).toISOString();
    },
    tick: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

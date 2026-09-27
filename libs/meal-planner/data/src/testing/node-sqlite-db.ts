/**
 * `SqlDb` over better-sqlite3, for this lib's tests only (excluded from the build).
 *
 * The point is that migrations, repositories and the §11 decrement run against real
 * SQLite — the same engine the phone uses — rather than against a mock that agrees with
 * whatever the code under test assumes.
 *
 * It is stricter than SQLite in one way, on purpose: using the outer handle while a
 * transaction is open throws. On the phone the adapter queues every call behind the open
 * transaction (apps/meal-planner/src/app/data/capacitor-sql-db.ts), so a repository that
 * reads through `this.db` from inside its own transaction callback does not misbehave
 * there — it hangs forever. Here it fails the test instead.
 */

import Database from 'better-sqlite3';
import type { Clock, SqlDb, SqlExecutor, SqlValue } from '../lib/sql.js';

export function nodeSqliteDb(): SqlDb & { close(): void } {
  const raw = new Database(':memory:');
  let inTransaction = false;

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

  const outer = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (inTransaction) {
        return Promise.reject(new Error('outer database handle used inside a transaction: this deadlocks on the device'));
      }
      return fn(...args);
    };

  return {
    exec: outer(executor.exec),
    run: outer(executor.run),
    all: outer(executor.all) as SqlExecutor['all'],
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      if (inTransaction) throw new Error('nested transaction: this deadlocks on the device');
      raw.exec('BEGIN');
      inTransaction = true;
      try {
        const result = await fn(executor);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
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

/**
 * `SqlDb` (libs/meal-planner/data) over `@capacitor-community/sqlite`.
 *
 * ## One queue for everything
 *
 * The phone has one SQLite connection, and a transaction belongs to the connection, not
 * to the code that opened it. So every operation goes through a single promise chain, and
 * a transaction holds the chain until it commits: a write from another screen that
 * arrives mid-transaction waits instead of joining it. Inside the transaction, the
 * callback's `tx` talks to the connection directly — queueing it would deadlock on its
 * own transaction.
 *
 * The plugin's `run`/`execute` wrap each call in a transaction of their own unless told
 * not to; every call here passes `false`, because this adapter owns transactions.
 *
 * ## The web build keeps its database in memory
 *
 * jeep-sqlite runs sql.js in the page and only writes to IndexedDB on `saveToStore`. A
 * write that is never saved is lost on reload, so `persist` runs shortly after every
 * write, and again when the page is hidden. Native builds pass no `persist`: there the
 * database is a file and every commit is durable.
 */

import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { SqlDb, SqlExecutor, SqlValue } from '@metrum/meal-planner-data';

const PERSIST_DELAY_MS = 200;

export function capacitorSqlDb(conn: SQLiteDBConnection, persist: (() => Promise<void>) | null): SqlDb {
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
  };

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    if (persist) void enqueue(persist).catch((error) => console.error('Saving the database failed', error));
  };
  const schedulePersist = () => {
    if (!persist) return;
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(flush, PERSIST_DELAY_MS);
  };
  if (persist && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  const direct: SqlExecutor = {
    async exec(sql: string) {
      await conn.execute(sql, false);
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      await conn.run(sql, [...params], false);
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      const result = await conn.query(sql, [...params]);
      // iOS prepends a row naming the columns; harmless to filter everywhere.
      return (result.values ?? []).filter((row) => !('ios_columns' in row)) as T[];
    },
  };

  const write = async <T>(op: () => Promise<T>): Promise<T> => {
    const result = await enqueue(op);
    schedulePersist();
    return result;
  };

  return {
    exec: (sql) => write(() => direct.exec(sql)),
    run: (sql, params) => write(() => direct.run(sql, params)),
    all: <T>(sql: string, params?: readonly SqlValue[]) => enqueue(() => direct.all<T>(sql, params)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      write(async () => {
        await conn.beginTransaction();
        try {
          const result = await fn(direct);
          await conn.commitTransaction();
          return result;
        } catch (error) {
          await conn.rollbackTransaction();
          throw error;
        }
      }),
  };
}

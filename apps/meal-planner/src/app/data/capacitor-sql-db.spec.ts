import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import { capacitorSqlDb } from './capacitor-sql-db';

/** Records the order calls reach the connection. A `HOLD` run blocks until `release()`; `held` resolves once it has started. */
function fakeConnection() {
  const log: string[] = [];
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (started = resolve));
  const conn = {
    execute: async (sql: string, transaction: boolean) => {
      log.push(`execute:${sql}:${transaction}`);
    },
    run: async (sql: string, _values: unknown[], transaction: boolean) => {
      if (sql === 'HOLD') {
        const gate = new Promise<void>((resolve) => (release = resolve));
        started();
        await gate;
      }
      log.push(`run:${sql}:${transaction}`);
    },
    query: async (sql: string) => {
      log.push(`query:${sql}`);
      return { values: [{ ios_columns: ['a'] }, { a: 1 }] };
    },
    beginTransaction: async () => {
      log.push('BEGIN');
    },
    commitTransaction: async () => {
      log.push('COMMIT');
    },
    rollbackTransaction: async () => {
      log.push('ROLLBACK');
    },
  };
  return { conn: conn as unknown as SQLiteDBConnection, log, held, release: () => release() };
}

describe('capacitorSqlDb', () => {
  it('never lets the plugin open its own transaction', async () => {
    const { conn, log } = fakeConnection();
    const db = capacitorSqlDb(conn, null);
    await db.run('UPDATE x');
    await db.exec('CREATE TABLE y (id)');
    expect(log).toEqual(['run:UPDATE x:false', 'execute:CREATE TABLE y (id):false']);
  });

  it('holds other writes until the transaction commits', async () => {
    const { conn, log, held, release } = fakeConnection();
    const db = capacitorSqlDb(conn, null);
    const tx = db.transaction(async (t) => {
      await t.run('HOLD');
      await t.run('INSIDE');
    });
    const outside = db.run('OUTSIDE');
    await held;
    release();
    await Promise.all([tx, outside]);
    expect(log).toEqual(['BEGIN', 'run:HOLD:false', 'run:INSIDE:false', 'COMMIT', 'run:OUTSIDE:false']);
  });

  it('rolls back and rethrows when the callback fails, and keeps serving afterwards', async () => {
    const { conn, log } = fakeConnection();
    const db = capacitorSqlDb(conn, null);
    await expect(
      db.transaction(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await db.run('AFTER');
    expect(log).toEqual(['BEGIN', 'ROLLBACK', 'run:AFTER:false']);
  });

  it('drops the column-name row iOS prepends to query results', async () => {
    const { conn } = fakeConnection();
    const db = capacitorSqlDb(conn, null);
    expect(await db.all('SELECT a')).toEqual([{ a: 1 }]);
  });

  it('saves the web database after writes, not after reads', async () => {
    vi.useFakeTimers();
    const { conn } = fakeConnection();
    const persist = vi.fn(async () => undefined);
    const db = capacitorSqlDb(conn, persist);
    await db.all('SELECT a');
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).not.toHaveBeenCalled();
    await db.run('UPDATE x');
    await db.run('UPDATE y');
    await vi.advanceTimersByTimeAsync(500);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

import { nodeSqliteDb, testClock } from '../testing/node-sqlite-db.js';
import { MIGRATIONS, migrate } from './migrations.js';

describe('migrate', () => {
  it('creates every §3 table on a fresh database', async () => {
    const db = nodeSqliteDb();
    expect(await migrate(db, testClock())).toBe(MIGRATIONS.length);
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual([
      '_migrations',
      'meal_ingredients',
      'meals',
      'pantry_items',
      'plan_slots',
      'plans',
      'products',
      'settings',
    ]);
  });

  it('is a no-op the second time', async () => {
    const db = nodeSqliteDb();
    await migrate(db, testClock());
    await migrate(db, testClock());
    const applied = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations');
    expect(applied[0].n).toBe(MIGRATIONS.length);
  });

  it('applies only the migrations the database has not seen', async () => {
    const db = nodeSqliteDb();
    await migrate(db, testClock());
    const next = { version: MIGRATIONS.length + 1, name: 'probe', sql: 'CREATE TABLE probe (id TEXT)' };
    expect(await migrate(db, testClock(), [...MIGRATIONS, next])).toBe(next.version);
    expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'probe'")).toHaveLength(1);
  });

  it('leaves no trace of a migration that fails', async () => {
    const db = nodeSqliteDb();
    await migrate(db, testClock());
    const broken = { version: MIGRATIONS.length + 1, name: 'broken', sql: 'CREATE TABLE half (id TEXT); NOT SQL' };
    await expect(migrate(db, testClock(), [...MIGRATIONS, broken])).rejects.toThrow();
    expect(await db.all("SELECT name FROM sqlite_master WHERE name = 'half'")).toHaveLength(0);
    const applied = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM _migrations');
    expect(applied[0].n).toBe(MIGRATIONS.length);
  });

  it('enforces one live plan per date, and allows a new one after a soft delete', async () => {
    const db = nodeSqliteDb();
    await migrate(db, testClock());
    const insert = (id: string) =>
      db.run(
        "INSERT INTO plans (id, plan_date, kcal_budget, protein_target, created_at, updated_at) VALUES (?, '2026-09-27', 2000, 100, 'x', 'x')",
        [id],
      );
    await insert('a');
    await expect(insert('b')).rejects.toThrow(/UNIQUE/);
    await db.run("UPDATE plans SET deleted_at = 'x' WHERE id = 'a'");
    await insert('b');
  });
});

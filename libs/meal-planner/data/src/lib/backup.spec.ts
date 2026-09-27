import { nodeSqliteDb, testClock } from '../testing/node-sqlite-db.js';
import { EXPORT_FORMAT, deleteAll, exportAll } from './backup.js';
import { migrate } from './migrations.js';
import { PantryRepo } from './pantry.js';
import { PlansRepo } from './plans.js';
import { ProductsRepo } from './products.js';
import { DEFAULT_SETTINGS, SettingsRepo } from './settings.js';

async function setup() {
  const db = nodeSqliteDb();
  const clock = testClock();
  await migrate(db, clock);
  const products = new ProductsRepo(db, clock);
  const pantry = new PantryRepo(db, clock);
  const settings = new SettingsRepo(db);
  const oats = await products.create({
    barcode: null,
    name: 'Oats',
    brand: null,
    packageUnit: 'G',
    packageAmount: 1000,
    kcal: 379,
    proteinG: 13,
    source: 'manual',
  });
  const bag = await pantry.add({ productId: oats.id, packages: 1, expiresOn: null });
  await new PlansRepo(db, clock).create('2026-09-27', { kcalBudget: 2000, proteinTarget: 100 }, [
    { slotType: 'breakfast', mealId: null, pinned: false },
  ]);
  await settings.write({ defaultKcalBudget: 1800, usdaApiKey: 'secret-key' });
  return { db, clock, products, pantry, settings, oats, bag };
}

describe('exportAll', () => {
  it('dumps every table, deleted rows included, without the USDA key', async () => {
    const { db, clock, pantry, bag } = await setup();
    await pantry.remove(bag.id);
    const dump = await exportAll(db, clock);
    expect(dump.format).toBe(EXPORT_FORMAT);
    expect(dump.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(Object.keys(dump.tables)).toEqual(['products', 'pantry_items', 'meals', 'meal_ingredients', 'plans', 'plan_slots', 'settings']);
    expect(dump.tables['pantry_items']).toEqual([expect.objectContaining({ id: bag.id, deleted_at: expect.any(String) })]);
    expect(dump.tables['plan_slots']).toHaveLength(1);
    expect(dump.tables['settings'].map((r) => r['key'])).toContain('default_kcal_budget');
    expect(JSON.stringify(dump)).not.toContain('secret-key');
  });
});

describe('deleteAll', () => {
  it('soft-deletes everything and puts settings back to defaults', async () => {
    const { db, clock, products, pantry, settings, oats } = await setup();
    await deleteAll(db, clock);
    expect(await products.search('oats')).toEqual([]);
    expect(await pantry.list()).toEqual([]);
    expect(await new PlansRepo(db, clock).forDate('2026-09-27')).toBeNull();
    expect(await settings.read()).toEqual(DEFAULT_SETTINGS);
    // Soft, not hard: the rows are still there for a future sync to see.
    expect((await products.get(oats.id))?.deletedAt).not.toBeNull();
  });
});

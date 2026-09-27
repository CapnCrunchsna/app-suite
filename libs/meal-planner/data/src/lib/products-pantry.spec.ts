import type { ProductDraft } from '@metrum/meal-planner-domain';
import { nodeSqliteDb, testClock } from '../testing/node-sqlite-db.js';
import { migrate } from './migrations.js';
import { PantryRepo } from './pantry.js';
import { InvalidProductError, ProductsRepo } from './products.js';
import { DEFAULT_SETTINGS, SettingsRepo, slotsFor } from './settings.js';

const EGGS: ProductDraft = {
  barcode: '0001',
  name: 'Large Eggs',
  brand: 'Kirkland',
  packageUnit: 'COUNT',
  packageAmount: 12,
  kcal: 70,
  proteinG: 6,
  source: 'manual',
};
const MILK: ProductDraft = {
  barcode: null,
  name: 'Milk 2%',
  brand: null,
  packageUnit: 'ML',
  packageAmount: 2000,
  kcal: 50,
  proteinG: 3.4,
  source: 'off',
};

async function setup() {
  const db = nodeSqliteDb();
  const clock = testClock();
  await migrate(db, clock);
  return { db, clock, products: new ProductsRepo(db, clock), pantry: new PantryRepo(db, clock), settings: new SettingsRepo(db) };
}

describe('ProductsRepo', () => {
  it('derives the nutrition basis from the unit', async () => {
    const { products } = await setup();
    expect((await products.create(EGGS)).nutritionBasis).toBe('PER_UNIT');
    expect((await products.create(MILK)).nutritionBasis).toBe('PER_100');
  });

  it('refuses a product without a name or a package size', async () => {
    const { products } = await setup();
    await expect(products.create({ ...EGGS, name: '  ' })).rejects.toBeInstanceOf(InvalidProductError);
    await expect(products.create({ ...EGGS, packageAmount: 0 })).rejects.toThrow(/packageAmount/);
  });

  it('finds a live product by barcode and forgets a deleted one', async () => {
    const { products } = await setup();
    const eggs = await products.create(EGGS);
    expect((await products.byBarcode(' 0001 '))?.id).toBe(eggs.id);
    await products.remove(eggs.id);
    expect(await products.byBarcode('0001')).toBeNull();
    // …but a meal that uses it can still read its nutrition.
    expect((await products.get(eggs.id))?.deletedAt).not.toBeNull();
  });

  it('searches name and brand by every word, treating % and _ literally', async () => {
    const { products } = await setup();
    await products.create(EGGS);
    await products.create(MILK);
    await products.create({ ...MILK, name: '100% Juice' });
    expect((await products.search('kirk egg')).map((p) => p.name)).toEqual(['Large Eggs']);
    expect((await products.search('')).map((p) => p.name)).toEqual(['100% Juice', 'Large Eggs', 'Milk 2%']);
    expect((await products.search('%')).map((p) => p.name)).toEqual(['100% Juice', 'Milk 2%']);
  });

  it('lists products by most recent purchase for "buy again"', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    const milk = await products.create(MILK);
    await products.create({ ...MILK, name: 'Never bought' });
    await pantry.add({ productId: milk.id, packages: 1, expiresOn: null });
    await pantry.add({ productId: eggs.id, packages: 1, expiresOn: null });
    expect((await products.recentlyBought()).map((p) => p.name)).toEqual(['Large Eggs', 'Milk 2%']);
  });
});

describe('PantryRepo', () => {
  it('stores packages times the package size', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    const item = await pantry.add({ productId: eggs.id, packages: 2, expiresOn: '2026-10-10' });
    expect(item.quantity).toBe(24);
    expect(item.expiresOn).toBe('2026-10-10');
    expect(await pantry.stock()).toEqual(new Map([[eggs.id, 24]]));
  });

  it('lists live rows with their product, by name', async () => {
    const { products, pantry } = await setup();
    const milk = await products.create(MILK);
    const eggs = await products.create(EGGS);
    await pantry.add({ productId: milk.id, packages: 1, expiresOn: null });
    await pantry.add({ productId: eggs.id, packages: 1, expiresOn: null });
    const list = await pantry.list();
    expect(list.map((e) => [e.product.name, e.item.quantity])).toEqual([
      ['Large Eggs', 12],
      ['Milk 2%', 2000],
    ]);
    expect(list[0].product.brand).toBe('Kirkland');
  });

  it('removes with one call and restores the exact row on undo', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    const item = await pantry.add({ productId: eggs.id, packages: 1, expiresOn: null });
    await pantry.update(item.id, { quantity: 9, expiresOn: null });

    const undo = await pantry.remove(item.id);
    expect(await pantry.list()).toEqual([]);
    expect((await pantry.get(item.id))?.deletedAt).not.toBeNull();

    await pantry.restore(undo);
    const restored = await pantry.get(item.id);
    expect(restored?.quantity).toBe(9);
    expect(restored?.deletedAt).toBeNull();
  });

  it('treats editing a row down to zero as removing it', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    const item = await pantry.add({ productId: eggs.id, packages: 1, expiresOn: null });
    await pantry.update(item.id, { quantity: 0, expiresOn: null });
    expect((await pantry.get(item.id))?.deletedAt).not.toBeNull();
    await pantry.update(item.id, { quantity: 3, expiresOn: null });
    expect((await pantry.get(item.id))?.deletedAt).toBeNull();
  });

  it('creates new products and their rows together, or neither', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    const items = await pantry.addPurchases(
      [
        { product: eggs.id, packages: 2, expiresOn: null },
        { product: MILK, packages: 1, expiresOn: '2026-10-01' },
      ],
      products,
    );
    expect(items.map((i) => i.quantity)).toEqual([24, 2000]);
    expect((await products.search('milk')).map((p) => p.source)).toEqual(['off']);

    await expect(
      pantry.addPurchases(
        [
          { product: { ...MILK, name: 'Oat milk' }, packages: 1, expiresOn: null },
          { product: { ...MILK, name: '' }, packages: 1, expiresOn: null },
        ],
        products,
      ),
    ).rejects.toThrow(/name/);
    expect(await products.search('oat')).toEqual([]);
  });

  it('commits a bulk scan as all rows or none', async () => {
    const { products, pantry } = await setup();
    const eggs = await products.create(EGGS);
    await expect(
      pantry.addMany([
        { productId: eggs.id, packages: 1, expiresOn: null },
        { productId: 'no-such-product', packages: 1, expiresOn: null },
      ]),
    ).rejects.toThrow(/no product/);
    expect(await pantry.list()).toEqual([]);
    expect(await pantry.addMany([{ productId: eggs.id, packages: 1, expiresOn: null }])).toHaveLength(1);
  });
});

describe('SettingsRepo', () => {
  it('reads defaults until written, and reads back what it wrote', async () => {
    const { settings } = await setup();
    expect(await settings.read()).toEqual(DEFAULT_SETTINGS);
    const saved = await settings.write({ defaultKcalBudget: 1800, defaultSlots: { meals: 2, snacks: 2 } });
    expect(saved.defaultKcalBudget).toBe(1800);
    expect(saved.defaultSlots).toEqual({ meals: 2, snacks: 2 });
    expect(saved.defaultProteinTarget).toBe(100);
  });

  it('maps meal and snack counts to slots, clamped to what exists', () => {
    expect(slotsFor({ meals: 3, snacks: 1 })).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    expect(slotsFor({ meals: 1, snacks: 0 })).toEqual(['breakfast']);
    expect(slotsFor({ meals: 9, snacks: 9 })).toHaveLength(6);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generatePlans, type ProductDraft } from '@metrum/meal-planner-domain';
import { nodeSqliteDb, testClock } from '../testing/node-sqlite-db.js';
import { InvalidMealError, MealsRepo } from './meals.js';
import { migrate } from './migrations.js';
import { PantryRepo } from './pantry.js';
import { ProductsRepo } from './products.js';
import { loadSeedLibrary, type SeedLibrary } from './seed.js';

const EGGS: ProductDraft = { barcode: null, name: 'Eggs', brand: null, packageUnit: 'COUNT', packageAmount: 12, kcal: 70, proteinG: 6, source: 'manual' };
const MILK: ProductDraft = { barcode: null, name: 'Milk', brand: null, packageUnit: 'ML', packageAmount: 2000, kcal: 42, proteinG: 3.4, source: 'manual' };

async function setup() {
  const db = nodeSqliteDb();
  const clock = testClock();
  await migrate(db, clock);
  const products = new ProductsRepo(db, clock);
  return { db, clock, products, meals: new MealsRepo(db, clock), pantry: new PantryRepo(db, clock), eggs: await products.create(EGGS), milk: await products.create(MILK) };
}

describe('MealsRepo', () => {
  it('caches T1’s per-serving nutrition on the row', async () => {
    const { meals, eggs, milk } = await setup();
    const meal = await meals.create({
      name: 'Eggs & milk',
      servings: 1,
      slots: ['breakfast'],
      source: 'manual',
      sourceUrl: null,
      ingredients: [
        { productId: eggs.id, quantity: 2, unit: 'COUNT', displayText: '2 eggs', toTaste: false },
        { productId: milk.id, quantity: 240, unit: 'ML', displayText: '1 cup milk', toTaste: false },
        { productId: null, quantity: null, unit: null, displayText: 'Salt to taste', toTaste: true },
      ],
    });
    expect(meal.kcalPerServing).toBeCloseTo(240.8, 10);
    expect(meal.proteinPerServing).toBeCloseTo(20.16, 10);
    expect(meal.nutritionSource).toBe('ingredients');
    const saved = await meals.get(meal.id);
    expect(saved?.ingredients.map((i) => i.displayText)).toEqual(['2 eggs', '1 cup milk', 'Salt to taste']);
    expect(saved?.ingredients[2]).toMatchObject({ toTaste: true, productId: null });
  });

  it('refuses a meal with no mapped ingredient', async () => {
    const { meals } = await setup();
    await expect(
      meals.create({
        name: 'Air',
        servings: 1,
        slots: ['snack'],
        source: 'manual',
        sourceUrl: null,
        ingredients: [{ productId: null, quantity: null, unit: null, displayText: 'nothing', toTaste: false }],
      }),
    ).rejects.toBeInstanceOf(InvalidMealError);
  });

  it('replaces ingredients on update and keeps the old lines soft-deleted', async () => {
    const { db, meals, eggs } = await setup();
    const meal = await meals.create({
      name: 'Eggs',
      servings: 1,
      slots: ['breakfast'],
      source: 'manual',
      sourceUrl: null,
      ingredients: [{ productId: eggs.id, quantity: 2, unit: 'COUNT', displayText: '2 eggs', toTaste: false }],
    });
    const updated = await meals.update(meal.id, {
      name: 'Three eggs',
      servings: 1,
      slots: ['breakfast', 'lunch'],
      ingredients: [{ productId: eggs.id, quantity: 3, unit: 'COUNT', displayText: '3 eggs', toTaste: false }],
    });
    expect(updated).toMatchObject({ name: 'Three eggs', kcalPerServing: 210, slots: ['breakfast', 'lunch'] });
    const all = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM meal_ingredients WHERE meal_id = ?', [meal.id]);
    expect(all[0].n).toBe(2);
    expect((await meals.get(meal.id))?.ingredients).toHaveLength(1);
  });

  it('recomputes meals when a product’s nutrition is corrected, but keeps a site override', async () => {
    const { meals, products, eggs } = await setup();
    const line = { productId: eggs.id, quantity: 2, unit: 'COUNT' as const, displayText: '2 eggs', toTaste: false };
    const computed = await meals.create({ name: 'A', servings: 1, slots: ['breakfast'], source: 'manual', sourceUrl: null, ingredients: [line] });
    const trusted = await meals.create({
      name: 'B',
      servings: 1,
      slots: ['breakfast'],
      source: 'import',
      sourceUrl: 'https://example.test',
      ingredients: [line],
      siteNutrition: { kcal: 180, protein: 14 },
    });
    await products.update(eggs.id, { ...EGGS, kcal: 80 });
    expect((await meals.get(computed.id))?.meal.kcalPerServing).toBe(160);
    expect((await meals.get(trusted.id))?.meal).toMatchObject({ kcalPerServing: 180, proteinPerServing: 14, nutritionSource: 'site' });
  });

  it('gives the planner one serving’s needs per meal', async () => {
    const { meals, eggs } = await setup();
    await meals.create({
      name: 'Big omelette',
      servings: 2,
      slots: ['breakfast'],
      source: 'manual',
      sourceUrl: null,
      ingredients: [{ productId: eggs.id, quantity: 4, unit: 'COUNT', displayText: '4 eggs', toTaste: false }],
    });
    const [planned] = await meals.plannerMeals();
    expect(planned.needs).toEqual(new Map([[eggs.id, 2]]));
    expect(planned.kcal).toBe(140);
  });
});

describe('T2 — decrement, against SQLite', () => {
  it('takes 2 eggs and 240 ml, then one serving of a two-serving recipe', async () => {
    const { pantry, eggs, milk } = await setup();
    const eggRow = await pantry.add({ productId: eggs.id, packages: 0.75, expiresOn: null });
    await pantry.add({ productId: milk.id, packages: 1, expiresOn: null });
    expect((await pantry.stock()).get(eggs.id)).toBe(9);

    await pantry.consume(new Map([[eggs.id, 2], [milk.id, 240]]));
    expect(await pantry.stock()).toEqual(new Map([[eggs.id, 7], [milk.id, 1760]]));

    // A 2-serving meal listing 4 eggs draws 2 for one serving.
    await pantry.consume(new Map([[eggs.id, 4 / 2]]));
    expect((await pantry.get(eggRow.id))?.quantity).toBe(5);
  });

  it('runs short without failing, and undoes exactly', async () => {
    const { pantry, eggs } = await setup();
    const row = await pantry.add({ productId: eggs.id, packages: 1 / 12, expiresOn: null });
    const { undo, shortfalls } = await pantry.consume(new Map([[eggs.id, 3]]));
    expect(shortfalls).toEqual([{ productId: eggs.id, shortBy: 2 }]);
    expect((await pantry.get(row.id))?.deletedAt).not.toBeNull();
    await pantry.restore(undo);
    expect(await pantry.get(row.id)).toMatchObject({ quantity: 1, deletedAt: null });
  });
});

const readSeed = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../seed/${file}`, import.meta.url)), 'utf8'));
const SEED: SeedLibrary = { ...readSeed('products.json'), meals: readSeed('meals.json').meals };

describe('the starter library (§15)', () => {
  it('loads once, and not again after a seed meal is deleted', async () => {
    const db = nodeSqliteDb();
    const clock = testClock();
    await migrate(db, clock);
    expect(await loadSeedLibrary(db, clock, SEED)).toBe(true);
    const meals = new MealsRepo(db, clock);
    const count = (await meals.list()).length;
    expect(count).toBe(SEED.meals.length);
    await meals.remove((await meals.list())[0].id);
    expect(await loadSeedLibrary(db, clock, SEED)).toBe(false);
    expect(await meals.list()).toHaveLength(count - 1);
  });

  it('holds the eight T5 meals at exactly T5’s numbers, and plans T5 from them', async () => {
    const db = nodeSqliteDb();
    const clock = testClock();
    await migrate(db, clock);
    await loadSeedLibrary(db, clock, SEED);
    const meals = new MealsRepo(db, clock);
    const byName = new Map((await meals.list()).map((m) => [m.name, m]));
    const t5 = [
      ['Oatmeal & banana', 350, 12],
      ['Scrambled eggs', 250, 13],
      ['PB&J', 400, 15],
      ['Chicken & rice', 600, 45],
      ['Tuna sandwich', 450, 30],
      ['Spaghetti bolognese', 700, 35],
      ['Greek yogurt', 150, 15],
      ['Apple + peanut butter', 280, 8],
    ] as const;
    for (const [name, kcal, protein] of t5) {
      expect(byName.get(name)?.kcalPerServing).toBeCloseTo(kcal, 9);
      expect(byName.get(name)?.proteinPerServing).toBeCloseTo(protein, 9);
    }

    // T5 itself, on the seeded rows with an ample pantry: the same three plans.
    const t5Ids = new Set(t5.map(([name]) => byName.get(name)?.id));
    const planner = (await meals.plannerMeals()).filter((m) => t5Ids.has(m.id));
    const ample = new Map([...new Set(planner.flatMap((m) => [...m.needs.keys()]))].map((id) => [id, 1e6]));
    const nameOf = new Map([...byName.values()].map((m) => [m.id, m.name]));
    const result = generatePlans({ kcalBudget: 2000, proteinTarget: 100, slots: ['breakfast', 'lunch', 'dinner', 'snack'], meals: planner, pantry: ample });
    expect(result.level).toBe(0);
    expect(result.plans.map((p) => p.mealIds.map((id) => nameOf.get(id ?? '')))).toEqual([
      ['PB&J', 'Chicken & rice', 'Spaghetti bolognese', 'Apple + peanut butter'],
      ['Oatmeal & banana', 'Chicken & rice', 'Spaghetti bolognese', 'Apple + peanut butter'],
      ['PB&J', 'Chicken & rice', 'Spaghetti bolognese', 'Greek yogurt'],
    ]);
    expect(result.plans.map((p) => p.score)).toEqual([expect.closeTo(0.94, 9), expect.closeTo(0.79, 9), expect.closeTo(0.55, 9)]);
  });
});

/**
 * Generate Meal Planner's seeded starter library (meal-planner-spec.md §15):
 *
 *     node tools/make-meal-planner-seeds.mjs
 *
 * writes `libs/meal-planner/data/seed/{products,meals}.json`, which the app build copies to
 * `assets/seed/` (spec §15). Never edit those by hand; edit this and re-run.
 *
 * ## Why a generator
 *
 * §15 requires the eight §14 T5 meals to compute to *exactly* T5's per-serving kcal and
 * protein from ordinary ingredients, so the golden test doubles as seed validation. Two
 * targets need two free quantities: each T5 meal names two "balancing" ingredients, and
 * this script solves the 2×2 system for them over a grid of the meal's other quantities,
 * keeping solutions inside a sensible range and picking the one closest to a typical
 * portion. Hand-tuning that is a morning of arithmetic that breaks the moment one
 * product's nutrition is corrected.
 *
 * ## Why the balancing quantities are not rounded
 *
 * Two targets on a grid of round quantities almost never meet exactly, and "almost" is
 * not enough: T5's fifth plan totals exactly 1800 kcal, the floor of its calorie window,
 * so a seed that rounds to 1799.99 drops out of level 0 and the test stops matching the
 * spec. The solved quantities are kept at full precision (JSON round-trips a double
 * exactly); the ingredient's display text rounds them for people.
 *
 * Nutrition values are USDA-typical, rounded; per 100 g/ml, or per item for counted
 * products (spec §4). Every meal uses only seed products, so the planner has something to
 * plan with on first launch (§15).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'libs/meal-planner/data/seed');

export const SEED_VERSION = 1;

/** [key, name, unit, package size, kcal, protein] */
const PRODUCTS = [
  ['oats', 'Rolled oats', 'G', 1000, 379, 13.2],
  ['banana', 'Bananas', 'COUNT', 6, 105, 1.3],
  ['milk', 'Milk (2%)', 'ML', 2000, 50, 3.3],
  ['eggs', 'Large eggs', 'COUNT', 12, 72, 6.3],
  ['butter', 'Butter', 'G', 454, 717, 0.9],
  ['bread', 'Sandwich bread', 'COUNT', 20, 80, 3],
  ['pb', 'Peanut butter', 'G', 454, 600, 25],
  ['jam', 'Strawberry jam', 'G', 340, 250, 0.4],
  ['chicken', 'Chicken breast', 'G', 1000, 120, 22.5],
  ['rice', 'White rice', 'G', 2000, 365, 7.1],
  ['oil', 'Olive oil', 'G', 500, 884, 0],
  ['tuna', 'Tuna in water (drained)', 'G', 142, 116, 25.5],
  ['mayo', 'Mayonnaise', 'G', 887, 680, 1],
  ['spaghetti', 'Spaghetti', 'G', 454, 371, 13],
  ['beef', 'Ground beef (85% lean)', 'G', 454, 215, 18.6],
  ['marinara', 'Marinara sauce', 'G', 680, 50, 1.5],
  ['yogurt', 'Greek yogurt (nonfat)', 'G', 907, 59, 10.2],
  ['honey', 'Honey', 'G', 340, 304, 0.3],
  ['apple', 'Apples', 'COUNT', 6, 95, 0.5],
  ['cheddar', 'Cheddar cheese', 'G', 227, 403, 22.9],
  ['tortilla', 'Flour tortillas', 'COUNT', 10, 140, 3.6],
  ['beans', 'Black beans (canned)', 'G', 425, 91, 6],
  ['salsa', 'Salsa', 'G', 454, 36, 1.5],
  ['broccoli', 'Broccoli', 'G', 340, 34, 2.8],
  ['salmon', 'Salmon fillet', 'G', 454, 208, 20],
  ['potato', 'Potatoes', 'COUNT', 10, 160, 4.3],
  ['almonds', 'Almonds', 'G', 454, 579, 21],
  ['cottage', 'Cottage cheese', 'G', 454, 98, 11],
  ['spinach', 'Baby spinach', 'G', 142, 23, 2.9],
];

const product = Object.fromEntries(
  PRODUCTS.map(([key, name, unit, amount, kcal, protein]) => [key, { key, name, unit, amount, kcal, protein }]),
);

/** Per-unit factor: a counted product's figures are per item, the rest per 100. */
const factor = (key) => (product[key].unit === 'COUNT' ? 1 : 0.01);
const kcalOf = (key, q) => q * factor(key) * product[key].kcal;
const proteinOf = (key, q) => q * factor(key) * product[key].protein;

/**
 * The eight T5 meals. `fixed` quantities are tried over their grids; `balance` names the
 * two ingredients solved for, with their allowed range and preferred amount. Quantities
 * are for the whole recipe; targets are per serving.
 */
const T5 = [
  {
    key: 'oatmeal',
    name: 'Oatmeal & banana',
    slots: ['breakfast'],
    servings: 1,
    target: [350, 12],
    fixed: { banana: [1], honey: range(0, 15, 1) },
    balance: { oats: [30, 100, 50], milk: [0, 300, 150] },
    text: { oats: 'rolled oats', milk: 'milk', banana: '1 banana, sliced', honey: 'honey' },
  },
  {
    key: 'scrambled-eggs',
    name: 'Scrambled eggs',
    slots: ['breakfast'],
    servings: 1,
    target: [250, 13],
    fixed: { eggs: [2, 3], cheddar: range(0, 20, 1) },
    balance: { butter: [0, 15, 7], milk: [0, 60, 30] },
    text: { eggs: 'eggs', cheddar: 'shredded cheddar', butter: 'butter', milk: 'milk' },
  },
  {
    key: 'pbj',
    name: 'PB&J',
    slots: ['breakfast', 'lunch'],
    servings: 1,
    target: [400, 15],
    fixed: { bread: [2] },
    balance: { pb: [15, 45, 32], jam: [5, 40, 20] },
    text: { bread: '2 slices bread', pb: 'peanut butter', jam: 'strawberry jam' },
  },
  {
    key: 'chicken-rice',
    name: 'Chicken & rice',
    slots: ['lunch', 'dinner'],
    servings: 1,
    target: [600, 45],
    fixed: { broccoli: range(0, 150, 10), oil: range(0, 10, 1) },
    balance: { chicken: [100, 250, 170], rice: [40, 120, 75] },
    text: { chicken: 'chicken breast', rice: 'white rice (dry)', broccoli: 'broccoli', oil: 'olive oil' },
  },
  {
    key: 'tuna-sandwich',
    name: 'Tuna sandwich',
    slots: ['lunch'],
    servings: 1,
    target: [450, 30],
    fixed: { bread: [2], spinach: range(0, 30, 5) },
    balance: { tuna: [50, 142, 90], mayo: [5, 40, 20] },
    text: { bread: '2 slices bread', spinach: 'baby spinach', tuna: 'tuna, drained', mayo: 'mayonnaise' },
  },
  {
    key: 'spaghetti-bolognese',
    name: 'Spaghetti bolognese',
    slots: ['dinner'],
    servings: 4,
    target: [700, 35],
    fixed: { marinara: range(400, 680, 20), oil: range(0, 20, 5) },
    balance: { beef: [300, 500, 454], spaghetti: [300, 454, 400] },
    text: { beef: 'ground beef', oil: 'olive oil', spaghetti: 'spaghetti', marinara: 'marinara sauce' },
  },
  {
    key: 'greek-yogurt',
    name: 'Greek yogurt',
    slots: ['snack'],
    servings: 1,
    target: [150, 15],
    fixed: {},
    balance: { yogurt: [100, 250, 150], honey: [0, 30, 15] },
    text: { yogurt: 'Greek yogurt', honey: 'honey' },
  },
  {
    key: 'apple-pb',
    name: 'Apple + peanut butter',
    slots: ['snack'],
    servings: 1,
    target: [280, 8],
    fixed: { apple: [1] },
    balance: { pb: [10, 40, 30], honey: [0, 20, 5] },
    text: { apple: '1 apple, sliced', pb: 'peanut butter', honey: 'honey' },
  },
];

/** The rest of the starter library: ordinary quantities, nutrition whatever it comes to. */
const OTHERS = [
  meal('eggs-toast', 'Eggs on toast', ['breakfast'], 1, [['eggs', 2, '2 eggs'], ['bread', 2, '2 slices toast'], ['butter', 5, '1 tsp butter']]),
  meal('pb-toast', 'Peanut butter toast', ['breakfast', 'snack'], 1, [['bread', 1, '1 slice toast'], ['pb', 16, '1 tbsp peanut butter']]),
  meal('yogurt-parfait', 'Yogurt & oat parfait', ['breakfast'], 1, [['yogurt', 170, '¾ cup Greek yogurt'], ['oats', 30, '⅓ cup rolled oats'], ['honey', 10, '2 tsp honey'], ['banana', 0.5, '½ banana']]),
  meal('cottage-fruit', 'Cottage cheese & apple', ['breakfast', 'snack'], 1, [['cottage', 150, '⅔ cup cottage cheese'], ['apple', 1, '1 apple, chopped']]),
  meal('bean-burrito', 'Bean & cheese burrito', ['lunch', 'dinner'], 1, [['tortilla', 1, '1 large flour tortilla'], ['beans', 130, '½ can black beans'], ['cheddar', 30, '¼ cup shredded cheddar'], ['salsa', 60, '¼ cup salsa']]),
  meal('chicken-wrap', 'Chicken & spinach wrap', ['lunch'], 1, [['tortilla', 1, '1 flour tortilla'], ['chicken', 120, '120 g chicken breast, cooked'], ['spinach', 20, 'handful baby spinach'], ['mayo', 10, '2 tsp mayonnaise']]),
  meal('egg-salad', 'Egg salad sandwich', ['lunch'], 1, [['eggs', 2, '2 hard-boiled eggs'], ['mayo', 15, '1 tbsp mayonnaise'], ['bread', 2, '2 slices bread']]),
  meal('tuna-salad', 'Tuna & spinach salad', ['lunch'], 1, [['tuna', 142, '1 can tuna, drained'], ['spinach', 60, '2 cups baby spinach'], ['oil', 10, '2 tsp olive oil']]),
  meal('salmon-potato', 'Salmon, potato & broccoli', ['dinner'], 1, [['salmon', 170, '6 oz salmon fillet'], ['potato', 1, '1 potato, roasted'], ['broccoli', 100, '1 cup broccoli'], ['oil', 5, '1 tsp olive oil']]),
  meal('beef-tacos', 'Beef tacos', ['dinner'], 4, [['beef', 454, '1 lb ground beef'], ['tortilla', 8, '8 small flour tortillas'], ['cheddar', 110, '1 cup shredded cheddar'], ['salsa', 240, '1 cup salsa']]),
  meal('chicken-stir-fry', 'Chicken & broccoli stir-fry', ['dinner'], 2, [['chicken', 340, '¾ lb chicken breast'], ['broccoli', 300, '3 cups broccoli'], ['rice', 150, '¾ cup white rice (dry)'], ['oil', 15, '1 tbsp olive oil']]),
  meal('loaded-potato', 'Loaded baked potato', ['lunch', 'dinner'], 1, [['potato', 1, '1 large potato'], ['cheddar', 30, '¼ cup shredded cheddar'], ['broccoli', 80, '¾ cup broccoli'], ['butter', 5, '1 tsp butter']]),
  meal('rice-beans', 'Rice & beans', ['lunch', 'dinner'], 2, [['rice', 150, '¾ cup white rice (dry)'], ['beans', 425, '1 can black beans'], ['salsa', 120, '½ cup salsa']]),
  meal('almonds', 'Handful of almonds', ['snack'], 1, [['almonds', 28, '1 oz almonds']]),
  meal('banana-snack', 'Banana', ['snack'], 1, [['banana', 1, '1 banana']]),
  meal('boiled-eggs', 'Hard-boiled eggs', ['snack'], 1, [['eggs', 2, '2 hard-boiled eggs']]),
  meal('cheese-apple', 'Cheddar & apple', ['snack'], 1, [['cheddar', 30, '1 oz cheddar'], ['apple', 1, '1 apple, sliced']]),
];

// --------------------------------------------------------------------------------------

function range(from, to, step) {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function meal(key, name, slots, servings, lines) {
  return {
    key,
    name,
    slots,
    servings,
    ingredients: lines.map(([p, quantity, displayText]) => ({ product: p, quantity, displayText })),
  };
}

function* grid(fixed) {
  const keys = Object.keys(fixed);
  if (keys.length === 0) {
    yield {};
    return;
  }
  const [first, ...rest] = keys;
  const restGrid = Object.fromEntries(rest.map((k) => [k, fixed[k]]));
  for (const v of fixed[first]) for (const tail of grid(restGrid)) yield { [first]: v, ...tail };
}

function solve(spec) {
  const [kcalTarget, proteinTarget] = spec.target.map((t) => t * spec.servings);
  const [[a, [aMin, aMax, aPref]], [b, [bMin, bMax, bPref]]] = Object.entries(spec.balance);
  let best = null;
  for (const fixed of grid(spec.fixed)) {
    const k = kcalTarget - Object.entries(fixed).reduce((s, [p, q]) => s + kcalOf(p, q), 0);
    const pr = proteinTarget - Object.entries(fixed).reduce((s, [p, q]) => s + proteinOf(p, q), 0);
    // kcal: ka·x + kb·y = k ; protein: pa·x + pb·y = pr
    const ka = kcalOf(a, 1), kb = kcalOf(b, 1), pa = proteinOf(a, 1), pb = proteinOf(b, 1);
    const det = ka * pb - kb * pa;
    if (Math.abs(det) < 1e-12) continue;
    const x = (k * pb - kb * pr) / det;
    const y = (ka * pr - k * pa) / det;
    if (!(x >= aMin && x <= aMax && y >= bMin && y <= bMax)) continue;
    const cost = ((x - aPref) / aPref) ** 2 + ((y - bPref) / (bPref || 1)) ** 2;
    if (!best || cost < best.cost) best = { cost, quantities: { ...fixed, [a]: x, [b]: y } };
  }
  if (!best) throw new Error(`no solution for ${spec.key} in range; widen its grid or ranges`);
  return best.quantities;
}

function displayFor(spec, key, q) {
  const words = spec.text[key];
  if (/^\d|^½/.test(words)) return words;
  const unit = product[key].unit;
  const shown = Math.round(q);
  if (unit === 'COUNT') return `${shown} ${words}`;
  return `${shown} ${unit === 'G' ? 'g' : 'ml'} ${words}`;
}

const t5Meals = T5.map((spec) => {
  const quantities = solve(spec);
  const lines = Object.entries(quantities)
    .filter(([, q]) => q > 0)
    .map(([p, q]) => [p, q, displayFor(spec, p, q)]);
  return meal(spec.key, spec.name, spec.slots, spec.servings, lines);
});

// Check every T5 meal lands exactly on its target before writing anything.
for (const [i, m] of t5Meals.entries()) {
  const kcal = m.ingredients.reduce((s, l) => s + kcalOf(l.product, l.quantity), 0) / m.servings;
  const protein = m.ingredients.reduce((s, l) => s + proteinOf(l.product, l.quantity), 0) / m.servings;
  const [tk, tp] = T5[i].target;
  if (Math.abs(kcal - tk) > 1e-6 || Math.abs(protein - tp) > 1e-6) throw new Error(`${m.key}: ${kcal}/${protein}, wanted ${tk}/${tp}`);
  console.log(
    `${m.name.padEnd(22)} ${tk} kcal ${tp} g  ← ${m.ingredients.map((l) => `${Math.round(l.quantity * 10) / 10} ${l.product}`).join(', ')}`,
  );
}

for (const m of [...t5Meals, ...OTHERS]) {
  for (const l of m.ingredients) if (!product[l.product]) throw new Error(`${m.key} uses unknown product ${l.product}`);
}

mkdirSync(outDir, { recursive: true });
const products = PRODUCTS.map(([key, name, packageUnit, packageAmount, kcal, proteinG]) => ({
  key,
  name,
  packageUnit,
  packageAmount,
  kcal,
  proteinG,
}));
writeFileSync(join(outDir, 'products.json'), JSON.stringify({ version: SEED_VERSION, products }, null, 2) + '\n');
writeFileSync(join(outDir, 'meals.json'), JSON.stringify({ version: SEED_VERSION, meals: [...t5Meals, ...OTHERS] }, null, 2) + '\n');
console.log(`wrote ${products.length} products and ${t5Meals.length + OTHERS.length} meals to ${outDir}`);

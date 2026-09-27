/**
 * meal-planner-spec.md §6: the only place a cup, an ounce or a pound is understood.
 *
 * Everything past this boundary is `COUNT`, `G` or `ML`. Volume→mass needs a density,
 * which is food-specific; the table below covers the pantry staples recipes most often
 * measure by the cup, and every conversion through it is a *suggestion* the person
 * confirms (§6 rule 3). The app never guesses a density silently, because a wrong one
 * is invisible in the result and wrong by a factor of two.
 */

import type { BaseUnit } from './types.js';

export const ML_PER: Readonly<Record<VolumeUnit, number>> = {
  tsp: 5,
  tbsp: 15,
  floz: 30,
  cup: 240,
  ml: 1,
  l: 1000,
};

export const G_PER: Readonly<Record<MassUnit, number>> = {
  oz: 28.35,
  lb: 453.6,
  g: 1,
  kg: 1000,
};

export type VolumeUnit = 'tsp' | 'tbsp' | 'floz' | 'cup' | 'ml' | 'l';
export type MassUnit = 'oz' | 'lb' | 'g' | 'kg';
export type CountUnit = 'can' | 'slice' | 'clove' | 'pinch';
export type RawUnit = VolumeUnit | MassUnit | CountUnit;

const COUNT_UNITS: readonly string[] = ['can', 'slice', 'clove', 'pinch'];

export function baseUnitOf(raw: RawUnit): BaseUnit {
  if (raw in ML_PER) return 'ML';
  if (raw in G_PER) return 'G';
  if (COUNT_UNITS.includes(raw)) return 'COUNT';
  throw new Error(`unknown unit: ${raw}`);
}

/** `qty` of `raw` in its base unit. No unit at all is a count ("3 eggs"). */
export function toBase(qty: number, raw: RawUnit | null): { quantity: number; unit: BaseUnit } {
  if (raw === null) return { quantity: qty, unit: 'COUNT' };
  if (raw in ML_PER) return { quantity: qty * ML_PER[raw as VolumeUnit], unit: 'ML' };
  if (raw in G_PER) return { quantity: qty * G_PER[raw as MassUnit], unit: 'G' };
  return { quantity: qty, unit: 'COUNT' };
}

/**
 * Grams per US cup (§6). Matched on whole tokens of the product name; when several
 * entries match, the one naming more tokens wins, so "peanut butter" is not butter and
 * "brown sugar" is not sugar.
 */
export const DENSITY_G_PER_CUP: readonly { readonly tokens: readonly string[]; readonly gramsPerCup: number }[] = [
  { tokens: ['flour'], gramsPerCup: 120 },
  { tokens: ['oats'], gramsPerCup: 90 },
  { tokens: ['sugar'], gramsPerCup: 200 },
  { tokens: ['brown', 'sugar'], gramsPerCup: 220 },
  { tokens: ['rice'], gramsPerCup: 185 },
  { tokens: ['butter'], gramsPerCup: 227 },
  { tokens: ['peanut', 'butter'], gramsPerCup: 256 },
  { tokens: ['honey'], gramsPerCup: 340 },
  { tokens: ['cheese'], gramsPerCup: 113 },
  { tokens: ['cocoa'], gramsPerCup: 100 },
];

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

export function densityFor(productName: string): number | null {
  const tokens = new Set(nameTokens(productName));
  let best: { size: number; gramsPerCup: number } | null = null;
  for (const entry of DENSITY_G_PER_CUP) {
    if (!entry.tokens.every((t) => tokens.has(t))) continue;
    if (!best || entry.tokens.length > best.size) best = { size: entry.tokens.length, gramsPerCup: entry.gramsPerCup };
  }
  return best?.gramsPerCup ?? null;
}

/** A unit a person can enter an ingredient amount in (the Meal Builder's unit picker, §10). */
export type EntryUnit = 'item' | MassUnit | VolumeUnit;

/**
 * The units §10 lets a product be measured in: items for a counted product; mass units
 * for a weighed one, plus cups and spoons when the density table knows it (§6 rule 3);
 * volume units for a liquid.
 */
export function entryUnitsFor(product: { readonly packageUnit: BaseUnit; readonly name: string }): EntryUnit[] {
  if (product.packageUnit === 'COUNT') return ['item'];
  if (product.packageUnit === 'ML') return ['ml', 'l', 'cup', 'tbsp', 'tsp', 'floz'];
  const mass: EntryUnit[] = ['g', 'kg', 'oz', 'lb'];
  return densityFor(product.name) === null ? mass : [...mass, 'cup', 'tbsp', 'tsp'];
}

/** `amount` of `unit` in the product's base unit; null when §6 cannot convert it. */
export function entryToBase(
  amount: number,
  unit: EntryUnit,
  product: { readonly packageUnit: BaseUnit; readonly name: string },
): number | null {
  if (unit === 'item') return product.packageUnit === 'COUNT' ? amount : null;
  const base = toBase(amount, unit);
  const conversion = convertForProduct(base.quantity, base.unit, product);
  return conversion.kind === 'ask' ? null : conversion.quantity;
}

const UNIT_WORDS: Readonly<Record<EntryUnit, [string, string]>> = {
  item: ['item', 'items'],
  g: ['g', 'g'],
  kg: ['kg', 'kg'],
  oz: ['oz', 'oz'],
  lb: ['lb', 'lb'],
  ml: ['ml', 'ml'],
  l: ['L', 'L'],
  cup: ['cup', 'cups'],
  tbsp: ['tbsp', 'tbsp'],
  tsp: ['tsp', 'tsp'],
  floz: ['fl oz', 'fl oz'],
};

export function entryUnitWord(unit: EntryUnit, amount = 2): string {
  return UNIT_WORDS[unit][amount === 1 ? 0 : 1];
}

/**
 * What §6 rule 3 needs the person to confirm, or null when nothing was estimated.
 * "1 cup of Rolled oats is about 90 g."
 */
export function densityNote(unit: EntryUnit, product: { readonly packageUnit: BaseUnit; readonly name: string }): string | null {
  if (product.packageUnit !== 'G' || !(unit in ML_PER)) return null;
  const perUnit = entryToBase(1, unit, product);
  if (perUnit === null) return null;
  return `1 ${entryUnitWord(unit, 1)} of ${product.name} is about ${Math.round(perUnit * 10) / 10} g.`;
}

/**
 * What to do with an entered quantity for a given product (§6's four rules).
 *
 * - `direct`: the quantity is already in the product's unit.
 * - `confirm`: grams were derived through the density table; show them prefilled and
 *   make the person accept them.
 * - `ask`: nothing sensible can be derived; ask for the amount in the product's unit.
 */
export type Conversion =
  | { readonly kind: 'direct'; readonly quantity: number }
  | { readonly kind: 'confirm'; readonly quantity: number; readonly gramsPerCup: number }
  | { readonly kind: 'ask'; readonly unit: BaseUnit };

export function convertForProduct(
  quantity: number,
  from: BaseUnit,
  product: { readonly packageUnit: BaseUnit; readonly name: string },
): Conversion {
  const to = product.packageUnit;
  if (from === to) return { kind: 'direct', quantity };
  if (to === 'G' && from === 'ML') {
    const gramsPerCup = densityFor(product.name);
    if (gramsPerCup === null) return { kind: 'ask', unit: 'G' };
    return { kind: 'confirm', quantity: (quantity / ML_PER.cup) * gramsPerCup, gramsPerCup };
  }
  return { kind: 'ask', unit: to };
}

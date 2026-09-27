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

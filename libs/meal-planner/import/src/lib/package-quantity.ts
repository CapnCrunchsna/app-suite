/**
 * Open Food Facts' `quantity` field is free text typed by volunteers — "500 g", "1 L",
 * "2 x 150 g", "1,5 kg", "12", "12 oz (340 g)". This turns the common shapes into a
 * package size in a base unit (meal-planner-spec.md §7 step 3) and gives up on the rest,
 * leaving the field blank for the person to fill: a wrong package size silently skews
 * every "of" in the pantry, and a blank one is asked about.
 *
 * Only the first measure is read, so "12 oz (340 g)" is 340.2 g via the ounces.
 */

import type { BaseUnit } from '@metrum/meal-planner-domain';

export interface PackageQuantity {
  readonly unit: BaseUnit;
  readonly amount: number;
}

const UNITS: Readonly<Record<string, { unit: BaseUnit; factor: number }>> = {
  g: { unit: 'G', factor: 1 },
  gr: { unit: 'G', factor: 1 },
  gram: { unit: 'G', factor: 1 },
  grams: { unit: 'G', factor: 1 },
  kg: { unit: 'G', factor: 1000 },
  mg: { unit: 'G', factor: 0.001 },
  oz: { unit: 'G', factor: 28.35 },
  lb: { unit: 'G', factor: 453.6 },
  lbs: { unit: 'G', factor: 453.6 },
  ml: { unit: 'ML', factor: 1 },
  cl: { unit: 'ML', factor: 10 },
  dl: { unit: 'ML', factor: 100 },
  l: { unit: 'ML', factor: 1000 },
  lt: { unit: 'ML', factor: 1000 },
  litre: { unit: 'ML', factor: 1000 },
  liter: { unit: 'ML', factor: 1000 },
  'fl oz': { unit: 'ML', factor: 30 },
  gal: { unit: 'ML', factor: 3785 },
};

const MEASURE = /(?:(\d+)\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|[a-z]+)?/;

export function parsePackageQuantity(text: string | null | undefined): PackageQuantity | null {
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').trim();
  const match = MEASURE.exec(normalized);
  if (!match) return null;

  const multiplier = match[1] ? Number(match[1]) : 1;
  const value = Number(match[2]) * multiplier;
  if (!Number.isFinite(value) || value <= 0) return null;

  const word = match[3]?.replace(/\./g, '').replace(/\s+/g, ' ');
  if (!word) return { unit: 'COUNT', amount: value };
  const known = UNITS[word];
  if (known) return { unit: known.unit, amount: round(value * known.factor) };
  // "12 eggs", "6 pcs", "4 pack": a word that is not a measure counts items.
  return { unit: 'COUNT', amount: value };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

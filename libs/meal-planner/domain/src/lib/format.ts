/**
 * How a quantity reads to a person (meal-planner-spec.md §10's pantry rows):
 * `"9 of 12"`, `"420 g of 500 g"`, `"1.76 L of 2 L"`.
 *
 * ## "Of" what
 *
 * A pantry row is one purchase, and a purchase can be several packages: two cartons of
 * eggs is one row of 24. The "of" is therefore the whole packages the remainder still
 * spans — 21 left of two cartons reads "21 of 24", and once it drops to 11 it reads
 * "11 of 12", because that is one carton's worth. A product sold singly (a package of
 * one) has no "of" at all: twelve cans of tuna are "12", not "12 of 12".
 *
 * ## Units
 *
 * The display unit is chosen once, from the package, and both numbers use it. Choosing
 * per number would print "760 ml of 2 L", which makes the reader do the conversion the
 * app was supposed to do.
 */

import type { BaseUnit } from './types.js';

const EPS = 1e-9;

/** Up to two decimals, trailing zeros dropped: 1.76, 2, 0.5. */
export function trimNumber(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function scaleFor(unit: BaseUnit, amount: number): { divisor: number; suffix: string } {
  if (unit === 'G') return amount >= 1000 ? { divisor: 1000, suffix: ' kg' } : { divisor: 1, suffix: ' g' };
  if (unit === 'ML') return amount >= 1000 ? { divisor: 1000, suffix: ' L' } : { divisor: 1, suffix: ' ml' };
  return { divisor: 1, suffix: '' };
}

/** The whole packages `quantity` still spans; never less than one. */
export function packagesSpanned(quantity: number, packageAmount: number): number {
  if (packageAmount <= 0) return 1;
  return Math.max(1, Math.ceil(quantity / packageAmount - EPS));
}

export function formatRemaining(quantity: number, unit: BaseUnit, packageAmount: number): string {
  if (unit === 'COUNT' && packageAmount === 1) return trimNumber(quantity);
  const of = packagesSpanned(quantity, packageAmount) * packageAmount;
  const { divisor, suffix } = scaleFor(unit, of);
  return `${trimNumber(quantity / divisor)}${suffix} of ${trimNumber(of / divisor)}${suffix}`;
}

/** One amount on its own, e.g. an ingredient line: "2", "240 ml", "1.5 kg". */
export function formatAmount(quantity: number, unit: BaseUnit): string {
  const { divisor, suffix } = scaleFor(unit, quantity);
  return `${trimNumber(quantity / divisor)}${suffix}`;
}

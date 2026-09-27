/**
 * How a quantity reads to a person (meal-planner-spec.md §10's pantry rows):
 * `"9 of 12"`, `"420 g of 500 g"`, `"1.76 L of 2 L"`.
 *
 * The display unit is chosen once, from the package, and both numbers use it. Choosing
 * per number would print "760 ml of 2 L", which makes the reader do the conversion the
 * app was supposed to do.
 */

import type { BaseUnit } from './types.js';

/** Up to two decimals, trailing zeros dropped: 1.76, 2, 0.5. */
export function trimNumber(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function scaleFor(unit: BaseUnit, packageAmount: number): { divisor: number; suffix: string } {
  if (unit === 'G') return packageAmount >= 1000 ? { divisor: 1000, suffix: ' kg' } : { divisor: 1, suffix: ' g' };
  if (unit === 'ML') return packageAmount >= 1000 ? { divisor: 1000, suffix: ' L' } : { divisor: 1, suffix: ' ml' };
  return { divisor: 1, suffix: '' };
}

export function formatRemaining(quantity: number, unit: BaseUnit, packageAmount: number): string {
  const { divisor, suffix } = scaleFor(unit, packageAmount);
  return `${trimNumber(quantity / divisor)}${suffix} of ${trimNumber(packageAmount / divisor)}${suffix}`;
}

/** One amount on its own, e.g. an ingredient line: "2", "240 ml", "1.5 kg". */
export function formatAmount(quantity: number, unit: BaseUnit): string {
  const { divisor, suffix } = scaleFor(unit, quantity);
  return `${trimNumber(quantity / divisor)}${suffix}`;
}

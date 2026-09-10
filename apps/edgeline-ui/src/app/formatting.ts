/**
 * The part of §1's display edge that is Edgeline's alone: odds.
 *
 * Money, percentages, times and the missing-value convention moved to
 * `@metrum/ui` — both apps in this suite render integer cents and UTC ISO-8601
 * strings, so there is one implementation of that and one set of tests. Import
 * `formatCents`, `formatLocalTime` and friends from there.
 *
 * What stayed is what only this app has. §1 fixes odds as "decimal odds as REAL,
 * ≥ 6 significant digits; **American odds only at display edges**" — so the
 * conversion belongs at the edge, and the edge belongs to the one app that has
 * odds at all. Putting it in the shared UI lib would be exporting sports betting
 * to a statement analyser.
 */

import { NO_DATA } from '@metrum/ui';

/**
 * Decimal odds in the convention the sportsbook will quote back.
 *
 * Even money is the hinge: at 2.0 and above the payout is the plus figure, below
 * it the stake needed to win 100. Anything at or under 1.0 is not a price — it
 * pays less than the stake — so it renders as no data rather than as a very
 * large negative number.
 */
export function toAmerican(decimal: number | null | undefined): string {
  if (decimal === null || decimal === undefined || !Number.isFinite(decimal) || decimal <= 1) {
    return NO_DATA;
  }
  const american =
    decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
  return american > 0 ? `+${american}` : `${american}`;
}

/** Decimal odds at §1's precision, trimmed of trailing zeros — `1.9091`, `2`. */
export function formatDecimalOdds(decimal: number | null | undefined): string {
  if (decimal === null || decimal === undefined || !Number.isFinite(decimal)) return NO_DATA;
  return decimal.toFixed(4).replace(/\.?0+$/, '');
}

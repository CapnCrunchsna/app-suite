/**
 * §5.2's cadence fit.
 *
 * ## Why not just take the median delta and look it up in a table
 *
 * §5.2 rules that out explicitly, and the reason is the normal condition of this
 * app rather than an edge case: **a single missing statement turns one 30-day
 * delta into a 60-day one.** With three charges the median of `[30, 61]` is 45.5,
 * which matches no cadence at all — so a real monthly subscription becomes
 * invisible because one month was never imported. The Accounts coverage bar
 * exists because missing months are common.
 *
 * The fit therefore models the gap instead of averaging it away. For each
 * candidate cadence *C* and each delta, `k = round(delta ÷ C)` is how many cycles
 * that gap spans; the residual `r = delta − k·C` is how far off the cadence it
 * lands. A 61-day gap in a monthly series is `k = 2, r = 0.12` — a perfect fit
 * with one missed cycle, not a failure.
 *
 * `1 ≤ k ≤ 3` bounds that to two missed cycles. A consequence worth stating
 * because it is not obviously desirable: a monthly series with a six-month hole
 * fails the monthly fit outright rather than fitting it with a large `k`, so a
 * subscription that paused and resumed produces no series. That is §5.2 as
 * written, and it fails toward silence rather than toward a wrong cadence — the
 * direction §5.1's noise argument prefers.
 *
 * ## The four-weekly tie-break is not a nicety
 *
 * A true four-weekly series has deltas of exactly 28 and matches both four-weekly
 * and monthly. Getting it backwards understates every annualized number for those
 * series by 7.7% — 12 cadences a year instead of 13 — and §5.5's price creep
 * inherits the error. The rule is asymmetric on purpose: four-weekly wins only
 * when **every** delta is in 27–29 and there are at least six charges, because a
 * fixed-day-of-month subscription cannot produce that. Any span covering a 31-day
 * month forces a delta of 30 or 31.
 */

import { median } from './statistics.js';

export type CadenceLabel =
  'weekly' | 'biweekly' | 'four_weekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

export interface Cadence {
  readonly label: CadenceLabel;
  /** Mean days between charges. Fractional for the calendar-based cadences —
   *  `30.44` is 365.25 ÷ 12, not "a month". */
  readonly days: number;
  /** How far a residual may sit from the cadence and still count as a match. */
  readonly toleranceDays: number;
  /** Stored on the series rather than recomputed per rule (§5.2), so §5.5's
   *  `delta × cadences_per_year` and the Subscriptions page's annual totals
   *  cannot disagree. */
  readonly perYear: number;
}

/** Only the config this module actually reads. Taking the fields rather than the
 *  whole `AnalyzerConfig` keeps `config.ts` free to import the `Cadence` type
 *  from here without the two files importing each other. */
export interface CadenceFitOptions {
  readonly cadences: readonly Cadence[];
  readonly maxCyclesPerDelta: number;
  readonly fourWeeklyMinOccurrences: number;
  readonly fourWeeklyDeltaMinDays: number;
  readonly fourWeeklyDeltaMaxDays: number;
}

export interface CadenceFit {
  readonly cadence: Cadence;
  /** `delta − k·C` per delta, in days. §5.2's `regularity` is computed from the
   *  MAD of these, scaled by the cadence's own tolerance. */
  readonly residuals: readonly number[];
  /** `k` per delta — how many cycles each gap is assumed to span. `1` throughout
   *  means nothing was missed; larger values are the missed statements §5.2's fit
   *  exists to tolerate, and the tie-break below reads them. */
  readonly cycles: readonly number[];
  /** `median(|r|)` — the score the best cadence minimises. */
  readonly score: number;
}

/**
 * The best-fitting cadence for a sequence of gaps, or `null` when none fits.
 *
 * `deltaDays` is the gaps between consecutive charges in date order, not the
 * charge dates. `chargeCount` is passed separately because the four-weekly
 * tie-break counts charges rather than gaps, and `deltas.length + 1` would be a
 * silent assumption that the caller passed every gap.
 */
export function fitCadence(
  deltaDays: readonly number[],
  chargeCount: number,
  options: CadenceFitOptions,
): CadenceFit | null {
  if (deltaDays.length === 0) return null;

  const candidates: CadenceFit[] = [];

  for (const cadence of options.cadences) {
    const residuals: number[] = [];
    const cycles: number[] = [];
    let fits = true;

    for (const delta of deltaDays) {
      const spanned = Math.round(delta / cadence.days);
      if (spanned < 1 || spanned > options.maxCyclesPerDelta) {
        fits = false;
        break;
      }
      cycles.push(spanned);
      residuals.push(delta - spanned * cadence.days);
    }
    if (!fits) continue;

    const score = median(residuals.map(Math.abs));
    if (score > cadence.toleranceDays) continue;

    candidates.push({ cadence, residuals, cycles, score });
  }

  if (candidates.length === 0) return null;

  const fourWeekly = candidates.find((fit) => fit.cadence.label === 'four_weekly');
  const monthly = candidates.find((fit) => fit.cadence.label === 'monthly');

  // §5.2's explicit tie-break wins outright when both are in play. Score alone
  // gets it exactly backwards: a monthly series billed on the 1st runs 28–31 day
  // gaps, which fit four-weekly *better* than monthly.
  if (fourWeekly && monthly) {
    const everyDeltaInRange = deltaDays.every(
      (delta) => delta >= options.fourWeeklyDeltaMinDays && delta <= options.fourWeeklyDeltaMaxDays,
    );
    return everyDeltaInRange && chargeCount >= options.fourWeeklyMinOccurrences
      ? fourWeekly
      : monthly;
  }

  return bestOf(candidates);
}

/**
 * Lowest score wins. Ties go to the cadence that assumes the **fewest missed
 * cycles**, and that rule is doing real work rather than breaking a rare tie.
 *
 * §5.2 defines the score as `median(|r|)` and says "the best-scoring cadence
 * wins", but allowing `1 ≤ k ≤ 3` makes exact ties the normal case rather than
 * the exception: a run of 14-day gaps fits **weekly** with `k = 2` and a residual
 * of exactly zero, scoring identically to biweekly with `k = 1`. Every cadence is
 * degenerate with its own multiples this way, so a rule that fell back to
 * "shortest wins" would read every biweekly series as a weekly one that skips,
 * and every four-weekly series as a biweekly one that skips — halving the
 * annualized cost of all of them.
 *
 * Fewest assumed missing cycles is the parsimonious reading: "billed every two
 * weeks" explains the data without inventing eleven skipped charges that left no
 * trace on any statement. §5.2 does not state a tie-break, so this is a gap being
 * filled rather than a rule being overridden — recorded in §9c.
 */
function bestOf(candidates: readonly CadenceFit[]): CadenceFit {
  return [...candidates].sort(
    (a, b) => a.score - b.score || meanCycles(a) - meanCycles(b) || a.cadence.days - b.cadence.days,
  )[0];
}

function meanCycles(fit: CadenceFit): number {
  if (fit.cycles.length === 0) return 1;
  return fit.cycles.reduce((sum, spanned) => sum + spanned, 0) / fit.cycles.length;
}

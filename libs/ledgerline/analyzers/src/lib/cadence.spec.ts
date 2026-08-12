/**
 * §5.2's cadence fit, against the failures the section exists to prevent.
 *
 * These are literal arrays of day-gaps and nothing else — no snapshot, no
 * database, no fixture files — which is the property §2.2 promises for every rule
 * in §5 and the reason the analyzers are worth building before the API that runs
 * them.
 */

import { DEFAULT_CONFIG } from './config.js';
import { fitCadence } from './cadence.js';

const options = DEFAULT_CONFIG.recurrence;

describe('fitCadence', () => {
  it('reads a clean monthly series as monthly', () => {
    const fit = fitCadence([30, 31, 30, 31, 30], 6, options);

    expect(fit?.cadence.label).toBe('monthly');
    expect(fit?.cadence.perYear).toBe(12);
  });

  /**
   * The failure §5.2 names outright: "a single missing statement turns one 30-day
   * delta into a 60-day one, and with three charges the median of [30, 61] is
   * 45.5, which matches no cadence."
   */
  it('survives a missing statement instead of losing the series', () => {
    expect(fitCadence([30, 61], 3, options)?.cadence.label).toBe('monthly');
  });

  it('allows two missed cycles and no more', () => {
    // k = 3 — the stated limit.
    expect(fitCadence([30, 91], 3, options)?.cadence.label).toBe('monthly');
    // k = 6 for monthly. The gap is real, so no cadence is claimed rather than
    // one being stretched to cover it.
    expect(fitCadence([30, 183], 3, options)?.cadence.label).not.toBe('monthly');
  });

  describe('the four-weekly tie-break (§5.2)', () => {
    it('reads exact 28-day gaps as four-weekly once there are six charges', () => {
      const fit = fitCadence([28, 28, 28, 28, 28], 6, options);

      expect(fit?.cadence.label).toBe('four_weekly');
      // Getting this backwards understates every annualized number for the
      // series by 7.7% — 12 cadences a year instead of 13.
      expect(fit?.cadence.perYear).toBe(13.04);
    });

    it('will not call five charges four-weekly, however exact', () => {
      expect(fitCadence([28, 28, 28, 28], 5, options)?.cadence.label).toBe('monthly');
    });

    /**
     * The direction score alone gets wrong. A subscription billed on a fixed day
     * of the month runs 28–31 day gaps, which fit four-weekly *better* than
     * monthly — but no fixed-day subscription can produce all-28s, because any
     * span covering a 31-day month forces a 30 or 31.
     */
    it('keeps a fixed-day-of-month series monthly even when four-weekly scores better', () => {
      const deltas = [28, 31, 30, 31, 30, 31];
      const fit = fitCadence(deltas, 7, options);

      expect(fit?.cadence.label).toBe('monthly');
    });
  });

  it('reads the other cadences it is given', () => {
    expect(fitCadence([7, 7, 7], 4, options)?.cadence.label).toBe('weekly');
    expect(fitCadence([14, 14, 14], 4, options)?.cadence.label).toBe('biweekly');
    expect(fitCadence([91, 92, 91], 4, options)?.cadence.label).toBe('quarterly');
    expect(fitCadence([365, 366], 3, options)?.cadence.label).toBe('annual');
  });

  it('claims nothing for gaps that match no cadence', () => {
    expect(fitCadence([10, 47, 3], 4, options)).toBeNull();
    expect(fitCadence([], 1, options)).toBeNull();
  });

  it('scores a ragged series worse than a clean one', () => {
    const clean = fitCadence([30, 30, 30, 30], 5, options);
    const ragged = fitCadence([27, 34, 28, 33], 5, options);

    expect(clean?.cadence.label).toBe('monthly');
    expect(ragged?.cadence.label).toBe('monthly');
    // The residual spread is what §5.2's `regularity` reads.
    expect(ragged!.score).toBeGreaterThan(clean!.score);
  });
});

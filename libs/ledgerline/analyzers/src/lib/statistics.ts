/**
 * The robust statistics §5 is built on.
 *
 * Here rather than in `domain` because these exist for the analyzers and nothing
 * else reads them; `domain` carries the arithmetic the whole pipeline shares
 * (money, dates, the frozen collapse), and adding a statistics surface there
 * would make every lib depend on machinery only one of them uses.
 *
 * **Median and MAD, not mean and standard deviation.** §5.9 states the reason and
 * it applies to every rule here: a single $2,000 charge inflates a mean enough to
 * hide itself, and the whole point of an outlier rule is to catch the charge that
 * is unlike the others. The same asymmetry shows up in §5.2's cadence fit, where
 * one missing statement turns a 30-day delta into a 60-day one and a mean would
 * quietly move the estimate off every real cadence.
 *
 * Everything below takes and returns plain numbers. Money arrives as integer
 * cents (§7.3) and these functions never round it — a median of an even-length
 * sample is the mean of the middle two, which for cents can land on a half. The
 * caller rounds when it needs an integer, because only the caller knows whether
 * the value is about to be stored or only compared.
 */

/** Ascending copy. Every function here needs sorted input and none of them may
 *  reorder the caller's array. */
export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The middle value, or the mean of the middle two. `NaN` for an empty sample —
 *  a median of nothing is not zero, and returning zero would make an empty
 *  merchant look like a $0.00 median and flag every charge against it. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const order = sorted(values);
  const middle = order.length >> 1;
  return order.length % 2 === 1 ? order[middle] : (order[middle - 1] + order[middle]) / 2;
}

/** Median absolute deviation — the robust analogue of standard deviation.
 *  Deliberately *not* scaled by 1.4826 here; §5.9's modified z-score applies its
 *  own 0.6745 factor, and pre-scaling would apply the correction twice. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}

/**
 * §5.9's modified z-score: `0.6745 × (x − median) ÷ MAD`.
 *
 * Returns `null` when MAD is zero rather than `Infinity`. A perfectly steady
 * charge has no dispersion to measure against, and §5.9 handles that case with an
 * explicit `3 × median` fallback instead — a caller that got `Infinity` here
 * would flag every charge that differs by a cent.
 */
export function modifiedZScore(value: number, sample: readonly number[]): number | null {
  const mad = medianAbsoluteDeviation(sample);
  if (!Number.isFinite(mad) || mad === 0) return null;
  return (0.6745 * (value - median(sample))) / mad;
}

/**
 * Coefficient of variation — standard deviation over the mean, on the magnitudes.
 *
 * The one place §5 asks for a mean-based statistic, and it asks for it by name
 * (§5.2's `amount_stability`). It is measuring whether a subscription's price is
 * steady *within one price step*, a sample that has already been narrowed to a
 * few near-identical amounts, so the outlier sensitivity that rules out the mean
 * elsewhere does not apply.
 *
 * Zero for a sample of one: a single amount has no variation, and §5.2's caps
 * already hold a one- or two-charge series down independently.
 */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  if (values.length === 1) return 0;

  const magnitudes = values.map(Math.abs);
  const mean = magnitudes.reduce((total, value) => total + value, 0) / magnitudes.length;
  if (mean === 0) return 0;

  const variance =
    magnitudes.reduce((total, value) => total + (value - mean) ** 2, 0) / magnitudes.length;
  return Math.sqrt(variance) / mean;
}

/**
 * The value at `fraction` through the sorted sample, linearly interpolated.
 *
 * §5.9's global rule needs a 99th percentile over every debit in a window, and
 * the nearest-rank definition would make that percentile jump in steps of a whole
 * transaction on a small window.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const order = sorted(values);
  if (order.length === 1) return order[0];

  const position = (order.length - 1) * Math.min(Math.max(fraction, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return order[lower];
  return order[lower] + (order[upper] - order[lower]) * (position - lower);
}

/** Bound a value to a range. Used by every confidence formula in §5. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

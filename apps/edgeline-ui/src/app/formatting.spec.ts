/**
 * Edgeline's own half of §1's display edge.
 *
 * Money, percentages and times are tested once, in `@metrum/ui`'s
 * `format.spec.ts`. What is left here is the conversion §1 allows only at a
 * display edge, and the two ways it goes wrong: the hinge at even money, and a
 * "price" that is not one.
 */


import { formatDecimalOdds, toAmerican } from './formatting';
import { NO_DATA } from '@metrum/format';

describe('odds convert only at the display edge (§1)', () => {
  it('turns decimal into American on both sides of even money', () => {
    expect(toAmerican(2)).toBe('+100');
    expect(toAmerican(2.5)).toBe('+150');
    expect(toAmerican(3.5)).toBe('+250');
    expect(toAmerican(1.5)).toBe('-200');
    expect(toAmerican(1.909091)).toBe('-110');
  });

  /** A decimal price at or below 1 pays less than the stake, so it is not a
   *  price. Rendering it would produce a plausible-looking huge negative. */
  it('refuses odds that are not odds', () => {
    expect(toAmerican(1)).toBe(NO_DATA);
    expect(toAmerican(0.5)).toBe(NO_DATA);
    expect(toAmerican(null)).toBe(NO_DATA);
    expect(toAmerican(undefined)).toBe(NO_DATA);
  });

  it('keeps decimal precision without trailing zeros', () => {
    expect(formatDecimalOdds(1.9091)).toBe('1.9091');
    expect(formatDecimalOdds(1.9)).toBe('1.9');
    expect(formatDecimalOdds(2)).toBe('2');
    expect(formatDecimalOdds(100)).toBe('100');
    expect(formatDecimalOdds(null)).toBe(NO_DATA);
  });
});

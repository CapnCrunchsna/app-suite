/**
 * The two money formatters in this workspace render the same thing.
 *
 * There are two on purpose, and the reason is the boundary contract rather than
 * an oversight:
 *
 * - `@metrum/ledgerline-domain`'s is where §2.2 says it lives, and it has to
 *   stay there because `libs/ledgerline/analyzers` renders money into finding
 *   text and `type:analyzers` is allowed exactly one dependency, `type:domain`.
 *   Moving it would break the boundary lint or force a change to a contract the
 *   spec calls load-bearing.
 * - `@metrum/ui`'s is the one an app outside Ledgerline can reach. Edgeline is
 *   `scope:el` and may not depend on `scope:ll` at all, so it could not use the
 *   domain one even if the tags allowed it.
 *
 * That leaves the risk this file exists for: the two drift, and the same amount
 * renders differently depending on which screen you are looking at. This lib is
 * the only one allowed to import both (`type:feature` reaches `type:domain` and
 * `type:ui`), which makes it the only place the assertion can be made at all.
 *
 * If this fails, change whichever one moved — do not "fix" the test. The
 * agreement is the point.
 */

import { formatCents as domainFormatCents } from '@metrum/ledgerline-domain';
import { formatCents as sharedFormatCents } from '@metrum/ui';

/**
 * Integer cents only, which is the whole of §1's contract for money in both
 * apps. The implementations differ outside it — the domain one renders a
 * fractional cent as `$42.50.5` and the shared one refuses it — and pinning
 * undefined behaviour would only make the test harder to change than the code.
 */
const AMOUNTS = [
  0, 1, 9, 10, 99, 100, 101, 999, 1000, 1099, 4250, 25000, 100000, 123456789, 99999999999,
];

describe('the two formatCents implementations agree', () => {
  it('renders every positive amount identically', () => {
    for (const cents of AMOUNTS) {
      expect(sharedFormatCents(cents), `at ${cents}`).toBe(domainFormatCents(cents));
    }
  });

  it('renders every negative amount identically, sign included', () => {
    for (const cents of AMOUNTS) {
      expect(sharedFormatCents(-cents), `at ${-cents}`).toBe(domainFormatCents(-cents));
    }
  });

  it('agrees on the shapes a reader would notice', () => {
    // Spelled out as well as compared, so a failure says what changed rather
    // than only that something did.
    expect(domainFormatCents(4250)).toBe('$42.50');
    expect(sharedFormatCents(4250)).toBe('$42.50');
    expect(domainFormatCents(-100000)).toBe('-$1,000.00');
    expect(sharedFormatCents(-100000)).toBe('-$1,000.00');
    expect(domainFormatCents(1)).toBe('$0.01');
    expect(sharedFormatCents(1)).toBe('$0.01');
  });

  /**
   * The one deliberate difference, asserted so it stays deliberate: the shared
   * formatter takes `null` because Edgeline's API returns it, and the domain one
   * does not because Ledgerline's does not.
   */
  it('differs only in accepting a missing value', () => {
    expect(sharedFormatCents(null)).toBe('—');
    expect(sharedFormatCents(undefined)).toBe('—');
  });
});

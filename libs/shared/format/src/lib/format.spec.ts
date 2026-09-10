/**
 * The display edge, tested where getting it wrong is silent.
 *
 * Four failures this file exists to catch, all of which render *something*
 * plausible and are therefore invisible in a screenshot:
 *
 * 1. Cents treated as dollars — a $250 cap shown as $25,000.
 * 2. `null` rendered as zero — "no data yet" and "you lose every bet" drawn
 *    identically.
 * 3. A 0–1 ratio run through a percentage formatter — 55% shown as 0.55%.
 * 4. A UTC string rendered without conversion — the right instant in the wrong
 *    person's timezone.
 */

import {
  NO_DATA,
  centsFromDollars,
  dollarsFromCents,
  formatAge,
  formatCents,
  formatLocalClock,
  formatLocalDay,
  formatLocalTime,
  formatMagnitudeCents,
  formatMagnitudeDollars,
  formatPercent,
  formatRatioAsPercent,
  formatSignedCents,
  formatSignedPercent,
  isFresh,
  startOfLocalDayIso,
} from './format.js';

describe('money is rendered from integer cents', () => {
  it('divides by 100 and keeps both decimal places', () => {
    expect(formatCents(25000)).toBe('$250.00');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(0)).toBe('$0.00');
  });

  it('groups thousands, so a cap is not misread by an order of magnitude', () => {
    expect(formatCents(100000)).toBe('$1,000.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
  });

  it('puts the sign outside the dollar mark', () => {
    expect(formatCents(-4250)).toBe('-$42.50');
  });

  /** §7.3's amounts are signed and a spend table reading `-$1,099.00` all the
   *  way down is noise rather than information. */
  it('drops the sign for a column that is all one direction', () => {
    expect(formatMagnitudeCents(-109900)).toBe('$1,099.00');
    expect(formatMagnitudeCents(109900)).toBe('$1,099.00');
  });

  it('rounds to whole dollars where the cents are below the question', () => {
    expect(formatMagnitudeDollars(-909900)).toBe('$9,099');
    expect(formatMagnitudeDollars(4250)).toBe('$43');
  });

  it('signs P&L in both directions, because the direction is the question', () => {
    expect(formatSignedCents(4250)).toBe('+$42.50');
    expect(formatSignedCents(-4250)).toBe('-$42.50');
    expect(formatSignedCents(0)).toBe('$0.00');
  });

  it('renders a missing figure as no data, never as zero', () => {
    expect(formatCents(null)).toBe(NO_DATA);
    expect(formatCents(undefined)).toBe(NO_DATA);
    expect(formatMagnitudeCents(null)).toBe(NO_DATA);
    expect(formatMagnitudeDollars(undefined)).toBe(NO_DATA);
    expect(formatSignedCents(null)).toBe(NO_DATA);
    expect(formatCents(Number.NaN)).toBe(NO_DATA);
  });

  /** A blank cell rather than an em-dash, for the tables that want one. */
  it('lets the caller choose the fallback', () => {
    expect(formatMagnitudeCents(null, '')).toBe('');
    expect(formatCents(null, 'never')).toBe('never');
  });

  it('round-trips a form field through dollars without float drift', () => {
    expect(centsFromDollars(250)).toBe(25000);
    expect(centsFromDollars('12.34')).toBe(1234);
    // 8.29 * 100 is 828.9999… in binary floating point.
    expect(centsFromDollars(8.29)).toBe(829);
    expect(dollarsFromCents(25000)).toBe(250);
    expect(centsFromDollars('not a number')).toBeNull();
    expect(dollarsFromCents(null)).toBeNull();
  });
});

describe('percentages keep null apart from zero', () => {
  it('formats an already-percentage value', () => {
    expect(formatPercent(2.5)).toBe('2.50%');
    expect(formatPercent(0)).toBe('0.00%');
    expect(formatPercent(2.5, 0)).toBe('3%');
  });

  it('signs a figure where negative is the finding rather than an error', () => {
    expect(formatSignedPercent(1.234)).toBe('+1.23%');
    expect(formatSignedPercent(-1.234)).toBe('-1.23%');
  });

  it('never turns "nothing has settled" into "you lose every bet"', () => {
    expect(formatPercent(null)).toBe(NO_DATA);
    expect(formatSignedPercent(null)).toBe(NO_DATA);
    expect(formatRatioAsPercent(null)).toBe(NO_DATA);
    // The distinction an API draws on purpose — a real zero still renders.
    expect(formatRatioAsPercent(0)).toBe('0.0%');
  });

  it('scales a ratio, not a percentage', () => {
    // 11 wins in 20 settled. `0.6%` here would be the bug.
    expect(formatRatioAsPercent(0.55)).toBe('55.0%');
    expect(formatRatioAsPercent(1)).toBe('100.0%');
  });
});

describe('times render in the reader’s timezone', () => {
  const iso = '2026-09-08T14:03:00Z';

  it('never leaves the ISO string on screen', () => {
    const rendered = formatLocalTime(iso);
    expect(rendered).not.toContain('T');
    expect(rendered).not.toContain('Z');
  });

  it('shows the local reading for the instant, not the UTC one', () => {
    // Whatever the machine's zone and locale are, the hour shown has to be the
    // hour that zone puts this instant at. Asserting the literal '14' would only
    // pass in UTC — and would be the exact bug this file guards against. Both
    // clock conventions are accepted because the locale is the machine's too.
    const local = new Date(iso);
    const clock = formatLocalClock(iso);
    expect(
      clock.includes(String(local.getHours())) ||
        clock.includes(String(local.getHours() % 12 || 12)),
    ).toBe(true);
    expect(formatLocalDay(iso)).toContain(String(local.getDate()));
  });

  it('renders a missing or unparseable timestamp as the fallback', () => {
    expect(formatLocalTime(null)).toBe(NO_DATA);
    expect(formatLocalClock('')).toBe(NO_DATA);
    expect(formatLocalDay('nonsense')).toBe(NO_DATA);
    // Ledgerline's home page shows the raw value rather than an em-dash.
    expect(formatLocalDay('nonsense', 'nonsense')).toBe('nonsense');
  });
});

describe('age, for a timestamp whose meaning is how old it is', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');

  it('reads as an age, so something stopped is obvious without arithmetic', () => {
    expect(formatAge('2026-09-08T11:59:30Z', now)).toBe('30s ago');
    expect(formatAge('2026-09-08T11:56:00Z', now)).toBe('4 min ago');
    expect(formatAge('2026-09-08T09:00:00Z', now)).toBe('3h ago');
    expect(formatAge('2026-09-05T12:00:00Z', now)).toBe('3d ago');
  });

  it('says so rather than rendering a negative age', () => {
    expect(formatAge('2026-09-08T12:01:00Z', now)).toBe('in the future');
  });

  it('calls a timestamp stale past the window, and absent when there is none', () => {
    expect(isFresh('2026-09-08T11:59:00Z', 180, now)).toBe(true);
    expect(isFresh('2026-09-08T11:50:00Z', 180, now)).toBe(false);
    // "We have never seen one" is not "we saw one recently".
    expect(isFresh(null, 180, now)).toBe(false);
  });
});

describe('“today” is the reader’s day', () => {
  it('starts at local midnight, not UTC midnight', () => {
    const start = new Date(startOfLocalDayIso(new Date(2026, 8, 8, 17, 30)));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(0);
  });
});

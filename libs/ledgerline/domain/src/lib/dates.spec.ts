import { describe, expect, it } from 'vitest';

import { effectiveDate, isIsoDate, parseDateToIso } from './dates.js';

const iso = (input: string, format: string): string => {
  const result = parseDateToIso(input, format);
  if (!result.ok) throw new Error(`expected "${input}" / "${format}" to parse: ${result.reason}`);
  return result.iso;
};

describe('parseDateToIso', () => {
  it('parses the formats the bundled profiles declare', () => {
    expect(iso('01/03/2026', 'MM/DD/YYYY')).toBe('2026-01-03');
    expect(iso('2026-01-03', 'YYYY-MM-DD')).toBe('2026-01-03');
    expect(iso('Jan 3, 2026', 'MMM D, YYYY')).toBe('2026-01-03');
    expect(iso('3-JAN-2026', 'D-MMM-YYYY')).toBe('2026-01-03');
    expect(iso('1/3/26', 'M/D/YY')).toBe('2026-01-03');
  });

  /**
   * The reason `format_profile.date_format` exists at all. The same eight characters
   * are two different days depending on the bank, and a wrong guess does not fail — it
   * silently moves rows between months and corrupts every cadence estimate in §5.2.
   */
  it('reads the same string differently under different declared formats', () => {
    expect(iso('01/02/2026', 'MM/DD/YYYY')).toBe('2026-01-02');
    expect(iso('01/02/2026', 'DD/MM/YYYY')).toBe('2026-02-01');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDateToIso('02/30/2026', 'MM/DD/YYYY').ok).toBe(false);
    expect(parseDateToIso('13/01/2026', 'MM/DD/YYYY').ok).toBe(false);
    expect(parseDateToIso('02/29/2025', 'MM/DD/YYYY').ok).toBe(false);
    expect(iso('02/29/2024', 'MM/DD/YYYY')).toBe('2024-02-29'); // a real leap day
  });

  it('rejects input that does not match the declared format', () => {
    expect(parseDateToIso('2026-01-03', 'MM/DD/YYYY').ok).toBe(false);
    expect(parseDateToIso('', 'MM/DD/YYYY').ok).toBe(false);
    expect(parseDateToIso('Jan 3 2026', 'MMM D, YYYY').ok).toBe(false);
  });

  it('rejects an unrecognized month name rather than producing NaN', () => {
    expect(parseDateToIso('Xxx 3, 2026', 'MMM D, YYYY').ok).toBe(false);
  });

  it('rejects a format that cannot describe a whole date', () => {
    expect(parseDateToIso('01/2026', 'MM/YYYY').ok).toBe(false);
  });

  it('applies the documented two-digit-year pivot', () => {
    expect(iso('1/3/69', 'M/D/YY')).toBe('2069-01-03');
    expect(iso('1/3/70', 'M/D/YY')).toBe('1970-01-03');
  });

  it('is case-insensitive about month abbreviations', () => {
    expect(iso('jan 3, 2026', 'MMM D, YYYY')).toBe('2026-01-03');
    expect(iso('JAN 3, 2026', 'MMM D, YYYY')).toBe('2026-01-03');
  });
});

describe('isIsoDate', () => {
  it('accepts real ISO dates and rejects everything else', () => {
    expect(isIsoDate('2026-01-03')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-1-3')).toBe(false);
    expect(isIsoDate('01/03/2026')).toBe(false);
  });
});

describe('effectiveDate', () => {
  /** §7.1 — `COALESCE(transaction_date, posted_date)`, the single date all analysis uses. */
  it('prefers the transaction date and falls back to the posted date', () => {
    expect(effectiveDate('2026-01-03', '2026-01-05')).toBe('2026-01-03');
    expect(effectiveDate(null, '2026-01-05')).toBe('2026-01-05');
    expect(effectiveDate('2026-01-03', null)).toBe('2026-01-03');
    expect(effectiveDate(null, null)).toBeNull();
  });
});

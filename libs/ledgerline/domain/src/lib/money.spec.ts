import { describe, expect, it } from 'vitest';

import { formatCents, isOutflow, parseMoneyToCents } from './money.js';

const cents = (input: string): number => {
  const result = parseMoneyToCents(input);
  if (!result.ok) throw new Error(`expected "${input}" to parse: ${result.reason}`);
  return result.cents;
};

describe('parseMoneyToCents', () => {
  it('reads plain and comma-grouped USD amounts', () => {
    expect(cents('0')).toBe(0);
    expect(cents('4.75')).toBe(475);
    expect(cents('1234.56')).toBe(123456);
    expect(cents('1,234.56')).toBe(123456);
    expect(cents('1,234,567.89')).toBe(123456789);
    expect(cents('$1,234.56')).toBe(123456);
    expect(cents(' 42.10 ')).toBe(4210);
  });

  it('pads a single decimal rather than rounding it', () => {
    expect(cents('1.5')).toBe(150);
    expect(cents('1')).toBe(100);
  });

  it('reads every negative form banks actually print', () => {
    expect(cents('-45.00')).toBe(-4500);
    expect(cents('(45.00)')).toBe(-4500);
    expect(cents('45.00-')).toBe(-4500);
    expect(cents('-$1,200.00')).toBe(-120000);
  });

  it('treats a doubled negation as positive rather than dropping one', () => {
    expect(cents('(-45.00)')).toBe(4500);
  });

  /**
   * The property §3.1 exists to protect. Summing floats drifts; summing integers does
   * not. A tenth of a cent per row is invisible on an import screen and wrong by
   * dollars across a year, which is what every §5 threshold is measured in.
   */
  it('sums exactly, with no float in the path', () => {
    const rows = ['0.10', '0.20', '19.99', '0.07', '1.03'];
    const total = rows.reduce((sum, row) => sum + cents(row), 0);

    expect(total).toBe(2139);
    expect(Number.isInteger(total)).toBe(true);

    // The hazard being avoided, stated as the canonical case rather than as a claim
    // about these particular rows: in IEEE-754 the dollar amounts do not add up.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(cents('0.10') + cents('0.20')).toBe(cents('0.30'));
  });

  it('stays exact across a year of realistic amounts', () => {
    const amounts = Array.from({ length: 365 }, (_, i) => `${(i % 97) + 1}.${String(i % 100).padStart(2, '0')}`);
    const total = amounts.reduce((sum, a) => sum + cents(a), 0);

    expect(Number.isInteger(total)).toBe(true);
    expect(Number.isSafeInteger(total)).toBe(true);
  });

  it('refuses ambiguous non-US formatting instead of guessing', () => {
    // European decimal comma. Read as US thousands this is $1234.00 rather than $1.23 —
    // a 1000x error nothing downstream could catch.
    expect(parseMoneyToCents('1.234,56').ok).toBe(false);
    expect(parseMoneyToCents('1,23').ok).toBe(false);
    expect(parseMoneyToCents('12,34,567').ok).toBe(false);
  });

  it('refuses more than two decimal places', () => {
    expect(parseMoneyToCents('1.234').ok).toBe(false);
  });

  it('refuses values that are not amounts', () => {
    for (const input of ['', '   ', 'N/A', 'abc', '--5', '5..0', '$']) {
      expect(parseMoneyToCents(input).ok, input).toBe(false);
    }
  });

  it('reports a reason a human can act on', () => {
    const result = parseMoneyToCents('N/A');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('N/A');
  });
});

describe('formatCents', () => {
  it('round-trips through the parser', () => {
    for (const value of [0, 475, -4500, 123456789, -1]) {
      expect(cents(formatCents(value))).toBe(value);
    }
  });

  it('renders sign, grouping and two decimals', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-4500)).toBe('-$45.00');
    expect(formatCents(123456789)).toBe('$1,234,567.89');
    expect(formatCents(5)).toBe('$0.05');
  });
});

describe('isOutflow', () => {
  it('is exactly the sign convention in §3.1', () => {
    expect(isOutflow(-1)).toBe(true);
    expect(isOutflow(0)).toBe(false);
    expect(isOutflow(1)).toBe(false);
  });
});

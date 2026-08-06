/**
 * Dates, as ISO `YYYY-MM-DD` strings (§3.1).
 *
 * Every date is parsed against an **explicit format declared by the profile**, never
 * sniffed and never handed to `Date.parse`. `01/02/2026` is January 2nd in the US and
 * February 1st almost everywhere else, and there is nothing in a CSV cell that
 * disambiguates it. A guess here does not fail loudly — it silently shifts rows between
 * months, which corrupts every cadence estimate in §5.2 and every monthly aggregate in
 * §5.10. `format_profile.date_format` exists precisely so this is a declaration.
 */

/** Tokens understood in a profile's `date_format`, longest first so `MM` cannot
 *  shadow `MMM` during the scan. */
const TOKENS = ['YYYY', 'MMM', 'YY', 'MM', 'DD', 'M', 'D'] as const;
type Token = (typeof TOKENS)[number];

const TOKEN_PATTERN: Record<Token, string> = {
  YYYY: '(\\d{4})',
  YY: '(\\d{2})',
  MMM: '([A-Za-z]{3})',
  MM: '(\\d{2})',
  M: '(\\d{1,2})',
  DD: '(\\d{2})',
  D: '(\\d{1,2})',
};

const MONTH_ABBR: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Two-digit-year pivot. Statements are recent documents, but a `YY` format is still
 * genuinely ambiguous, so the standard POSIX pivot is used and stated rather than
 * left implicit: 00–69 → 2000s, 70–99 → 1900s.
 */
const YY_PIVOT = 70;

export type DateParse =
  | { readonly ok: true; readonly iso: string }
  | { readonly ok: false; readonly reason: string };

interface CompiledFormat {
  readonly regex: RegExp;
  readonly order: readonly Token[];
}

const compiledCache = new Map<string, CompiledFormat | null>();

function compileFormat(format: string): CompiledFormat | null {
  const cached = compiledCache.get(format);
  if (cached !== undefined) return cached;

  const order: Token[] = [];
  let pattern = '';
  let i = 0;

  outer: while (i < format.length) {
    for (const token of TOKENS) {
      if (format.startsWith(token, i)) {
        order.push(token);
        pattern += TOKEN_PATTERN[token];
        i += token.length;
        continue outer;
      }
    }
    // Anything that is not a token is a literal separator.
    pattern += format[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  const hasYear = order.includes('YYYY') || order.includes('YY');
  const hasMonth = order.includes('MMM') || order.includes('MM') || order.includes('M');
  const hasDay = order.includes('DD') || order.includes('D');

  const compiled =
    hasYear && hasMonth && hasDay
      ? { regex: new RegExp(`^${pattern}$`), order }
      : null;

  compiledCache.set(format, compiled);
  return compiled;
}

/** Rejects impossible calendar dates such as 2026-02-30, which a naive
 *  string assembly would happily produce. */
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

export function parseDateToIso(input: string, format: string): DateParse {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return { ok: false, reason: 'empty date' };

  const compiled = compileFormat(format);
  if (!compiled) {
    return {
      ok: false,
      reason: `date_format "${format}" must contain a year, a month and a day token (YYYY/YY, MMM/MM/M, DD/D)`,
    };
  }

  const match = compiled.regex.exec(raw);
  if (!match) {
    return { ok: false, reason: `"${input}" does not match date_format "${format}"` };
  }

  let year = NaN;
  let month = NaN;
  let day = NaN;

  compiled.order.forEach((token, index) => {
    const value = match[index + 1];
    switch (token) {
      case 'YYYY':
        year = Number(value);
        break;
      case 'YY': {
        const yy = Number(value);
        year = yy < YY_PIVOT ? 2000 + yy : 1900 + yy;
        break;
      }
      case 'MMM':
        month = MONTH_ABBR[value.toUpperCase()] ?? NaN;
        break;
      case 'MM':
      case 'M':
        month = Number(value);
        break;
      case 'DD':
      case 'D':
        day = Number(value);
        break;
    }
  });

  if (Number.isNaN(month)) {
    return { ok: false, reason: `"${input}" has an unrecognized month name` };
  }
  if (!isRealDate(year, month, day)) {
    return { ok: false, reason: `"${input}" is not a real calendar date` };
  }

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { ok: true, iso };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  return isRealDate(y, m, d);
}

/**
 * `effective_date = COALESCE(transaction_date, posted_date)` — §2.5 and §7.1.
 *
 * This is the single date every analyzer, every aggregate and the dedupe key use.
 * `posted_date` is kept for display and for reconciling against the printed statement,
 * and is never used for cadence: posting drifts across weekends, which would inject
 * two days of noise into every monthly series and force wider cadence windows than the
 * data warrants.
 */
export function effectiveDate(
  transactionDate: string | null,
  postedDate: string | null
): string | null {
  return transactionDate ?? postedDate;
}

/**
 * A closed interval of ISO dates — both ends inclusive.
 *
 * §2.1 puts `DateRange` in `domain` alongside `Money`, and §3.4's repository
 * examples (`listDebitsByMerchant(range)`, `monthlyCategoryTotals(range)`) take
 * one. Inclusive on both ends because every window in this app is a statement
 * period or a calendar month, and a half-open month boundary is how the last day
 * of January goes missing from a monthly total.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

const MS_PER_DAY = 86_400_000;

function toUtcMillis(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Shift an ISO date by a whole number of days, staying in UTC.
 *
 * UTC rather than local time because a local-time shift crosses a daylight
 * saving boundary twice a year and lands on the same calendar day it started
 * from — which would silently narrow §3.3's ±3 day near-duplicate window to two
 * days for one week in March.
 */
export function addDaysIso(iso: string, days: number): string {
  const shifted = new Date(toUtcMillis(iso) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** Signed whole days from `a` to `b`. Both are midnight UTC, so this is exact. */
export function daysBetweenIso(a: string, b: string): number {
  return Math.round((toUtcMillis(b) - toUtcMillis(a)) / MS_PER_DAY);
}

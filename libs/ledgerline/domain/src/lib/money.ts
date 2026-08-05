/**
 * Money, as a signed integer count of cents.
 *
 * There is deliberately no float anywhere in this module. `0.1 + 0.2` is
 * `0.30000000000000004` in IEEE-754, and a cent of drift per row compounds into a
 * wrong finding over a year of statements. ledgerline-spec.md §3.1: "Money is always
 * integer `amount_cents`, never a float." The parse below therefore reads the integer
 * and fraction parts as *strings* and never calls `parseFloat`.
 *
 * Sign convention (§3.1), applied uniformly across checking and credit cards:
 * **negative = money leaving the account.** Banks disagree about this — a credit-card
 * CSV usually prints a purchase as a positive number — and that disagreement is
 * absorbed by the per-profile mapping in `ledgerline-parsing`, not here. By the time a
 * value reaches this module it is already in the house convention.
 *
 * v1 is single-currency USD (§3.2, and plan artifact question 5, resolved 2026-08-03),
 * which is why `,` is treated as a thousands separator and `.` as the decimal point.
 * A string that is not unambiguously US-formatted is refused rather than guessed at.
 */

/** Result of parsing a money string. Parsing failures are values, not exceptions: one
 *  bad cell should degrade to a row-level parse error on the review screen, not abort
 *  an entire import. */
export type MoneyParse =
  | { readonly ok: true; readonly cents: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict US currency shape, checked *after* sign and currency-symbol handling:
 * either a run of digits, or comma-grouped thousands, with at most two decimals.
 *
 * The grouping alternative is what makes European formatting fail loudly. `1.234,56`
 * and `1,234` mean different things in different locales; reading the second as
 * $1,234.00 when it meant €1.234 is a 1000x error that no downstream check would
 * catch. Refusing is the only safe behaviour, and §3.2's `CHECK (currency =
 * account.currency)` exists for the same reason.
 */
const US_MONEY = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;

export function parseMoneyToCents(input: string): MoneyParse {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'not a string' };
  }

  let s = input.trim();
  if (s === '') {
    return { ok: false, reason: 'empty' };
  }

  let negative = false;

  // Accounting parentheses: "(45.00)" is -45.00. Common in credit-card exports.
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Currency symbols, non-breaking spaces, and internal whitespace carry no meaning.
  s = s.replace(/USD/gi, '').replace(/[$\s\u00A0]/g, '');

  // Leading sign, then trailing sign. Some mainframe-era exports print "45.00-".
  // Both are toggles so "(-45.00)" resolves to a positive number rather than silently
  // dropping one of the two negations.
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.endsWith('+')) {
    s = s.slice(0, -1);
  }

  if (s === '') {
    return { ok: false, reason: `no digits in "${input}"` };
  }

  if (!US_MONEY.test(s)) {
    return {
      ok: false,
      reason: `"${input}" is not an unambiguous USD amount (expected e.g. 1234.56, 1,234.56, (45.00), -45.00)`,
    };
  }

  const digits = s.replace(/,/g, '');
  const dot = digits.indexOf('.');
  const intPart = dot === -1 ? digits : digits.slice(0, dot);
  const fracPart = dot === -1 ? '' : digits.slice(dot + 1);

  // padEnd, not round: "1.5" is 150 cents. The regex already capped this at two
  // digits, so nothing is being truncated here.
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));

  if (!Number.isSafeInteger(cents)) {
    return { ok: false, reason: `"${input}" exceeds safe integer range` };
  }

  // `-0` is deliberately collapsed to `0`. A trial authorization parses to zero cents
  // (§5.6), and negating it yields IEEE-754 negative zero, which compares unequal to 0
  // under `Object.is` and serializes as `-0` in JSON. Nothing downstream should have to
  // know that.
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

/** Render signed cents for display. Never used in arithmetic. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
}

/** True when this amount represents money leaving the account (§3.1). */
export function isOutflow(cents: number): boolean {
  return cents < 0;
}

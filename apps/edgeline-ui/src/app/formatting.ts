/**
 * The display edge — the only place in this app where §1's representations stop
 * being what they are stored as.
 *
 * §1 fixes three of them and §11.2 says what the UI owes each:
 *
 * - **Money is integer cents everywhere.** `stake_cents`, `pnl_cents`,
 *   `delta_cents`, `total_cents`. Nothing here divides by 100 except
 *   `formatCents`, and nothing outside here should.
 * - **Odds are decimal**, "American odds only at display edges" — so the
 *   conversion lives here and the value on the wire stays decimal.
 * - **Times are UTC ISO-8601 strings, converted only in the UI.** That is this
 *   file. A raw `…T14:03:00Z` on screen is a bug: it is the right instant shown
 *   in the wrong person's timezone.
 *
 * ## `null` is not zero, and this file is where that survives
 *
 * `hit_rate`, `avg_clv_pct` and a result's `clv_pct` come back as `null` — not
 * `0` — when nothing has settled or no closing line was captured (§12). The
 * distinction is deliberate on the API side and it is cheap to destroy here: a
 * formatter that renders `null` as `0.0%` turns "we have no data" into "you lose
 * every bet". Every function below takes `null | undefined` and renders the
 * em-dash, and callers that want a sentence instead say so themselves.
 */

/** What a missing number renders as. Never `0`, never blank. */
export const NO_DATA = '—';

/**
 * Cents to dollars. Two decimal places always: these are stakes, and `$12.5`
 * beside `$12.50` in a column reads as a different kind of number.
 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return NO_DATA;
  const dollars = cents / 100;
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The same, with the sign always shown. For P&L, where the reader's question is
 * "up or down" before it is "how much" — and where an unsigned `$0.00` and an
 * unsigned loss look identical at a glance.
 */
export function formatSignedCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return NO_DATA;
  return `${cents > 0 ? '+' : ''}${formatCents(cents)}`;
}

/** Dollars typed into a form back to §1's integer cents. */
export function centsFromDollars(dollars: number | string): number | null {
  const value = typeof dollars === 'string' ? Number(dollars) : dollars;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Cents into a number a dollars-denominated `<input type="number">` accepts. */
export function dollarsFromCents(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
  return cents / 100;
}

/**
 * A percentage that is already expressed as a percentage — `edge_pct`,
 * `clv_pct`, `ev_threshold_pct`. Not a 0–1 ratio; see `formatRatioAsPercent`.
 */
export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA;
  return `${value.toFixed(fractionDigits)}%`;
}

/** The same with a sign, for CLV — where negative is the finding, not an error. */
export function formatSignedPercent(
  value: number | null | undefined,
  fractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA;
  return `${value > 0 ? '+' : ''}${value.toFixed(fractionDigits)}%`;
}

/**
 * `hit_rate` arrives as wins/settled — a ratio in 0–1, not a percentage. Getting
 * this backwards renders a 55% hit rate as "0.55%", which reads as a catastrophe
 * rather than a good week.
 */
export function formatRatioAsPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA;
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

/**
 * §1: "Decimal odds as REAL … American odds only at display edges." Both are
 * shown, because the decimal number is what the engine reasoned about and the
 * American one is what the sportsbook will say back to you.
 */
export function toAmerican(decimal: number | null | undefined): string {
  if (decimal === null || decimal === undefined || !Number.isFinite(decimal) || decimal <= 1) {
    return NO_DATA;
  }
  const american =
    decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
  return american > 0 ? `+${american}` : `${american}`;
}

/** Decimal odds at §1's six significant digits, trimmed of trailing zeros. */
export function formatDecimalOdds(decimal: number | null | undefined): string {
  if (decimal === null || decimal === undefined || !Number.isFinite(decimal)) return NO_DATA;
  return decimal.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * A UTC instant in the reader's timezone. §11.2: "all times rendered in the
 * user's tz", and §1 explains why the string on the wire is not: converting
 * anywhere but here means two places that can disagree about what "today" is.
 */
export function formatLocalTime(iso: string | null | undefined): string {
  const date = parseUtc(iso);
  if (!date) return NO_DATA;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Just the clock part, for a table whose rows are all from today. */
export function formatLocalClock(iso: string | null | undefined): string {
  const date = parseUtc(iso);
  if (!date) return NO_DATA;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Just the calendar day, in the reader's timezone — which is the one that
 *  decides whether a UTC-stamped bucket is "today". */
export function formatLocalDay(iso: string | null | undefined): string {
  const date = parseUtc(iso);
  if (!date) return NO_DATA;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "4 minutes ago". The dashboard's heartbeat reading is an age, not a
 * timestamp: §13 stamps `last_heartbeat_at` every 60 seconds, so what tells you
 * the worker died is how old it is, and a reader should not have to do the
 * subtraction.
 */
export function formatAge(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parseUtc(iso);
  if (!date) return NO_DATA;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Whether the same instant is within `maxAgeS` of now. */
export function isFresh(
  iso: string | null | undefined,
  maxAgeS: number,
  now: number = Date.now(),
): boolean {
  const date = parseUtc(iso);
  if (!date) return false;
  return now - date.getTime() <= maxAgeS * 1000;
}

/** The start of today in the *reader's* timezone, as a UTC ISO string — the
 *  bound the dashboard filters "today's recommendations" on. */
export function startOfLocalDayIso(now: Date = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString();
}

function parseUtc(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

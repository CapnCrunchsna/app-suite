/**
 * The display edge, shared by every app in this suite.
 *
 * Both apps store money as integer cents and timestamps as UTC ISO-8601
 * strings, and both have to turn those into something a person reads. Before
 * this file each did it separately — Ledgerline's magnitude formatter existed
 * three times over in three pages, Edgeline's lived in its own app — and the
 * two apps disagreed about small things that a reader would notice if they had
 * both open.
 *
 * ## What is here and what is deliberately not
 *
 * Presentation only, and only the parts that have no home in an app's own
 * domain lib. In particular **`@metrum/ledgerline-domain`'s `formatCents` stays
 * where it is.** Ledgerline's spec §2.2 says so in as many words, and the
 * reason is structural rather than sentimental: `libs/ledgerline/analyzers`
 * renders money into finding text, and the boundary contract gives
 * `type:analyzers` exactly one allowed dependency, `type:domain`. Moving that
 * function here would either break the boundary lint or force a change to a
 * contract the spec calls load-bearing — for a six-line function.
 *
 * So the two implementations coexist on purpose, and
 * `libs/ledgerline/feature-shell/src/lib/money-parity.spec.ts` is what stops
 * them drifting: it is in the one lib allowed to import both, and it asserts
 * they render identically for every integer-cent input.
 *
 * ## `null` is not zero
 *
 * Every formatter takes `null | undefined` and renders `NO_DATA` rather than a
 * number. The rule matters most where an API distinguishes them on purpose —
 * Edgeline's hit rate and average CLV come back `null` when nothing has settled,
 * and a formatter that rendered that as `0.0%` would tell someone with an empty
 * database that they lose every bet. The `fallback` argument exists for the
 * places that want a blank cell instead of an em-dash.
 */

/** What a missing value renders as. Never `0`, never a silent blank. */
export const NO_DATA = '—';

/* -------------------------------------------------------------------------- */
/* Money — always from integer cents                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cents to dollars, negative amounts signed: `-$42.50`.
 *
 * Byte-identical to `@metrum/ledgerline-domain`'s `formatCents` for every
 * integer input — see the parity spec named above. It differs only where that
 * one is undefined: a non-integer or `NaN` input renders as `NO_DATA` here
 * rather than as `$42.50.5`.
 *
 * Two decimal places always. `$12.5` beside `$12.50` in a column reads as a
 * different kind of number.
 */
export function formatCents(cents: number | null | undefined, fallback = NO_DATA): string {
  if (!isFiniteNumber(cents)) return fallback;
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${twoPlaces(Math.abs(cents) / 100)}`;
}

/**
 * The same without the sign: `$42.50`.
 *
 * For a column that is all one direction. Ledgerline's spend tables are the
 * case that named it — §7.3's amounts are signed, and a table reading
 * `-$1,099.00` all the way down is noise rather than information.
 */
export function formatMagnitudeCents(cents: number | null | undefined, fallback = NO_DATA): string {
  if (!isFiniteNumber(cents)) return fallback;
  return `$${twoPlaces(Math.abs(cents) / 100)}`;
}

/**
 * Magnitude, rounded to whole dollars: `$42`.
 *
 * For figures read as a size rather than as an amount — a year's spend in a
 * category, where the cents are below the resolution of the question being
 * asked.
 */
export function formatMagnitudeDollars(
  cents: number | null | undefined,
  fallback = NO_DATA,
): string {
  if (!isFiniteNumber(cents)) return fallback;
  return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Signed in both directions: `+$42.50`, `-$42.50`, `$0.00`.
 *
 * For P&L, where the reader's question is "up or down" before it is "how much",
 * and where an unsigned zero and an unsigned loss look identical at a glance.
 */
export function formatSignedCents(cents: number | null | undefined, fallback = NO_DATA): string {
  if (!isFiniteNumber(cents)) return fallback;
  return `${cents > 0 ? '+' : ''}${formatCents(cents, fallback)}`;
}

/** Dollars typed into a form back to integer cents. `null` when unparseable. */
export function centsFromDollars(dollars: number | string): number | null {
  const value = typeof dollars === 'string' ? Number(dollars) : dollars;
  if (!Number.isFinite(value)) return null;
  // Rounded, not truncated: 8.29 * 100 is 828.9999… in binary floating point.
  return Math.round(value * 100);
}

/** Cents into a number a dollars-denominated `<input type="number">` accepts. */
export function dollarsFromCents(cents: number | null | undefined): number | null {
  if (!isFiniteNumber(cents)) return null;
  return cents / 100;
}

/* -------------------------------------------------------------------------- */
/* Percentages                                                                 */
/* -------------------------------------------------------------------------- */

/** A value already expressed as a percentage — `2.5` renders `2.50%`. Not a
 *  0–1 ratio; see `formatRatioAsPercent`. */
export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 2,
  fallback = NO_DATA,
): string {
  if (!isFiniteNumber(value)) return fallback;
  return `${value.toFixed(fractionDigits)}%`;
}

/** The same with an explicit sign, for figures where negative is the finding
 *  rather than an error. */
export function formatSignedPercent(
  value: number | null | undefined,
  fractionDigits = 2,
  fallback = NO_DATA,
): string {
  if (!isFiniteNumber(value)) return fallback;
  return `${value > 0 ? '+' : ''}${value.toFixed(fractionDigits)}%`;
}

/**
 * A 0–1 ratio rendered as a percentage — `0.55` becomes `55.0%`.
 *
 * Separate from `formatPercent` because getting the two the wrong way round is
 * silent and severe: a 55% hit rate shown as `0.55%` reads as a catastrophe
 * rather than a good week.
 */
export function formatRatioAsPercent(
  value: number | null | undefined,
  fractionDigits = 1,
  fallback = NO_DATA,
): string {
  if (!isFiniteNumber(value)) return fallback;
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

/* -------------------------------------------------------------------------- */
/* Time — stored UTC, rendered in the reader's zone                            */
/* -------------------------------------------------------------------------- */

/**
 * A UTC instant as a date and a clock reading, in the reader's timezone.
 *
 * Both apps store UTC and convert only here, for the same reason: two places
 * that convert are two places that can disagree about what "today" is. A raw
 * `…T14:03:00Z` on screen is a bug — the right instant shown in the wrong
 * person's timezone.
 */
export function formatLocalTime(iso: string | null | undefined, fallback = NO_DATA): string {
  const date = parseUtc(iso);
  if (!date) return fallback;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Just the clock part, for a table whose rows are all from today. */
export function formatLocalClock(iso: string | null | undefined, fallback = NO_DATA): string {
  const date = parseUtc(iso);
  if (!date) return fallback;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Just the calendar day — the one that decides whether a UTC-stamped row is
 *  "today" for the person reading it. */
export function formatLocalDay(iso: string | null | undefined, fallback = NO_DATA): string {
  const date = parseUtc(iso);
  if (!date) return fallback;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "4 min ago".
 *
 * For a timestamp whose meaning is its age rather than its value — a heartbeat
 * that says a worker is alive, a last-run marker. The reader should not have to
 * do the subtraction to find out something stopped.
 */
export function formatAge(
  iso: string | null | undefined,
  now: number = Date.now(),
  fallback = NO_DATA,
): string {
  const date = parseUtc(iso);
  if (!date) return fallback;
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Whether an instant is within `maxAgeS` of now. A missing timestamp is never
 *  fresh — "we have never seen one" is not "we saw one recently". */
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
 *  bound to filter a UTC-stamped table on when the question is "today". */
export function startOfLocalDayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/* -------------------------------------------------------------------------- */

function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function twoPlaces(dollars: number): string {
  return dollars.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseUtc(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

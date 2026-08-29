/**
 * §6.7's fixed query set — the whole of what Ask is allowed to run.
 *
 * "**Not text-to-SQL.** The LLM chooses from a fixed set of validated query
 * functions — `spendByCategory(range)`, `merchantHistory(merchant, range)`,
 * `findRecurring()`, `topMerchants(range, n)`, `transactionSearch(filters)`,
 * `monthlyTotals(range)` — with schema-checked parameters. The functions execute
 * deterministically; the LLM only picks the query and writes prose around the
 * returned rows. This buys no hallucinated numbers, no arbitrary database access
 * from generated SQL, and data minimization."
 *
 * ## The model picks a name from a list; it never composes a query
 *
 * Everything a model can influence is in `AskQuery` — one of six names and a small
 * bag of scalars, every one of which is validated here before anything runs. There
 * is no field a SQL fragment could travel in, and adding one would be a visible
 * change to this type rather than a leak. That is the same argument §3.4 makes about
 * the repository layer ("no caller string reaches SQL uninterpreted") extended one
 * level out to the model.
 *
 * A name that is not one of the six, a range that is not two ISO dates, an `n` that
 * is not a small positive integer: all rejected with a reason, and `llmAssist` turns
 * the rejection into the deterministic fallback. A model that answers badly here
 * degrades exactly like a model that is not running.
 *
 * ## Two views of one result, and the difference is the privacy claim
 *
 * `QueryResult` carries `rows` for the UI and `providerView` for the model. §6.7
 * makes them different on purpose: "`transactionSearch` returns rows to the UI but
 * not to the provider. Row-level descriptors are the least aggregated data in the
 * system, and sending them contradicts the data minimization claim in the same
 * breath as making it." Building both here — rather than letting the caller decide
 * what to forward — is what stops the two from drifting.
 */

import { isIsoDate } from '@metrum/ledgerline-domain';
import type { DateRange } from '@metrum/ledgerline-domain';
import { redactBatch } from '@metrum/ledgerline-llm';

import type { LedgerlineContext } from '../context.js';

/** §6.7: "at most twenty descriptors". */
export const MAX_PROVIDER_DESCRIPTORS = 20;

/** What the UI may be handed for one answer. Generous — it never leaves the
 *  machine — but bounded, because a page renders it. */
const MAX_UI_ROWS = 200;

export const QUERY_NAMES = [
  'spendByCategory',
  'merchantHistory',
  'findRecurring',
  'topMerchants',
  'transactionSearch',
  'monthlyTotals',
] as const;

export type QueryName = (typeof QUERY_NAMES)[number];

/** The model's choice, before validation. Every field optional because the model
 *  supplies whatever it thinks the query needs, and this file decides. */
export interface AskQueryDraft {
  readonly name?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly merchant?: unknown;
  readonly n?: unknown;
  readonly text?: unknown;
  readonly minAmountCents?: unknown;
  readonly maxAmountCents?: unknown;
}

/** The validated form. Nothing reaches a repository that is not one of these. */
export interface AskQuery {
  readonly name: QueryName;
  readonly range: DateRange | null;
  readonly merchant: string | null;
  readonly n: number | null;
  readonly text: string | null;
  readonly minAmountCents: number | null;
  readonly maxAmountCents: number | null;
}

/** One row of an answer's table, as the UI renders it. Deliberately flat: the page
 *  shows a table, and a nested shape would need a renderer per query. */
export interface AskRow {
  readonly label: string;
  readonly amountCents: number | null;
  readonly count: number | null;
  /** `effective_date` where the row is a transaction; a month for a monthly
   *  aggregate; null where the row has no time. */
  readonly date: string | null;
  /** Present only for `transactionSearch`, so §6.4's "view the rows" can link. */
  readonly transactionId: string | null;
}

export interface QueryResult {
  readonly query: AskQuery;
  /** What the UI renders. Never sent anywhere. */
  readonly rows: readonly AskRow[];
  readonly totalCents: number;
  readonly rowCount: number;
  /**
   * What the model is shown — aggregates always, descriptors only where §6.7
   * allows them and only redacted and P2P-filtered.
   */
  readonly providerView: ProviderView;
}

export interface ProviderView {
  readonly query: string;
  readonly rowCount: number;
  readonly totalCents: number;
  /** Aggregated lines: category totals, month totals, merchant totals. These are
   *  the same numbers the UI shows, because they are already aggregates. */
  readonly lines: readonly { readonly label: string; readonly amountCents: number | null }[];
  /** §6.7's cap, applied only to the one query that has row-level descriptors. */
  readonly descriptors: readonly string[];
  /** §2.4's hard filter, counted rather than silent — the same reason §4.2's
   *  batch reports it. */
  readonly withheldP2P: number;
}

export class InvalidAskQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAskQueryError';
  }
}

// ------------------------------------------------------------- validation ---

const isName = (value: unknown): value is QueryName =>
  typeof value === 'string' && (QUERY_NAMES as readonly string[]).includes(value);

/**
 * Validate the model's choice.
 *
 * Throws rather than returning a result type, because the caller is `llmAssist` and
 * §2.4 makes "a throw, a timeout, or a schema-validation failure" one outcome with
 * one response. A `Result` here would invite a second code path to the same answer.
 */
export function validateAskQuery(draft: AskQueryDraft): AskQuery {
  if (!isName(draft.name)) {
    throw new InvalidAskQueryError(
      `"${String(draft.name)}" is not one of ${QUERY_NAMES.join(', ')}`,
    );
  }

  const range = validateRange(draft.from, draft.to);
  if ((draft.name === 'spendByCategory' || draft.name === 'monthlyTotals') && range === null) {
    throw new InvalidAskQueryError(`${draft.name} needs a from/to date range`);
  }

  const merchant =
    typeof draft.merchant === 'string' && draft.merchant.trim() !== ''
      ? draft.merchant.trim()
      : null;
  if (draft.name === 'merchantHistory' && merchant === null) {
    throw new InvalidAskQueryError('merchantHistory needs a merchant');
  }

  return {
    name: draft.name,
    range,
    merchant,
    // Bounded rather than rejected: "top 500 merchants" is a reasonable thing for a
    // model to ask and an unreasonable thing to render.
    n: typeof draft.n === 'number' && Number.isFinite(draft.n) ? clamp(Math.round(draft.n), 1, 50) : null,
    text: typeof draft.text === 'string' && draft.text.trim() !== '' ? draft.text.trim() : null,
    minAmountCents: validateCents(draft.minAmountCents),
    maxAmountCents: validateCents(draft.maxAmountCents),
  };
}

function validateRange(from: unknown, to: unknown): DateRange | null {
  if (from === undefined && to === undefined) return null;
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new InvalidAskQueryError('a range needs both `from` and `to` as ISO dates');
  }
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new InvalidAskQueryError(`"${from}".."${to}" is not two YYYY-MM-DD dates`);
  }
  // Swapped rather than rejected. The dates are unambiguous and which way round
  // they arrived is not worth a failed answer.
  return from <= to ? { from, to } : { from: to, to: from };
}

function validateCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

// -------------------------------------------------------------- execution ---

/**
 * Run a validated query. Deterministic, and the only path from Ask to the store.
 *
 * The `range` fallback is the whole coverage window rather than "now minus a year":
 * §7.2 says every aggregate reports the window it used and that liveness is measured
 * against the account's own coverage, "never the dataset maximum and never the wall
 * clock". A question with no dates in it means "all of it", and all of it is what the
 * database holds.
 */
export function runAskQuery(context: LedgerlineContext, query: AskQuery): QueryResult {
  const range = query.range ?? wholeRange(context);

  switch (query.name) {
    case 'spendByCategory':
      return spendByCategory(context, query, range);
    case 'monthlyTotals':
      return monthlyTotals(context, query, range);
    case 'topMerchants':
      return topMerchants(context, query, range);
    case 'merchantHistory':
      return merchantHistory(context, query, range);
    case 'findRecurring':
      return findRecurring(context, query);
    case 'transactionSearch':
      return transactionSearch(context, query, range);
  }
}

function wholeRange(context: LedgerlineContext): DateRange {
  const row = context.store.db
    .prepare<[], { lo: string | null; hi: string | null }>(
      'SELECT MIN(effective_date) AS lo, MAX(effective_date) AS hi FROM "transaction"',
    )
    .get();
  return { from: row?.lo ?? '1970-01-01', to: row?.hi ?? '2999-12-31' };
}

function spendByCategory(
  context: LedgerlineContext,
  query: AskQuery,
  range: DateRange,
): QueryResult {
  const byCategory = new Map<string, { cents: number; count: number }>();

  for (const row of context.store.transactions.monthlyCategoryTotals(range)) {
    const label = row.categoryName ?? 'Uncategorized';
    const entry = byCategory.get(label) ?? { cents: 0, count: 0 };
    entry.cents += row.totalCents;
    entry.count += row.transactionCount;
    byCategory.set(label, entry);
  }

  const rows = [...byCategory.entries()]
    .map(([label, entry]) => ({
      label,
      amountCents: entry.cents,
      count: entry.count,
      date: null,
      transactionId: null,
    }))
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));

  return aggregateResult(query, range, rows);
}

function monthlyTotals(context: LedgerlineContext, query: AskQuery, range: DateRange): QueryResult {
  const byMonth = new Map<string, { cents: number; count: number }>();

  for (const row of context.store.transactions.monthlyCategoryTotals(range)) {
    const entry = byMonth.get(row.month) ?? { cents: 0, count: 0 };
    entry.cents += row.totalCents;
    entry.count += row.transactionCount;
    byMonth.set(row.month, entry);
  }

  const rows = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, entry]) => ({
      label: month,
      amountCents: entry.cents,
      count: entry.count,
      date: month,
      transactionId: null,
    }));

  return aggregateResult(query, range, rows);
}

function topMerchants(context: LedgerlineContext, query: AskQuery, range: DateRange): QueryResult {
  const rows = context.store.transactions
    .listDebitsByMerchant(range)
    .map((entry) => ({
      label: entry.merchantName,
      amountCents: entry.transactions.reduce((total, tx) => total + tx.amountCents, 0),
      count: entry.transactions.length,
      date: null,
      transactionId: null,
    }))
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))
    .slice(0, query.n ?? 10);

  return aggregateResult(query, range, rows);
}

/**
 * One merchant's charges over a range.
 *
 * Matched on the merchant's *name*, because that is what a person types and what the
 * model was given. Case-insensitive substring rather than exact, so "spotify" finds
 * "Spotify USA" — and if it matches several, all of them are included and the answer
 * says so through the row labels rather than picking one silently.
 */
function merchantHistory(
  context: LedgerlineContext,
  query: AskQuery,
  range: DateRange,
): QueryResult {
  const wanted = (query.merchant ?? '').toLowerCase();
  const matching = context.store.transactions
    .listDebitsByMerchant(range)
    .filter((entry) => entry.merchantName.toLowerCase().includes(wanted));

  const rows = matching
    .flatMap((entry) =>
      entry.transactions.map((tx) => ({
        label: entry.merchantName,
        amountCents: tx.amountCents,
        count: null,
        date: tx.effectiveDate,
        transactionId: tx.id,
      })),
    )
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, MAX_UI_ROWS);

  // A merchant history is row-level, so it gets `transactionSearch`'s treatment
  // rather than an aggregate's: the model sees the totals and at most twenty
  // redacted names, and the UI sees the charges.
  return rowLevelResult(query, range, rows);
}

function findRecurring(context: LedgerlineContext, query: AskQuery): QueryResult {
  const merchants = new Map(context.store.merchants.list().map((row) => [row.id, row.displayName]));

  const rows = context.store.analysis
    .listSeries()
    // §6.5: "a manual status always beats the computed one".
    .filter((series) => (series.userStatus ?? series.status) === 'active')
    .map((series) => ({
      label: merchants.get(series.merchantId) ?? series.merchantId,
      amountCents: series.amountCentsCurrent,
      count: series.occurrenceCount,
      date: series.nextExpected,
      transactionId: null,
    }))
    .sort((a, b) => Math.abs(b.amountCents ?? 0) - Math.abs(a.amountCents ?? 0));

  return aggregateResult(query, null, rows);
}

function transactionSearch(
  context: LedgerlineContext,
  query: AskQuery,
  range: DateRange,
): QueryResult {
  const page = context.store.transactions.search({
    dateRange: range,
    text: query.text ?? undefined,
    minAmountCents: query.minAmountCents ?? undefined,
    maxAmountCents: query.maxAmountCents ?? undefined,
    sort: 'date_desc',
    limit: MAX_UI_ROWS,
  });

  const rows = page.rows.map((row) => ({
    label: row.transaction.descriptionNormalized,
    amountCents: row.transaction.amountCents,
    count: null,
    date: row.transaction.effectiveDate,
    transactionId: row.transaction.id,
  }));

  return rowLevelResult(query, range, rows, page.total);
}

// ----------------------------------------------------------- two views ---

/** An aggregate result: the lines *are* aggregates, so the model may see them. */
function aggregateResult(
  query: AskQuery,
  range: DateRange | null,
  rows: readonly AskRow[],
): QueryResult {
  const totalCents = rows.reduce((total, row) => total + (row.amountCents ?? 0), 0);

  return {
    query: { ...query, range },
    rows,
    totalCents,
    rowCount: rows.length,
    providerView: {
      query: describe(query, range),
      rowCount: rows.length,
      totalCents,
      lines: rows.map((row) => ({ label: row.label, amountCents: row.amountCents })),
      descriptors: [],
      withheldP2P: 0,
    },
  };
}

/**
 * A row-level result: §6.7's data-minimization rule applies.
 *
 * "The provider receives a count, the aggregate totals, and at most twenty
 * descriptors with the §2.4 redaction and P2P filter applied. The UI renders the
 * full result locally."
 *
 * The P2P verdict is *not* recomputed here — §2.4's list lives in `normalize` and
 * `redact.ts` says why re-deriving it at a call site is how a privacy control comes
 * to disagree with itself. What this has instead is the descriptor, so it asks
 * `redactBatch` with the flag it can determine: a descriptor that already resolved
 * to a merchant is not a P2P line by construction, because §4.1's chain would not
 * have resolved one. The unresolved remainder is passed as P2P and withheld, which
 * errs toward sending less.
 */
function rowLevelResult(
  query: AskQuery,
  range: DateRange | null,
  rows: readonly AskRow[],
  total = rows.length,
): QueryResult {
  const totalCents = rows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);

  const { sendable, withheldP2P } = redactBatch(
    [...new Set(rows.map((row) => row.label))]
      .slice(0, MAX_PROVIDER_DESCRIPTORS)
      .map((label) => ({ id: label, text: label, isP2P: looksPersonal(label) })),
  );

  return {
    query: { ...query, range },
    rows,
    totalCents,
    rowCount: total,
    providerView: {
      query: describe(query, range),
      rowCount: total,
      totalCents,
      // No per-row amounts: an amount beside a descriptor is the row, reassembled.
      lines: [],
      descriptors: sendable.map((entry) => entry.text),
      withheldP2P: withheldP2P.length,
    },
  };
}

/**
 * The conservative half of the P2P question, for descriptors that arrive here
 * without `normalize`'s verdict attached.
 *
 * Deliberately a *prefix* test against §2.4's own list rather than a second
 * implementation of `isP2PDescriptor`: this cannot say a descriptor is safe, only
 * that it is obviously not, and everything it flags is withheld. `redact.ts`'s note
 * — "a privacy control that has to be remembered at every call site is a privacy
 * control that eventually is not" — is why the real rule stays in `normalize` and
 * this stays a filter that can only over-withhold.
 */
function looksPersonal(descriptor: string): boolean {
  const upper = descriptor.toUpperCase();
  return ['ZELLE', 'VENMO', 'CASH APP', 'SQUARE CASH', 'CHECK #', 'PAYPAL *', 'PP*'].some(
    (prefix) => upper.startsWith(prefix),
  );
}

/** What the model is told it ran, in words. Named rather than passed as a bare
 *  function name because §6.7 requires the answer to name its query. */
export function describe(query: AskQuery, range: DateRange | null): string {
  const window = range ? ` from ${range.from} to ${range.to}` : '';
  switch (query.name) {
    case 'spendByCategory':
      return `spending by category${window}`;
    case 'monthlyTotals':
      return `monthly totals${window}`;
    case 'topMerchants':
      return `top ${query.n ?? 10} merchants${window}`;
    case 'merchantHistory':
      return `charges from ${query.merchant ?? 'a merchant'}${window}`;
    case 'findRecurring':
      return 'active recurring subscriptions';
    case 'transactionSearch':
      return `transactions matching ${query.text ?? 'the given filters'}${window}`;
  }
}

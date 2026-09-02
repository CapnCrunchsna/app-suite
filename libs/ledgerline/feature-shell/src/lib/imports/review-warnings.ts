/**
 * §6.1's warning strip: "anything suspicious — unparsed rows, dates outside the
 * detected period, pending rows, and a balance that doesn't reconcile."
 *
 * The grouping is a pure function with its own tests, for the same reason
 * `virtual-window.ts` is: it is arithmetic over a response, and a miscount here
 * reads as a plausible number rather than as a broken screen.
 *
 * ## Where each of the four comes from
 *
 * Three are facts the API already computed — `unparsedRows`, the `pending_row`
 * warnings, and `balanceCheck`. The fourth is derived here, and its current
 * limitation is worth stating plainly rather than hiding behind a strip that
 * never lights up:
 *
 * **`periodStart`/`periodEnd` are the min and max of the rows that parsed**
 * (`node-csv-parser.ts` sorts the effective dates and takes both ends), so no row
 * can currently fall outside them and this check cannot fire. It is written
 * against the contract rather than against today's parser because the period is
 * the *statement's* period the moment detection reads it off the header — the
 * Northgate fixture prints `Statement Period: 01/01/2026 - 01/20/2026` two lines
 * above its columns — and on that day a row dated outside it is exactly the
 * misparse §6.1 wants caught. Until then the page says where the period came
 * from, so nobody reads an empty strip as a check that passed. Recorded in §9b.
 *
 * A date outlier could instead be found by clustering the dates and flagging the
 * stragglers, and that is deliberately not done here: it would put an
 * uncalibrated threshold (§7.6) in a `type:feature` lib and duplicate a judgment
 * `type:parsing` owns.
 */

import { formatCents } from '@metrum/ledgerline-domain';
import type { ImportReview } from '@metrum/api-client';

export type ReviewWarningKind =
  'unparsed' | 'out_of_period' | 'pending' | 'balance' | 'zero_amount' | 'other';

export interface ReviewWarning {
  readonly kind: ReviewWarningKind;
  /** How bad. `note` is information, `warn` wants a look, `bad` blocks or costs data. */
  readonly severity: 'note' | 'warn' | 'bad';
  readonly headline: string;
  readonly detail: string;
  /** Row indexes this concerns, for highlighting the rows in the table. Internal:
   *  `rowIndex` is the API's row key, not a number to show anyone. */
  readonly rowIndexes: readonly number[];
  /** The same rows as physical file lines — what the strip prints. See below. */
  readonly lineNumbers: readonly number[];
}

/**
 * ## Two numbers per row, and only one of them goes on screen
 *
 * Every row has a `rowIndex` — its 0-based position among the *data* records,
 * after the preamble, the header and any blank lines — and a `lineNumber`, the
 * 1-based line of the actual file. `schemas.ts` says why both exist: "1-based
 * physical line, which is what a human can go and look at."
 *
 * The strip used to print `rowIndex` while the messages coming out of
 * `type:parsing` all say "Line N", so one warning about one row could show 51 in
 * its sentence and 49 beside it, and the table's `#` column showed a third
 * reading of the same row. All three were correct; none of them agreed. On a
 * Chase export the gap is exactly two, which is small enough to look like an
 * off-by-one bug in the parser rather than two coordinate systems on one screen.
 *
 * So `lineNumber` is the only one displayed, here and in the table, because it is
 * the one you can act on: it is where the row is if you open the file. `rowIndex`
 * stays as the key it always was — commit payloads, near-duplicate resolutions
 * and the table's highlighting are all keyed by it — and is never printed.
 */
export function lineNumbersFor(review: ImportReview, rowIndexes: readonly number[]): number[] {
  const byRowIndex = new Map<number, number>();

  for (const entry of review.rows) byRowIndex.set(entry.rowIndex, entry.row.lineNumber);

  // A row that failed to parse is not in `rows`, and `RawRowRecord` cannot supply
  // the line either: §3.2's `raw_row` stores `row_index` and `raw_text` and has no
  // column for it. The parser's own warning does carry both, and is emitted for
  // exactly those rows — so the failures are matched up through it rather than by
  // adding a migration to display a number.
  for (const warning of review.warnings) {
    if (warning.rowIndex !== undefined && warning.lineNumber !== undefined) {
      byRowIndex.set(warning.rowIndex, warning.lineNumber);
    }
  }

  // A row neither source knows has no line to point at. Dropping it beats
  // printing the `rowIndex` as a fallback, which is the confusion this removes.
  return rowIndexes
    .map((rowIndex) => byRowIndex.get(rowIndex))
    .filter((line): line is number => line !== undefined);
}

/** Kinds the strip states in its own words because it has the rows to count;
 *  everything else in `review.warnings` passes through verbatim. */
const RESTATED = new Set([
  'unparsed_row',
  'pending_row',
  'balance_mismatch',
  'balance_unavailable',
]);

export function reviewWarnings(review: ImportReview): ReviewWarning[] {
  const warnings: Omit<ReviewWarning, 'lineNumbers'>[] = [];

  if (review.unparsedRows.length > 0) {
    const lines = review.unparsedRows.map((row) => row.rowIndex);
    warnings.push({
      kind: 'unparsed',
      severity: 'bad',
      headline: `${lines.length} ${plural(lines.length, 'row')} did not parse`,
      detail:
        'Kept rather than dropped (§2.5), and not committed. A parse that silently ' +
        'discards what it could not read is the misparse review-before-commit exists to catch.',
      rowIndexes: lines,
    });
  }

  const outOfPeriod = rowsOutsidePeriod(review);
  if (outOfPeriod.length > 0) {
    warnings.push({
      kind: 'out_of_period',
      severity: 'warn',
      headline: `${outOfPeriod.length} ${plural(outOfPeriod.length, 'row')} dated outside ${review.import.periodStart} → ${review.import.periodEnd}`,
      detail:
        'A date read under the wrong format lands in the wrong month and stays plausible. ' +
        'Check the row against its statement line before committing.',
      rowIndexes: outOfPeriod,
    });
  }

  const pending = review.rows
    .filter((row) => row.row.status === 'pending')
    .map((row) => row.rowIndex);
  if (pending.length > 0) {
    warnings.push({
      kind: 'pending',
      severity: 'note',
      headline: `${pending.length} pending ${plural(pending.length, 'row')}`,
      detail:
        'Stored and shown, and out of every total and every analyzer (§2.5). The same charge ' +
        'usually posts later at a different date and often a different amount.',
      rowIndexes: pending,
    });
  }

  const zeroAmount = review.warnings
    .filter((warning) => warning.kind === 'zero_amount')
    .map((warning) => warning.rowIndex)
    .filter((index): index is number => index !== undefined);
  if (zeroAmount.length > 0) {
    warnings.push({
      kind: 'zero_amount',
      severity: 'warn',
      headline: `${zeroAmount.length} ${plural(zeroAmount.length, 'row')} parsed to $0.00`,
      detail:
        'Commit refuses these unless they are trial authorizations — a $0 row is much more ' +
        'often an amount column read wrong. Tick the opt-in below if they are real.',
      rowIndexes: zeroAmount,
    });
  }

  const balance = balanceWarning(review, (rowIndex) => lineNumbersFor(review, [rowIndex])[0]);
  if (balance) warnings.push(balance);

  for (const warning of review.warnings) {
    if (RESTATED.has(warning.kind) || warning.kind === 'zero_amount') continue;
    warnings.push({
      kind: 'other',
      severity: warning.kind === 'signature_mismatch' ? 'warn' : 'note',
      headline: warning.kind.replace(/_/g, ' '),
      // Verbatim: the message names a rule this page does not own.
      detail: warning.message,
      rowIndexes: warning.rowIndex === undefined ? [] : [warning.rowIndex],
    });
  }

  // One place the file lines are attached, so no warning can be added later that
  // forgets to — and `rowIndexes` and `lineNumbers` cannot drift apart.
  return warnings.map((warning) => ({
    ...warning,
    lineNumbers: lineNumbersFor(review, warning.rowIndexes),
  }));
}

/**
 * §6.1's `balance[n] − balance[n−1] ≠ amount[n]`.
 *
 * A mismatch is a `bad`: it is the strongest available signal that the amount
 * column or the sign convention is wrong, and those poison every downstream
 * finding. An *unavailable* check is only a note — plenty of real exports carry no
 * running balance — but it is still said out loud, because "no mismatch" and "not
 * checked" look identical on a screen that shows neither.
 */
function balanceWarning(
  review: ImportReview,
  lineOf: (rowIndex: number) => number | undefined,
): Omit<ReviewWarning, 'lineNumbers'> | null {
  const check = review.balanceCheck;

  if (check.kind === 'mismatch') {
    const failures = check.failures ?? [];
    const worst = failures[0];
    // Named by file line like every other message here. `balanceCheck` reports
    // `rowIndex` only, so the line is resolved rather than read off the failure.
    const worstLine = worst ? lineOf(worst.rowIndex) : undefined;
    return {
      kind: 'balance',
      severity: 'bad',
      headline: `Running balance does not reconcile on ${check.failureCount ?? failures.length} of ${check.rowsChecked ?? '?'} rows`,
      detail: worst
        ? `${worstLine === undefined ? 'A row' : `Line ${worstLine}`} expected ` +
          `${formatCents(worst.expectedCents)} and the file says ` +
          `${formatCents(worst.actualCents)}, out by ${formatCents(worst.deltaCents)}. ` +
          'That usually means the amount column or the sign convention is wrong.'
        : 'The balances and the amounts disagree.',
      rowIndexes: failures.map((failure) => failure.rowIndex),
    };
  }

  if (check.kind === 'unavailable') {
    return {
      kind: 'balance',
      severity: 'note',
      headline: 'Balance reconciliation did not run',
      detail: check.reason ?? 'no running balance column in this file',
      rowIndexes: [],
    };
  }

  return null;
}

function rowsOutsidePeriod(review: ImportReview): number[] {
  const { periodStart, periodEnd } = review.import;
  if (!periodStart || !periodEnd) return [];

  // ISO `YYYY-MM-DD` compares correctly as a string, which is half the reason
  // §3.1 stores dates that way.
  return review.rows
    .filter((row) => row.row.effectiveDate < periodStart || row.row.effectiveDate > periodEnd)
    .map((row) => row.rowIndex);
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

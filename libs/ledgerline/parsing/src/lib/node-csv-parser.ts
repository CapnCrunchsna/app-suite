/**
 * `NodeCsvParser` — the `parse` stage of §2.5, driven entirely by a `FormatProfile`.
 *
 * "Profile-driven extraction into `RawRow[]` (transaction date, posted date,
 * description, amount, optional balance, optional status) plus the verbatim source
 * line, preserved in `raw_row`."
 *
 * Nothing in here knows the name of a bank. Every institution-specific fact lives in
 * the profile, which is what makes adding a bank a data change rather than a code
 * change — and what makes the sign convention in §3.1 enforceable rather than
 * aspirational.
 *
 * This function is pure: it takes text and a profile, and returns a value. Per §2.1
 * ("libs compute; the app persists") nothing here writes anywhere, and per §2.2
 * `type:parsing` may depend only on `type:domain`.
 */

import {
  collapseV1,
  effectiveDate,
  parseDateToIso,
  parseMoneyToCents,
} from '@app-suite/ledgerline-domain';
import type {
  ParseResult,
  ParseWarning,
  RawRow,
  RawRowError,
  RowStatus,
} from '@app-suite/ledgerline-domain';

import { checkBalances, checkSignPlausibility } from './balance-check.js';
import { isBlankRecord, parseCsv } from './csv-reader.js';
import type { CsvRecord } from './csv-reader.js';
import { headerSignature, normalizeHeaderToken } from './format-signature.js';
import { validateProfile } from './format-profile.js';
import type { ColumnRole, FormatProfile } from './format-profile.js';

export const NODE_CSV_PARSER_ID = 'node-csv';
export const NODE_CSV_PARSER_VERSION = '1.0.0';

/** Thrown when a profile cannot be applied to a file at all — an invalid profile, or a
 *  named column that is not present. This is a configuration failure, not a data
 *  failure: there is no partial result worth returning, and silently parsing with a
 *  column missing is how an amount column goes unnoticed. */
export class ProfileApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileApplicationError';
  }
}

interface ResolvedColumns {
  readonly indices: Partial<Record<ColumnRole, number>>;
}

function resolveColumns(
  profile: FormatProfile,
  headerCells: readonly string[] | null
): ResolvedColumns {
  const indices: Partial<Record<ColumnRole, number>> = {};
  const normalizedHeader = headerCells?.map(normalizeHeaderToken) ?? null;
  const problems: string[] = [];

  for (const [role, ref] of Object.entries(profile.columnMap)) {
    if (!ref) continue;

    if (ref.by === 'index') {
      indices[role as ColumnRole] = ref.index;
      continue;
    }

    if (!normalizedHeader) {
      problems.push(`${role}: addressed by header name but the file has no header row`);
      continue;
    }

    const wanted = normalizeHeaderToken(ref.name);
    const found = normalizedHeader.indexOf(wanted);
    if (found === -1) {
      problems.push(`${role}: no column named "${ref.name}"`);
      continue;
    }
    indices[role as ColumnRole] = found;
  }

  if (problems.length > 0) {
    const available = normalizedHeader
      ? `\nColumns present in the file: ${normalizedHeader.map((h) => `"${h}"`).join(', ')}`
      : '';
    throw new ProfileApplicationError(
      `Profile "${profile.id}" does not fit this file:\n  - ${problems.join('\n  - ')}${available}`
    );
  }

  return { indices };
}

export interface CsvParseOptions {
  readonly text: string;
  readonly profile: FormatProfile;
}

export function parseCsvWithProfile(options: CsvParseOptions): ParseResult {
  const { text, profile } = options;

  const validation = validateProfile(profile);
  if (!validation.ok) {
    throw new ProfileApplicationError(
      `Profile "${profile.id}" is invalid:\n  - ${validation.errors.join('\n  - ')}`
    );
  }

  const warnings: ParseWarning[] = validation.warnings.map((message) => ({
    kind: 'profile_warning' as const,
    message,
  }));
  const errors: RawRowError[] = [];
  const rows: RawRow[] = [];

  const records = parseCsv(text, profile.delimiter).filter((r) => !isBlankRecord(r));
  const afterPreamble = records.slice(profile.skipLines);

  let headerCells: readonly string[] | null = null;
  let dataRecords: readonly CsvRecord[] = afterPreamble;

  if (profile.hasHeader) {
    const headerRecord = afterPreamble[0];
    if (!headerRecord) {
      return emptyResult(profile, warnings, 'file contains no header row');
    }
    headerCells = headerRecord.cells;
    dataRecords = afterPreamble.slice(1);

    const actual = headerSignature(headerCells);
    if (profile.headerSignature !== '' && actual.signature !== profile.headerSignature) {
      warnings.push({
        kind: 'signature_mismatch',
        message:
          `Header signature does not match profile "${profile.id}". The bank may have changed its export. ` +
          `Expected tokens [${profile.headerTokens.join(', ')}], found [${actual.tokens.join(', ')}]. ` +
          `Rows below were parsed with the profile anyway — check the amount column before committing.`,
        lineNumber: headerRecord.lineNumber,
      });
    }
  }

  if (dataRecords.length === 0) {
    return emptyResult(profile, warnings, 'file contains a header but no data rows', headerCells);
  }

  const { indices } = resolveColumns(profile, headerCells);

  dataRecords.forEach((record, ordinal) => {
    const rowErrors: string[] = [];
    const cell = (role: ColumnRole): string => {
      const index = indices[role];
      if (index === undefined) return '';
      return (record.cells[index] ?? '').trim();
    };

    const readDate = (role: 'transactionDate' | 'postedDate'): string | null => {
      if (indices[role] === undefined) return null;
      const raw = cell(role);
      if (raw === '') return null;
      const parsed = parseDateToIso(raw, profile.dateFormat);
      if (parsed.ok) return parsed.iso;
      rowErrors.push(`${role}: ${parsed.reason}`);
      return null;
    };

    const transactionDate = readDate('transactionDate');
    const postedDate = readDate('postedDate');
    const effective = effectiveDate(transactionDate, postedDate);
    if (effective === null && rowErrors.length === 0) {
      rowErrors.push('no usable date — transactionDate and postedDate are both empty');
    }

    const amount = readAmount(profile, cell, rowErrors);
    const balanceCents = readBalance(profile, indices, cell, rowErrors);
    const descriptionRaw = cell('description');

    let status: RowStatus = 'posted';
    if (indices.status !== undefined) {
      const value = cell('status').toLowerCase();
      if (value !== '' && profile.pendingValues.some((p) => p.trim().toLowerCase() === value)) {
        status = 'pending';
      }
    }

    if (rowErrors.length > 0 || effective === null || amount === null) {
      errors.push({
        rowIndex: ordinal,
        lineNumber: record.lineNumber,
        rawText: record.rawText,
        parseStatus: 'error',
        parseSource: 'csv',
        errors: rowErrors.length > 0 ? rowErrors : ['row could not be parsed'],
      });
      warnings.push({
        kind: 'unparsed_row',
        message: `Line ${record.lineNumber} did not parse: ${rowErrors.join('; ')}`,
        rowIndex: ordinal,
        lineNumber: record.lineNumber,
      });
      return;
    }

    rows.push({
      rowIndex: ordinal,
      lineNumber: record.lineNumber,
      rawText: record.rawText,
      transactionDate,
      postedDate,
      effectiveDate: effective,
      descriptionRaw,
      amountCents: amount,
      balanceCents,
      status,
      currency: profile.currency,
      parseStatus: 'ok',
      parseSource: 'csv',
    });

    if (descriptionRaw === '') {
      warnings.push({
        kind: 'empty_description',
        message: `Line ${record.lineNumber} has an empty description — merchant normalization has nothing to work with.`,
        rowIndex: ordinal,
        lineNumber: record.lineNumber,
      });
    }

    // §3.2 puts `CHECK (amount_cents <> 0)` on `transaction`, with trial
    // authorizations (§5.6) the only legitimate exception. A zero here is far more
    // often a misread column than a real $0 authorization, so it is surfaced rather
    // than rejected — rejecting would lose the authorizations that `trial.v1` needs.
    if (amount === 0) {
      warnings.push({
        kind: 'zero_amount',
        message: `Line ${record.lineNumber} parsed to $0.00. Legitimate for a card-validation authorization; otherwise the amount column is likely mismapped.`,
        rowIndex: ordinal,
        lineNumber: record.lineNumber,
      });
    }

    if (status === 'pending') {
      warnings.push({
        kind: 'pending_row',
        message: `Line ${record.lineNumber} is pending. It will be stored and shown, and excluded from every analyzer and total (§2.5).`,
        rowIndex: ordinal,
        lineNumber: record.lineNumber,
      });
    }
  });

  warnings.push(...findInFileDuplicates(rows));

  const balanceCheck = checkBalances(rows);
  if (balanceCheck.kind === 'mismatch') {
    warnings.push({
      kind: 'balance_mismatch',
      message:
        `Running balance does not reconcile in either row order (best: ${balanceCheck.bestOrder}, ` +
        `${balanceCheck.failureCount} of ${balanceCheck.rowsChecked} checked rows disagree). ` +
        `Every row disagreeing usually means the amount column in profile "${profile.id}" is mismapped; ` +
        `a few usually means rows are missing from the export.`,
    });
  } else if (balanceCheck.kind === 'unavailable') {
    warnings.push({
      kind: 'balance_unavailable',
      message: `Balance reconciliation skipped: ${balanceCheck.reason}.`,
    });
  }

  // Reconciliation is structurally blind to an inverted sign convention, because the
  // inversion is applied to the balance too. This is the separate check for it.
  const signWarning = checkSignPlausibility(rows, profile.accountTypeHint);
  if (signWarning) warnings.push(signWarning);

  const dates = rows.map((r) => r.effectiveDate).sort();

  return {
    rows,
    errors,
    warnings,
    parser: NODE_CSV_PARSER_ID,
    parserVersion: NODE_CSV_PARSER_VERSION,
    profileId: profile.id,
    headerSignature: headerCells ? headerSignature(headerCells).signature : null,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    balanceCheck,
  };
}

/**
 * Turn the profile's amount columns into one signed integer in house convention.
 *
 * The two axes compose rather than multiplying into per-bank special cases: the mode
 * decides how a signed number is assembled, and `signConvention` decides whether the
 * bank's idea of positive matches ours.
 */
function readAmount(
  profile: FormatProfile,
  cell: (role: ColumnRole) => string,
  rowErrors: string[]
): number | null {
  let signed: number | null = null;

  if (profile.amountMode === 'single') {
    const raw = cell('amount');
    if (raw === '') {
      rowErrors.push('amount is empty');
    } else {
      const parsed = parseMoneyToCents(raw);
      if (parsed.ok) signed = parsed.cents;
      else rowErrors.push(`amount: ${parsed.reason}`);
    }
  } else {
    const debitRaw = cell('debit');
    const creditRaw = cell('credit');

    if (debitRaw === '' && creditRaw === '') {
      rowErrors.push('both debit and credit are empty');
    } else {
      let debit = 0;
      let credit = 0;
      let ok = true;

      // `Math.abs` on purpose. Separate columns already encode direction; a sign
      // inside one of them is redundant at best, and a file that puts "-45.00" in a
      // Debit column would otherwise come out as an inflow.
      if (debitRaw !== '') {
        const parsed = parseMoneyToCents(debitRaw);
        if (parsed.ok) debit = Math.abs(parsed.cents);
        else {
          rowErrors.push(`debit: ${parsed.reason}`);
          ok = false;
        }
      }
      if (creditRaw !== '') {
        const parsed = parseMoneyToCents(creditRaw);
        if (parsed.ok) credit = Math.abs(parsed.cents);
        else {
          rowErrors.push(`credit: ${parsed.reason}`);
          ok = false;
        }
      }

      if (ok) signed = credit - debit;
    }
  }

  if (signed === null) return null;
  if (profile.signConvention !== 'invert') return signed;
  // Guard negative zero, as in `parseMoneyToCents` — inverting a $0.00 authorization
  // would otherwise produce `-0`.
  return signed === 0 ? 0 : -signed;
}

/** The balance is inverted alongside the amounts when the profile inverts, so that
 *  `balance[n] − balance[n−1] === amount[n]` still holds and the reconciliation check
 *  stays meaningful for credit-card exports. */
function readBalance(
  profile: FormatProfile,
  indices: Partial<Record<ColumnRole, number>>,
  cell: (role: ColumnRole) => string,
  rowErrors: string[]
): number | null {
  if (indices.balance === undefined) return null;
  const raw = cell('balance');
  if (raw === '') return null;

  const parsed = parseMoneyToCents(raw);
  if (!parsed.ok) {
    rowErrors.push(`balance: ${parsed.reason}`);
    return null;
  }
  return profile.signConvention === 'invert' ? -parsed.cents : parsed.cents;
}

/**
 * Flag rows that look identical *within one file*.
 *
 * A warning, never a removal. Two coffees on the same day at the same price is a real
 * pair of transactions, and §3.3's multiset merge rule is built precisely so that the
 * second one is not lost — "skipping any row whose key exists loses the second of two
 * genuine identical charges." This exists only so the review screen can point at them.
 */
function findInFileDuplicates(rows: readonly RawRow[]): ParseWarning[] {
  const seen = new Map<string, RawRow>();
  const out: ParseWarning[] = [];

  for (const row of rows) {
    const key = `${row.effectiveDate}|${row.amountCents}|${collapseV1(row.descriptionRaw)}`;
    const first = seen.get(key);
    if (first) {
      out.push({
        kind: 'duplicate_in_file',
        message:
          `Line ${row.lineNumber} looks identical to line ${first.lineNumber} (same date, amount and collapsed description). ` +
          `Both are kept — two genuine identical charges are common, and the merge rule at commit resolves this against what is already stored.`,
        rowIndex: row.rowIndex,
        lineNumber: row.lineNumber,
      });
    } else {
      seen.set(key, row);
    }
  }

  return out;
}

function emptyResult(
  profile: FormatProfile,
  warnings: ParseWarning[],
  reason: string,
  headerCells: readonly string[] | null = null
): ParseResult {
  return {
    rows: [],
    errors: [],
    warnings: [...warnings, { kind: 'header_only', message: reason }],
    parser: NODE_CSV_PARSER_ID,
    parserVersion: NODE_CSV_PARSER_VERSION,
    profileId: profile.id,
    headerSignature: headerCells ? headerSignature(headerCells).signature : null,
    periodStart: null,
    periodEnd: null,
    balanceCheck: { kind: 'unavailable', reason: 'no rows parsed' },
  };
}

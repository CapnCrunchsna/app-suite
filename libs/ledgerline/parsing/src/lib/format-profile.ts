/**
 * Format profiles — the column mapping that turns one bank's CSV into house
 * conventions. Mirrors the `format_profile` table (§3.1) so that persisting one later
 * is a column-for-column write with no translation layer.
 *
 * The profile is where **every bank's disagreement gets absorbed**. §3.1 requires
 * negative to mean money leaving the account uniformly across checking and credit
 * cards; real exports do not agree on that, do not agree on whether there is one
 * signed amount column or separate debit and credit columns, and do not agree on date
 * order. None of that variation is allowed past this boundary — a `RawRow` is always in
 * house conventions, so nothing downstream ever asks "which bank was this?"
 */

import { parseDateToIso } from '@metrum/ledgerline-domain';
import type { AccountType, Currency } from '@metrum/ledgerline-domain';

export type ColumnRole =
  | 'transactionDate'
  | 'postedDate'
  | 'description'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'status';

/** Columns are addressed by header name when the file has a header, and by zero-based
 *  index when it does not. Name matching uses the same normalization as the signature,
 *  so `"Transaction Date"` and `"transaction date"` are the same column. */
export type ColumnRef =
  | { readonly by: 'header'; readonly name: string }
  | { readonly by: 'index'; readonly index: number };

/**
 * `single` — one signed amount column.
 * `debit_credit` — two unsigned columns, at most one populated per row.
 */
export type AmountMode = 'single' | 'debit_credit';

/**
 * Applied *after* the mode has produced a signed amount.
 *
 * `as_is` — the file already agrees with the house convention (negative = leaving).
 * `invert` — the file is the other way round. A credit-card export that prints a $40
 * purchase as `40.00` and a payment as `-500.00` needs `invert`; so does a
 * debit/credit-column file that puts outflows in the column this profile named
 * `credit`.
 *
 * Keeping this a separate flag from `amountMode` is what stops the two axes from
 * multiplying into four hard-coded bank shapes.
 */
export type SignConvention = 'as_is' | 'invert';

export interface FormatProfile {
  readonly id: string;
  readonly institution: string;
  readonly accountTypeHint: AccountType | null;
  /** `format_profile.header_signature`, UNIQUE per §3.1. Empty for headerless files. */
  readonly headerSignature: string;
  readonly headerTokens: readonly string[];
  readonly hasHeader: boolean;
  readonly delimiter: string;
  /** Preamble lines to drop before the header. Bank exports open with account numbers
   *  and address blocks more often than not. */
  readonly skipLines: number;
  /** Explicit, never sniffed — see the note in `domain/dates.ts`. */
  readonly dateFormat: string;
  readonly amountMode: AmountMode;
  readonly signConvention: SignConvention;
  readonly columnMap: Partial<Record<ColumnRole, ColumnRef>>;
  /** Values in the status column that mean "not settled" (§2.5). Compared
   *  case-insensitively after trimming. */
  readonly pendingValues: readonly string[];
  readonly currency: Currency;
  readonly version: number;
  readonly source: 'seed' | 'user';
}

export interface ProfileValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Validate a profile before it is ever used to parse.
 *
 * This runs eagerly and refuses on anything ambiguous. A profile with no amount column
 * fails here with one clear message; the same profile allowed through produces a file
 * of rows that are individually plausible and collectively wrong, which is precisely
 * the failure §2.5's review-before-commit rule exists to prevent — and it is much
 * harder to see on a review screen than a red error on an import.
 */
export function validateProfile(profile: FormatProfile): ProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const map = profile.columnMap;

  if (!map.description) {
    errors.push('columnMap.description is required');
  }

  if (!map.transactionDate && !map.postedDate) {
    errors.push(
      'columnMap needs at least one of transactionDate or postedDate — effective_date is COALESCE(transaction_date, posted_date) and cannot be null (§7.1)'
    );
  }

  if (profile.amountMode === 'single') {
    if (!map.amount) errors.push("amountMode 'single' requires columnMap.amount");
    if (map.debit || map.credit) {
      errors.push("amountMode 'single' must not map debit or credit columns");
    }
  } else {
    if (!map.debit && !map.credit) {
      errors.push("amountMode 'debit_credit' requires columnMap.debit and/or columnMap.credit");
    }
    if (map.amount) {
      errors.push("amountMode 'debit_credit' must not also map an amount column");
    }
    if (!map.debit || !map.credit) {
      warnings.push(
        "amountMode 'debit_credit' with only one of debit/credit mapped — rows on the unmapped side will parse as zero"
      );
    }
  }

  if (!/[YMD]/.test(profile.dateFormat)) {
    errors.push(`dateFormat "${profile.dateFormat}" contains no date tokens`);
  } else {
    const check = parseDateToIso(formatSample(profile.dateFormat), profile.dateFormat);
    if (!check.ok) {
      errors.push(`dateFormat "${profile.dateFormat}" is not usable: ${check.reason}`);
    }
  }

  if (!profile.hasHeader) {
    for (const [role, ref] of Object.entries(map)) {
      if (ref && ref.by === 'header') {
        errors.push(`columnMap.${role} addresses a header by name, but hasHeader is false`);
      }
    }
  }

  if (profile.delimiter.length !== 1) {
    errors.push(`delimiter must be exactly one character (got ${JSON.stringify(profile.delimiter)})`);
  }

  if (!map.balance) {
    warnings.push(
      'no balance column mapped — the running-balance reconciliation check (§6.1) cannot run, ' +
        'which is the strongest available signal that the amount column and sign convention are right'
    );
  }

  if (profile.currency !== 'USD') {
    errors.push('v1 is single-currency USD (§3.2, plan question 5)');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Build a syntactically valid sample for a format so the format itself can be
 *  round-tripped at validation time rather than failing on the first real row. */
function formatSample(format: string): string {
  return format
    .replace(/YYYY/g, '2026')
    .replace(/YY/g, '26')
    .replace(/MMM/g, 'Jan')
    .replace(/MM/g, '01')
    .replace(/DD/g, '31')
    .replace(/(?<![0-9])M(?![0-9M])/g, '1')
    .replace(/(?<![0-9])D(?![0-9D])/g, '31');
}

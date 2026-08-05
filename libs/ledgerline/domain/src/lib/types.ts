/**
 * The value types the parse-to-analyze pipeline moves around (§2.5).
 *
 * These are plain data. `domain` depends on nothing (§2.2, `type:domain` →
 * `onlyDependOnLibsWithTags: []`), so nothing here may reference a framework, a
 * database handle, or an I/O type.
 */

export type AccountType = 'checking' | 'savings' | 'credit_card';

/**
 * §2.5: "Pending rows never analyze." A CSV pulled mid-cycle contains authorizations
 * that have not settled; the same charge later posts on a different date and often a
 * different amount — a tip turns a $50.00 pending into a $59.00 posted. Pending rows
 * are stored and shown, and excluded from every analyzer and every total.
 */
export type RowStatus = 'posted' | 'pending';

/** `raw_row.parse_status` (§3.1). */
export type ParseStatus = 'ok' | 'error';

/** `raw_row.parse_source` (§3.1). `llm` forces the review screen and blocks silent
 *  commit (§2.5); nothing in this build produces it yet. */
export type ParseSource = 'csv' | 'pdf' | 'llm';

/** v1 is single-currency (§3.2, plan question 5 resolved 2026-08-03). The type stays
 *  explicit so a future non-USD account is a change the compiler points at. */
export type Currency = 'USD';

/**
 * One successfully parsed statement line, in the house conventions: signed integer
 * cents with negative meaning money leaving the account, ISO dates, and an
 * `effectiveDate` already resolved per §7.1.
 *
 * `rawText` is the verbatim source line and is preserved into `raw_row.raw_text`
 * (§2.5). It is what the review screen shows when a parse looks wrong, so it must
 * never be normalized, trimmed or re-encoded on the way through.
 */
export interface RawRow {
  /** Zero-based ordinal among the file's data rows — `raw_row.row_index` (§3.1). */
  readonly rowIndex: number;
  /** 1-based physical line in the source file. Carried separately from `rowIndex`
   *  because a preamble and a header row make the two differ, and every diagnostic a
   *  human acts on wants the line they can actually go look at. */
  readonly lineNumber: number;
  readonly rawText: string;
  readonly transactionDate: string | null;
  readonly postedDate: string | null;
  /** COALESCE(transactionDate, postedDate) — the only date analysis may use. */
  readonly effectiveDate: string;
  readonly descriptionRaw: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly status: RowStatus;
  readonly currency: Currency;
  readonly parseStatus: 'ok';
  readonly parseSource: ParseSource;
}

/** A line that could not be parsed. Kept rather than dropped: §2.5's review-before-
 *  commit exists so a misparse is visible before it can poison a finding. */
export interface RawRowError {
  readonly rowIndex: number;
  readonly lineNumber: number;
  readonly rawText: string;
  readonly parseStatus: 'error';
  readonly parseSource: ParseSource;
  readonly errors: readonly string[];
}

export type ParseWarningKind =
  /** §3.2 allows $0 only for trial authorizations; everything else is a misparse. */
  | 'zero_amount'
  | 'pending_row'
  | 'balance_mismatch'
  | 'balance_unavailable'
  | 'unparsed_row'
  | 'duplicate_in_file'
  | 'empty_description'
  | 'header_only'
  /** The profile applied, but its `header_signature` no longer matches the file — the
   *  bank changed its export header (plan question 2). */
  | 'signature_mismatch'
  /** The parsed balances imply the profile's `signConvention` is backwards. */
  | 'sign_convention_suspect'
  /** A non-fatal complaint from `validateProfile`. */
  | 'profile_warning';

export interface ParseWarning {
  readonly kind: ParseWarningKind;
  readonly message: string;
  readonly rowIndex?: number;
  readonly lineNumber?: number;
}

/**
 * The result of checking `balance[n] − balance[n−1] === amount[n]` across the file
 * (§6.1's warning strip).
 *
 * A file that reconciles has proved three things: the amount column really is the
 * amount column, no row was dropped or duplicated, and the amount and balance columns
 * agree with each other. That is the most valuable validation available at parse time —
 * §2.5 warns that a misparsed amount column "poisons every downstream finding, and it
 * is very hard to notice after the fact."
 *
 * **It does not prove the sign convention.** `signConvention: 'invert'` flips the
 * balance alongside the amount, so `(−b[n]) − (−b[n−1]) === −a[n]` holds exactly as
 * well as the un-inverted form. A profile with the convention backwards reconciles
 * perfectly and every number in the app is inverted. `sign_convention_suspect` is the
 * separate check for that; see `checkSignPlausibility`.
 *
 * Row order is not assumed: both directions are tried, because banks export
 * newest-first about as often as oldest-first.
 */
export type BalanceCheck =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'reconciled';
      readonly order: 'ascending' | 'descending';
      readonly rowsChecked: number;
    }
  | {
      readonly kind: 'mismatch';
      readonly bestOrder: 'ascending' | 'descending';
      readonly rowsChecked: number;
      /** How many rows disagreed in total. Carried separately from `failures`, which is
       *  capped — a profile with the wrong sign convention fails on every row, and
       *  reporting the capped length as the total would say "10 of 500 rows disagree"
       *  about a file where all 500 did. */
      readonly failureCount: number;
      readonly failures: readonly BalanceMismatch[];
    };

export interface BalanceMismatch {
  readonly rowIndex: number;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly deltaCents: number;
}

/**
 * Everything one parse produced. This is a *value* — nothing here has been written
 * anywhere. §2.1: "Libs compute; the app persists."
 */
export interface ParseResult {
  readonly rows: readonly RawRow[];
  readonly errors: readonly RawRowError[];
  readonly warnings: readonly ParseWarning[];
  readonly parser: string;
  readonly parserVersion: string;
  readonly profileId: string | null;
  readonly headerSignature: string | null;
  /** Min/max `effectiveDate` across parsed rows. `statement_import.period_start` and
   *  `period_end` (§3.1) — which §7.2's coverage calculation depends on. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly balanceCheck: BalanceCheck;
}

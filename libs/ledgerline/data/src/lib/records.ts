/**
 * What the repositories return.
 *
 * These are the store's *values*, not its rows: camelCase, `boolean` rather than
 * `0 | 1`, and no `better-sqlite3` type anywhere in the shape. That is what lets
 * §2.2's claim hold in practice — `data` is the only lib that knows a store
 * exists, and the boundary is only real if callers cannot tell what kind of
 * store it is from the values they receive.
 *
 * §3.4 is the other reason. The Elasticsearch implementation has to satisfy
 * these same types; anything leaking `INTEGER 0/1` or a `snake_case` key into a
 * caller would be a rewrite rather than a swap.
 */

import type { AccountType, Currency, ParseSource, ParseStatus } from '@metrum/ledgerline-domain';

/** `merchant_alias.source` and `transaction.category_source` (§4.3 precedence). */
export type ProvenanceSource = 'seed' | 'rule' | 'llm' | 'user';
export type AliasMatchKind = 'exact' | 'prefix' | 'fuzzy';

export interface AccountRecord {
  readonly id: string;
  readonly displayName: string;
  readonly institution: string | null;
  readonly accountType: AccountType;
  readonly last4: string | null;
  readonly currency: Currency;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `uploaded` → the bytes are stored and hashed, nothing else is known.
 * `needs_mapping` → §2.5's unmatched-CSV case; the mapping UI is the next step.
 * `staged` → parsed, reviewable, nothing in `transaction` yet.
 * `committed` → rows landed. Re-parse is refused from here (§6.1).
 * `failed` → the parser recognized the file and could not read it.
 */
export type ImportStatus = 'uploaded' | 'needs_mapping' | 'staged' | 'committed' | 'failed';

export interface StatementImportRecord {
  readonly id: string;
  readonly accountId: string | null;
  readonly sourceFilename: string;
  readonly fileSha256: string;
  readonly fileSizeBytes: number;
  readonly formatProfileId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly rowsParsed: number;
  readonly rowsInserted: number;
  readonly rowsDuplicate: number;
  readonly status: ImportStatus;
  readonly parser: string | null;
  readonly parserVersion: string | null;
  readonly errorDetail: string | null;
  /** Parser warnings and the balance-reconciliation verdict, for the review
   *  screen warning strip. Serialized because `data` may not name the parser's
   *  types (spec 2.2). */
  readonly diagnosticsJson: string | null;
  readonly importedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RawRowRecord {
  readonly id: string;
  readonly importId: string;
  readonly rowIndex: number;
  readonly rawText: string;
  /** The serialized `RawRow` (or `RawRowError`) the parser produced. */
  readonly parsedJson: string | null;
  readonly parseStatus: ParseStatus;
  readonly parseSource: ParseSource;
}

export interface TransactionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly rawRowId: string | null;
  readonly postedDate: string | null;
  readonly transactionDate: string | null;
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly currency: Currency;
  readonly descriptionRaw: string;
  readonly descriptionNormalized: string;
  readonly merchantId: string | null;
  readonly categoryId: string | null;
  readonly categorySource: ProvenanceSource | null;
  readonly isPending: boolean;
  readonly isInternalTransfer: boolean;
  readonly transferPairId: string | null;
  /** Shared by both rows of a reversal (§3.3). Null when the row is not one. */
  readonly refundPairId: string | null;
  readonly isExcluded: boolean;
  readonly allowsZeroAmount: boolean;
  readonly dedupeKey: string;
  readonly dedupeKeyVersion: string;
  readonly occurrenceIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MerchantRecord {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly website: string | null;
  readonly defaultCategoryId: string | null;
  readonly isKnownSubscription: boolean;
  readonly isTransferKind: boolean;
  readonly overlapGroup: string | null;
  readonly source: ProvenanceSource;
}

export interface MerchantAliasRecord {
  readonly id: string;
  readonly aliasKey: string;
  readonly merchantId: string;
  readonly matchType: AliasMatchKind;
  readonly confidence: number | null;
  readonly source: ProvenanceSource;
}

export interface CategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: 'spend' | 'fee' | 'transfer' | 'income';
  readonly overlapGroup: string | null;
  /** Migration 009. `seed` is the shipped taxonomy; `user` is a row §6.8's editor
   *  created or touched, which the boot re-seed may no longer overwrite. */
  readonly source: CategorySource;
}

/** Two, not §4.3's four: only the shipped set and a person write categories
 *  (§9x forbids the LLM from creating one). */
export type CategorySource = 'seed' | 'user';

export interface FormatProfileRecord {
  readonly id: string;
  readonly institution: string;
  readonly accountTypeHint: AccountType | null;
  readonly headerSignature: string;
  readonly headerTokens: readonly string[];
  readonly hasHeader: boolean;
  readonly delimiter: string;
  readonly skipLines: number;
  readonly columnMapJson: string;
  readonly dateFormat: string;
  /** The regex that reads this bank's declared statement period out of the
   *  preamble, or `null` for an export that declares none (§9h). */
  readonly periodPattern: string | null;
  readonly amountMode: 'single' | 'debit_credit';
  readonly signConvention: 'as_is' | 'invert';
  readonly pendingValues: readonly string[];
  readonly currency: Currency;
  readonly version: number;
  readonly source: 'seed' | 'user';
}

export interface TombstoneRecord {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly deletedAt: string;
}

// --------------------------------------------------------------- mapping ---
// Explicit row→record functions rather than a generic snake/camel converter.
// A generic converter is shorter and turns a renamed column into a silently
// `undefined` field; these turn it into a compile error.

const bool = (value: number): boolean => value === 1;

export interface AccountRow {
  id: string;
  display_name: string;
  institution: string | null;
  account_type: AccountType;
  last4: string | null;
  currency: Currency;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export function toAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    institution: row.institution,
    accountType: row.account_type,
    last4: row.last4,
    currency: row.currency,
    isActive: bool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface StatementImportRow {
  id: string;
  account_id: string | null;
  source_filename: string;
  file_sha256: string;
  file_size_bytes: number;
  format_profile_id: string | null;
  period_start: string | null;
  period_end: string | null;
  rows_parsed: number;
  rows_inserted: number;
  rows_duplicate: number;
  status: ImportStatus;
  parser: string | null;
  parser_version: string | null;
  error_detail: string | null;
  diagnostics_json: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toStatementImport(row: StatementImportRow): StatementImportRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceFilename: row.source_filename,
    fileSha256: row.file_sha256,
    fileSizeBytes: row.file_size_bytes,
    formatProfileId: row.format_profile_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowsParsed: row.rows_parsed,
    rowsInserted: row.rows_inserted,
    rowsDuplicate: row.rows_duplicate,
    status: row.status,
    parser: row.parser,
    parserVersion: row.parser_version,
    errorDetail: row.error_detail,
    diagnosticsJson: row.diagnostics_json,
    importedAt: row.imported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RawRowRow {
  id: string;
  import_id: string;
  row_index: number;
  raw_text: string;
  parsed_json: string | null;
  parse_status: ParseStatus;
  parse_source: ParseSource;
}

export function toRawRow(row: RawRowRow): RawRowRecord {
  return {
    id: row.id,
    importId: row.import_id,
    rowIndex: row.row_index,
    rawText: row.raw_text,
    parsedJson: row.parsed_json,
    parseStatus: row.parse_status,
    parseSource: row.parse_source,
  };
}

export interface TransactionRow {
  id: string;
  account_id: string;
  raw_row_id: string | null;
  posted_date: string | null;
  transaction_date: string | null;
  effective_date: string;
  amount_cents: number;
  balance_cents: number | null;
  currency: Currency;
  description_raw: string;
  description_normalized: string;
  merchant_id: string | null;
  category_id: string | null;
  category_source: ProvenanceSource | null;
  is_pending: number;
  is_internal_transfer: number;
  transfer_pair_id: string | null;
  refund_pair_id: string | null;
  is_excluded: number;
  allows_zero_amount: number;
  dedupe_key: string;
  dedupe_key_version: string;
  occurrence_index: number;
  created_at: string;
  updated_at: string;
}

export function toTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    rawRowId: row.raw_row_id,
    postedDate: row.posted_date,
    transactionDate: row.transaction_date,
    effectiveDate: row.effective_date,
    amountCents: row.amount_cents,
    balanceCents: row.balance_cents,
    currency: row.currency,
    descriptionRaw: row.description_raw,
    descriptionNormalized: row.description_normalized,
    merchantId: row.merchant_id,
    categoryId: row.category_id,
    categorySource: row.category_source,
    isPending: bool(row.is_pending),
    isInternalTransfer: bool(row.is_internal_transfer),
    transferPairId: row.transfer_pair_id,
    refundPairId: row.refund_pair_id,
    isExcluded: bool(row.is_excluded),
    allowsZeroAmount: bool(row.allows_zero_amount),
    dedupeKey: row.dedupe_key,
    dedupeKeyVersion: row.dedupe_key_version,
    occurrenceIndex: row.occurrence_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MerchantRow {
  id: string;
  canonical_name: string;
  display_name: string;
  website: string | null;
  default_category_id: string | null;
  is_known_subscription: number;
  is_transfer_kind: number;
  overlap_group: string | null;
  source: ProvenanceSource;
}

export function toMerchant(row: MerchantRow): MerchantRecord {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    website: row.website,
    defaultCategoryId: row.default_category_id,
    isKnownSubscription: bool(row.is_known_subscription),
    isTransferKind: bool(row.is_transfer_kind),
    overlapGroup: row.overlap_group,
    source: row.source,
  };
}

export interface MerchantAliasRow {
  id: string;
  alias_key: string;
  merchant_id: string;
  match_type: AliasMatchKind;
  confidence: number | null;
  source: ProvenanceSource;
}

export function toMerchantAlias(row: MerchantAliasRow): MerchantAliasRecord {
  return {
    id: row.id,
    aliasKey: row.alias_key,
    merchantId: row.merchant_id,
    matchType: row.match_type,
    confidence: row.confidence,
    source: row.source,
  };
}

export interface FormatProfileRow {
  id: string;
  institution: string;
  account_type_hint: AccountType | null;
  header_signature: string;
  header_tokens_json: string;
  has_header: number;
  delimiter: string;
  skip_lines: number;
  column_map_json: string;
  date_format: string;
  period_pattern: string | null;
  amount_mode: 'single' | 'debit_credit';
  sign_convention: 'as_is' | 'invert';
  pending_values_json: string;
  currency: Currency;
  version: number;
  source: 'seed' | 'user';
}

export function toFormatProfile(row: FormatProfileRow): FormatProfileRecord {
  return {
    id: row.id,
    institution: row.institution,
    accountTypeHint: row.account_type_hint,
    headerSignature: row.header_signature,
    headerTokens: JSON.parse(row.header_tokens_json) as string[],
    hasHeader: bool(row.has_header),
    delimiter: row.delimiter,
    skipLines: row.skip_lines,
    columnMapJson: row.column_map_json,
    dateFormat: row.date_format,
    periodPattern: row.period_pattern,
    amountMode: row.amount_mode,
    signConvention: row.sign_convention,
    pendingValues: JSON.parse(row.pending_values_json) as string[],
    currency: row.currency,
    version: row.version,
    source: row.source,
  };
}

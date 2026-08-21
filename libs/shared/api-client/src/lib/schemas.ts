// GENERATED — NEVER HAND-EDIT.
//
// Emitted by `tools/generate-api-client.mjs` from
// `apps/ledgerline-api/openapi.json` (spec 2.1, 2.2, 2.3). Hand edits are
// silently overwritten by the next generation run.
//
// To change anything here, change the Fastify route schema that produces it and
// regenerate:
//
//     npx nx generate-client api-client
//
// `ledgerline-api`'s test suite fails if this directory and `openapi.json`
// disagree, so a stale client cannot reach a commit.

/**
 * The wire types, one per `components.schemas` entry.
 *
 * `readonly` throughout: these are what the API said, and a UI that mutates a
 * response is a UI that has invented a fact about the store. Money is `number`
 * because every money field on the wire is integer cents (spec 3.1, 7.3) — format
 * it for display with `formatCents` and never parse a formatted string back.
 */
export interface ApiError {
  /** Stable machine-readable code */
  readonly error?: string;
  readonly message?: string;
  /** Present on `zero_amount_rows`: the rows that parsed to $0.00. */
  readonly rowIndexes?: number[];
}

export interface Account {
  readonly id: string;
  readonly displayName: string;
  readonly institution: string | null;
  readonly accountType: 'checking' | 'savings' | 'credit_card';
  readonly last4: string | null;
  readonly currency: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Transaction {
  readonly id: string;
  readonly accountId: string;
  readonly rawRowId: string | null;
  readonly postedDate: string | null;
  readonly transactionDate: string | null;
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly currency: string;
  readonly descriptionRaw: string;
  readonly descriptionNormalized: string;
  readonly merchantId: string | null;
  readonly categoryId: string | null;
  readonly categorySource: 'seed' | 'rule' | 'llm' | 'user' | null;
  readonly isPending: boolean;
  readonly isInternalTransfer: boolean;
  readonly transferPairId: string | null;
  readonly refundPairId: string | null;
  readonly isExcluded: boolean;
  readonly allowsZeroAmount: boolean;
  readonly dedupeKey: string;
  readonly dedupeKeyVersion: string;
  readonly occurrenceIndex: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionSearchRow {
  readonly transaction: Transaction;
  readonly hasFinding: boolean;
}

export interface TransactionPage {
  readonly rows: TransactionSearchRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface StatementImport {
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
  readonly status: 'uploaded' | 'needs_mapping' | 'staged' | 'committed' | 'failed';
  readonly parser: string | null;
  readonly parserVersion: string | null;
  readonly errorDetail: string | null;
  readonly diagnosticsJson: string | null;
  readonly importedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionSourceLine {
  readonly importId: string;
  readonly sourceFilename: string;
  readonly rawText: string | null;
}

export interface TransactionDetail {
  readonly transaction: Transaction;
  readonly coveringImports: StatementImport[];
  readonly rawText: string | null;
  readonly sources: TransactionSourceLine[];
}

export interface Merchant {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly website: string | null;
  readonly defaultCategoryId: string | null;
  readonly isKnownSubscription: boolean;
  readonly isTransferKind: boolean;
  readonly overlapGroup: string | null;
  readonly source: 'seed' | 'rule' | 'llm' | 'user';
}

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: 'spend' | 'fee' | 'transfer' | 'income';
  readonly overlapGroup: string | null;
}

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly progress: number;
  readonly message: string | null;
  readonly resultJson: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Finding {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly naturalKey: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  readonly detail: Record<string, unknown>;
  readonly confidence: number;
  readonly band: 'high' | 'medium' | 'low' | 'suppressed';
  readonly impactKind: 'savings' | 'visibility';
  readonly impactMonthlyCents: number;
  readonly impactAnnualCents: number;
  readonly llmDependent: boolean;
  readonly evidenceHash: string;
  readonly evidenceTransactionIds: string[];
  readonly firstDetectedAt: string;
  readonly status: 'active' | 'resolved' | 'suppressed';
  readonly userStatus: 'acknowledged' | 'snoozed' | 'dismissed' | null;
  readonly snoozeUntil: string | null;
  readonly changedSinceDismissal: boolean;
  readonly reEvaluated: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FindingPage {
  readonly rows: Finding[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SubscriptionTotals {
  readonly activeCount: number;
  readonly lapsedCount: number;
  readonly monthlyCents: number;
  readonly annualCents: number;
}

export interface FindingsSummary {
  readonly subscriptions: SubscriptionTotals;
  readonly savingsAnnualCents: number;
  readonly savingsMonthlyCents: number;
  readonly activeFindingCount: number;
  readonly unreviewedCount: number;
  readonly countsByRule: Record<string, unknown>;
  readonly countsByBand: Record<string, unknown>;
  readonly lastRunAt: string | null;
  readonly lastRunConfigHash: string | null;
  readonly lastRunSnapshotRows: number | null;
  readonly configHash: string;
}

export interface DismissalRule {
  readonly id: string;
  readonly scope: 'merchant_rule' | 'rule';
  readonly ruleId: string;
  readonly merchantId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CoveragePeriod {
  readonly importId: string;
  readonly sourceFilename: string;
  readonly start: string;
  readonly end: string;
}

export interface CoverageMonth {
  /** `YYYY-MM` */
  readonly month: string;
  readonly state: 'covered' | 'partial' | 'missing';
  readonly covered: boolean;
  readonly transactionCount: number;
}

export interface AccountCoverage {
  readonly accountId: string;
  readonly periods: CoveragePeriod[];
  readonly months: CoverageMonth[];
  readonly coverageStart: string | null;
  readonly coverageEnd: string | null;
  readonly gapMonths: string[];
  readonly partialMonths: string[];
  readonly transactionCount: number;
  readonly unmatchedTransferCount: number;
}

export interface AccountMergeResult {
  readonly targetAccountId: string;
  readonly sourceAccountId: string;
  readonly transactionsMoved: number;
  readonly importsMoved: number;
  readonly occurrencesRenumbered: number;
  readonly seriesMoved: number;
  readonly evidenceMoved: number;
  readonly selfLinksRemoved: number;
}

export interface TransferReason {
  /** Stable code from spec 2.6’s scoring table */
  readonly signal: string;
  readonly points: number;
  readonly detail: string;
}

export interface TransferLink {
  readonly id: string;
  readonly state: 'proposed' | 'confirmed' | 'rejected' | 'auto';
  readonly kind: 'one_to_one' | 'partial';
  readonly score: number;
  readonly reasons: TransferReason[];
  readonly debits: Transaction[];
  readonly credit: Transaction;
  readonly debitAccount: {
    readonly id: string;
    readonly displayName: string;
    readonly institution: string | null;
    readonly accountType: 'checking' | 'savings' | 'credit_card';
    readonly last4: string | null;
    readonly currency: string;
    readonly isActive: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  readonly creditAccount: {
    readonly id: string;
    readonly displayName: string;
    readonly institution: string | null;
    readonly accountType: 'checking' | 'savings' | 'credit_card';
    readonly last4: string | null;
    readonly currency: string;
    readonly isActive: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  readonly amountCents: number;
  readonly spendReductionCents: number;
  readonly dayGapDays: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferProposeResult {
  readonly autoLinked: number;
  readonly proposed: number;
  readonly ignored: number;
  readonly inserted: number;
  readonly updated: number;
  readonly withdrawn: number;
  readonly flagged: number;
  readonly unflagged: number;
}

export interface TransactionFilter {
  readonly accountIds?: string[];
  readonly merchantIds?: string[];
  readonly categoryIds?: string[];
  readonly descriptorsNormalized?: string[];
  readonly from?: string;
  readonly to?: string;
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
  readonly isPending?: boolean;
  readonly hasFinding?: boolean;
  readonly includeInternalTransfers?: boolean;
  readonly includeExcluded?: boolean;
  readonly q?: string;
}

export interface TransactionBulkChange {
  readonly merchantId?: string | null;
  readonly categoryId?: string | null;
  readonly isInternalTransfer?: boolean;
  readonly isExcluded?: boolean;
}

export interface TransactionBulkResult {
  readonly dryRun: boolean;
  readonly matchCount: number;
  readonly updated: number;
  readonly aliasKeysWritten: string[];
  readonly renormalizeJobId: string | null;
  readonly renormalizeJobCoalesced: boolean;
}

export interface AccountSuggestion {
  readonly accountId: string;
  readonly reason: string;
}

export interface RawRow {
  readonly rowIndex: number;
  readonly lineNumber: number;
  readonly rawText: string;
  readonly transactionDate: string | null;
  readonly postedDate: string | null;
  readonly effectiveDate: string;
  readonly descriptionRaw: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly status: 'posted' | 'pending';
  readonly currency: string;
  readonly parseStatus: 'ok' | 'error';
  readonly parseSource: 'csv' | 'pdf' | 'llm';
}

export interface RawRowRecord {
  readonly id: string;
  readonly importId: string;
  readonly rowIndex: number;
  readonly rawText: string;
  readonly parsedJson: string | null;
  readonly parseStatus: 'ok' | 'error';
  readonly parseSource: 'csv' | 'pdf' | 'llm';
}

export interface ParseWarning {
  readonly kind: 'zero_amount' | 'pending_row' | 'balance_mismatch' | 'balance_unavailable' | 'unparsed_row' | 'duplicate_in_file' | 'empty_description' | 'header_only' | 'signature_mismatch' | 'sign_convention_suspect' | 'profile_warning';
  readonly message: string;
  readonly rowIndex?: number;
  readonly lineNumber?: number;
}

export interface BalanceMismatch {
  readonly rowIndex: number;
  readonly expectedCents: number;
  readonly actualCents: number;
  readonly deltaCents: number;
}

export interface BalanceCheck {
  readonly kind: 'unavailable' | 'reconciled' | 'mismatch';
  readonly reason?: string;
  readonly order?: 'ascending' | 'descending';
  readonly rowsChecked?: number;
  readonly bestOrder?: 'ascending' | 'descending';
  readonly failureCount?: number;
  readonly failures?: BalanceMismatch[];
}

export interface ReviewRow {
  readonly rowIndex: number;
  readonly rawText: string;
  readonly row: RawRow;
  readonly disposition: 'insert' | 'duplicate' | 'near_duplicate';
}

export interface NearDuplicateCandidate {
  readonly rowIndex: number;
  readonly existingTransactionId: string;
  readonly existingEffectiveDate: string;
  readonly existingAmountCents: number;
  readonly existingDescriptionRaw: string;
  readonly existingIsPending: boolean;
  readonly dayGap: number;
  readonly amountDeltaCents: number;
  readonly pendingToPosted: boolean;
  readonly defaultResolution: 'replace' | 'keep_both' | 'skip';
}

export interface ReviewPlan {
  readonly willInsert: number;
  readonly alreadyPresent: number;
  readonly nearDuplicates: NearDuplicateCandidate[];
}

export interface ImportReview {
  readonly import: StatementImport;
  readonly accountSuggestion: {
    readonly accountId: string;
    readonly reason: string;
  } | null;
  readonly warnings: ParseWarning[];
  readonly balanceCheck: BalanceCheck;
  readonly rows: ReviewRow[];
  readonly unparsedRows: RawRowRecord[];
  readonly plan: {
    readonly willInsert: number;
    readonly alreadyPresent: number;
    readonly nearDuplicates: NearDuplicateCandidate[];
  } | null;
}

export interface StagedUpload {
  readonly import: StatementImport;
  readonly created: boolean;
  readonly accountSuggestion: {
    readonly accountId: string;
    readonly reason: string;
  } | null;
}

export interface UploadResult {
  readonly imports: StagedUpload[];
}

export interface CommitResult {
  readonly importId: string;
  readonly rowsParsed: number;
  readonly rowsInserted: number;
  readonly rowsDuplicate: number;
  readonly rowsMerged: number;
  readonly rowsSkippedAsNearDuplicate: number;
  readonly rowsReplaced: number;
  readonly refundPairsLinked: number;
  readonly insertedTransactionIds: string[];
  readonly alreadyCommitted: boolean;
}

export interface DeleteImportResult {
  readonly deletedTransactionIds: string[];
  readonly retainedTransactionIds: string[];
}

export interface ColumnRef {
  readonly by: 'header' | 'index';
  readonly name?: string;
  readonly index?: number;
}

export interface ColumnMap {
  readonly transactionDate?: ColumnRef;
  readonly postedDate?: ColumnRef;
  readonly description?: ColumnRef;
  readonly amount?: ColumnRef;
  readonly debit?: ColumnRef;
  readonly credit?: ColumnRef;
  readonly balance?: ColumnRef;
  readonly status?: ColumnRef;
}

export interface FormatProfile {
  readonly id: string;
  readonly institution: string;
  readonly accountTypeHint: 'checking' | 'savings' | 'credit_card' | null;
  readonly headerSignature: string;
  readonly headerTokens: string[];
  readonly hasHeader: boolean;
  readonly delimiter: string;
  readonly skipLines: number;
  readonly dateFormat: string;
  readonly amountMode: 'single' | 'debit_credit';
  readonly signConvention: 'as_is' | 'invert';
  readonly columnMap: ColumnMap;
  readonly pendingValues: string[];
  readonly currency: string;
  readonly version: number;
  readonly source: 'seed' | 'user';
}

export interface FormatProfileDraft {
  readonly id?: string;
  readonly institution: string;
  readonly accountTypeHint?: 'checking' | 'savings' | 'credit_card' | null;
  readonly hasHeader?: boolean;
  readonly delimiter?: string;
  readonly skipLines?: number;
  readonly dateFormat: string;
  readonly amountMode?: 'single' | 'debit_credit';
  readonly signConvention?: 'as_is' | 'invert';
  readonly columnMap: ColumnMap;
  readonly pendingValues?: string[];
}

export interface FormatProfilePreview {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  readonly rows: RawRow[];
  readonly failures: {
    readonly rowIndex?: number;
    readonly lineNumber?: number;
    readonly rawText?: string;
    readonly errors?: string[];
  }[];
  readonly parseWarnings: ParseWarning[];
  readonly balanceCheck: BalanceCheck;
  readonly headerSignature: string;
  readonly headerTokens: string[];
  readonly detectedDelimiter: string;
  readonly detectedSkipLines: number;
  readonly sampleRows: {
    readonly cells?: string[];
  }[];
}

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

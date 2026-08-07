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

import type {
  ApiError,
  Account,
  Transaction,
  TransactionPage,
  TransactionDetail,
  Merchant,
  Category,
  Job,
  TransactionFilter,
  TransactionBulkChange,
  TransactionBulkResult,
} from './schemas.js';

/** Where the API listens by default (spec 2.1: it binds loopback, never 0.0.0.0). */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4310';

/** Base path every operation in spec 2.3's table is mounted under. */
export const API_BASE_PATH = '/api';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LedgerlineApiOptions {
  /** Defaults to `DEFAULT_BASE_URL`. */
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * A non-2xx response, carrying the API's own error body.
 *
 * The API declares one error shape on every route that can fail (`ApiError`), and
 * `error` there is documented as a "stable machine-readable code". Throwing the
 * parsed body rather than a bare status is what lets a caller branch on the code
 * instead of on prose that may be reworded.
 */
export class LedgerlineApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    message: string
  ) {
    super(message);
    this.name = 'LedgerlineApiError';
  }

  /** The machine-readable code, when the API sent one. */
  get code(): string | null {
    return this.body?.error ?? null;
  }
}

/**
 * Local statement analyzer. Binds 127.0.0.1 and has no authentication: it is a single-user process holding every statement its owner has imported.
 */
function buildQuery(query: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // An array parameter is comma-joined, because that is how the API declares
    // every list filter it accepts: `accountIds` is one string of ids, not
    // repeated keys (see `GET /api/transactions`).
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

interface RequestOptions {
  /** `object` rather than `Record<string, unknown>`: the generated query
   *  interfaces have `readonly` properties and no index signature, which makes
   *  them unassignable to a `Record`. `Object.entries` needs neither. */
  readonly query?: object;
  readonly body?: unknown;
}

export type GetHealthResponse = {
  readonly ok?: boolean;
  readonly schemaVersion?: number;
  readonly transactions?: number;
  readonly profileLoadErrors?: string[];
};

export type ListImportsResponse = ({
  readonly id?: string;
  readonly accountId?: string | null;
  readonly sourceFilename?: string;
  readonly fileSha256?: string;
  readonly fileSizeBytes?: number;
  readonly formatProfileId?: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly rowsParsed?: number;
  readonly rowsInserted?: number;
  readonly rowsDuplicate?: number;
  readonly status?: 'uploaded' | 'needs_mapping' | 'staged' | 'committed' | 'failed';
  readonly parser?: string | null;
  readonly parserVersion?: string | null;
  readonly errorDetail?: string | null;
  readonly diagnosticsJson?: string | null;
  readonly importedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
})[];

export type UploadImportsResponse = {
  readonly imports?: ({
    readonly import?: {
      readonly id?: string;
      readonly accountId?: string | null;
      readonly sourceFilename?: string;
      readonly fileSha256?: string;
      readonly fileSizeBytes?: number;
      readonly formatProfileId?: string | null;
      readonly periodStart?: string | null;
      readonly periodEnd?: string | null;
      readonly rowsParsed?: number;
      readonly rowsInserted?: number;
      readonly rowsDuplicate?: number;
      readonly status?: 'uploaded' | 'needs_mapping' | 'staged' | 'committed' | 'failed';
      readonly parser?: string | null;
      readonly parserVersion?: string | null;
      readonly errorDetail?: string | null;
      readonly diagnosticsJson?: string | null;
      readonly importedAt?: string | null;
      readonly createdAt?: string;
      readonly updatedAt?: string;
    };
    readonly created?: boolean;
    readonly accountSuggestion?: {
      readonly accountId?: string;
      readonly reason?: string;
    } | null;
  })[];
};

export type UpdateImportBody = {
  readonly accountId?: string;
  readonly formatProfileId?: string;
  readonly reparse?: boolean;
};

export type DeleteImportResponse = {
  readonly deletedTransactionIds?: string[];
  readonly retainedTransactionIds?: string[];
};

export type CommitImportBody = {
  readonly resolutions?: ({
    readonly rowIndex: number;
    readonly existingTransactionId: string;
    readonly resolution: 'replace' | 'keep_both' | 'skip';
  })[];
  /**
   * Store $0 rows as trial authorizations. Without it a non-pending $0 row is refused as a probable misparse (spec 3.2).
   */
  readonly allowZeroAmountRows?: boolean;
};

export type ListAccountsResponse = Account[];

export type CreateAccountBody = {
  readonly displayName: string;
  readonly accountType: 'checking' | 'savings' | 'credit_card';
  readonly institution?: string | null;
  readonly last4?: string | null;
};

export type UpdateAccountBody = {
  readonly displayName?: string;
  readonly institution?: string | null;
  readonly accountType?: 'checking' | 'savings' | 'credit_card';
  readonly last4?: string | null;
  readonly isActive?: boolean;
};

export interface ListTransactionsQuery {
  readonly accountIds?: string;
  readonly merchantIds?: string;
  readonly categoryIds?: string;
  readonly from?: string;
  readonly to?: string;
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
  readonly isPending?: boolean;
  readonly hasFinding?: boolean;
  readonly includeInternalTransfers?: boolean;
  readonly includeExcluded?: boolean;
  readonly q?: string;
  readonly sort?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
  readonly limit?: number;
  readonly offset?: number;
}

export interface BulkUpdateTransactionsQuery {
  readonly dryRun?: boolean;
}

export type BulkUpdateTransactionsBody = {
  readonly filter: TransactionFilter;
  readonly change?: TransactionBulkChange;
};

export type ListMerchantsResponse = Merchant[];

export type ListCategoriesResponse = Category[];

export interface ListJobsQuery {
  readonly limit?: number;
}

export type ListJobsResponse = Job[];

export type BackupDataResponse = {
  readonly path?: string;
  readonly createdAt?: string;
};

export interface ExportDataQuery {
  readonly format?: 'json' | 'csv';
}

/**
 * Every operation in the emitted contract, one method each.
 *
 * Framework-free on purpose: `api-client` may depend on nothing (spec 2.2), so
 * this is `fetch` and not `HttpClient`. Wrap it in an injectable in the feature
 * lib that consumes it — that is where Angular belongs.
 */
export class LedgerlineApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: LedgerlineApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Liveness, schema version, and any profile that failed to load at boot */
  getHealth(): Promise<GetHealthResponse> {
    return this.request<GetHealthResponse>('GET', `/api/health`, {
    });
  }

  /** Import history */
  listImports(): Promise<ListImportsResponse> {
    return this.request<ListImportsResponse>('GET', `/api/imports`, {
    });
  }

  /**
   * Upload one or more statement files
   *
   * Stages and parses; commits nothing. A byte-identical re-upload returns the existing import untouched (spec 3.3, idempotency layer one).
   */
  uploadImports(): Promise<UploadImportsResponse> {
    return this.request<UploadImportsResponse>('POST', `/api/imports`, {
    });
  }

  /**
   * Staged parse result for review
   *
   * Rows with their disposition, the exact duplicates the merge rule will absorb, the near-duplicates needing a three-way choice, unparsed rows, and the balance verdict (spec 6.1). The plan is null until an account is confirmed.
   */
  getImport(id: string): Promise<unknown> {
    return this.request<unknown>('GET', `/api/imports/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Confirm the account, override the profile, or re-parse
   *
   * Refused once the import is committed (spec 6.1).
   */
  updateImport(id: string, body: UpdateImportBody): Promise<unknown> {
    return this.request<unknown>('PATCH', `/api/imports/${encodeURIComponent(String(id))}`, {
      body,
    });
  }

  /**
   * Delete an import
   *
   * Removes only the transactions this import is the last remaining source for. Deleting the first of two overlapping imports keeps the rows the second still contains (spec 3.3).
   */
  deleteImport(id: string): Promise<DeleteImportResponse> {
    return this.request<DeleteImportResponse>('DELETE', `/api/imports/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Commit a staged import
   *
   * Idempotent. Applies the multiset merge rule, then the near-duplicate resolutions, then refund pairing — all inside one transaction, so a partial import never lands (spec 3.3, 2.5).
   */
  commitImport(id: string, body: CommitImportBody): Promise<unknown> {
    return this.request<unknown>('POST', `/api/imports/${encodeURIComponent(String(id))}/commit`, {
      body,
    });
  }

  /** List accounts */
  listAccounts(): Promise<ListAccountsResponse> {
    return this.request<ListAccountsResponse>('GET', `/api/accounts`, {
    });
  }

  /** Create an account */
  createAccount(body: CreateAccountBody): Promise<Account> {
    return this.request<Account>('POST', `/api/accounts`, {
      body,
    });
  }

  /** Get one account */
  getAccount(id: string): Promise<Account> {
    return this.request<Account>('GET', `/api/accounts/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Update an account
   *
   * Archiving is `isActive: false` — see spec 6.2.
   */
  updateAccount(id: string, body: UpdateAccountBody): Promise<Account> {
    return this.request<Account>('PATCH', `/api/accounts/${encodeURIComponent(String(id))}`, {
      body,
    });
  }

  /**
   * Filter, search and paginate transactions
   *
   * Internal transfers are excluded unless asked for — a credit-card payment is not spending (spec 6.3). `hasFinding` comes from `finding_evidence` (spec 2.3).
   */
  listTransactions(query: ListTransactionsQuery = {}): Promise<TransactionPage> {
    return this.request<TransactionPage>('GET', `/api/transactions`, {
      query,
    });
  }

  /**
   * One transaction, with the imports that cover it
   *
   * The covering imports and the verbatim line are spec 6.3’s row expander. `rawText` is the statement line as printed, never trimmed or re-encoded (spec 2.5).
   */
  getTransaction(id: string): Promise<TransactionDetail> {
    return this.request<TransactionDetail>('GET', `/api/transactions/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Assign merchant or category, mark internal transfer, exclude
   *
   * A merchant assignment writes a `user` merchant_alias and enqueues a coalesced re-normalize job (spec 4.3, 2.7).
   */
  updateTransaction(id: string, body: TransactionBulkChange): Promise<Transaction> {
    return this.request<Transaction>('PATCH', `/api/transactions/${encodeURIComponent(String(id))}`, {
      body,
    });
  }

  /**
   * Apply one change to a filter-matched set
   *
   * `?dryRun=true` returns the match count only and writes nothing — this is what backs spec 6.3’s "apply to all 47 matching descriptors". A real apply of a merchant writes one `user` merchant_alias per matched descriptor (spec 4.3) and enqueues a coalesced re-normalize job (spec 2.7).
   */
  bulkUpdateTransactions(body: BulkUpdateTransactionsBody, query: BulkUpdateTransactionsQuery = {}): Promise<TransactionBulkResult> {
    return this.request<TransactionBulkResult>('POST', `/api/transactions/bulk`, {
      query,
      body,
    });
  }

  /**
   * Canonical merchants, by name
   *
   * Includes provisional merchants — spec 4.1 step 7 makes an unresolved descriptor a `source = "rule"` merchant, and `source` is what the UI shows to distinguish one from a seeded merchant (spec 7.5).
   */
  listMerchants(): Promise<ListMerchantsResponse> {
    return this.request<ListMerchantsResponse>('GET', `/api/merchants`, {
    });
  }

  /** Spend categories */
  listCategories(): Promise<ListCategoriesResponse> {
    return this.request<ListCategoriesResponse>('GET', `/api/categories`, {
    });
  }

  /**
   * One job’s state and progress
   *
   * Spec 2.7: the UI polls this rather than blocking on the work.
   */
  getJob(id: string): Promise<Job> {
    return this.request<Job>('GET', `/api/jobs/${encodeURIComponent(String(id))}`, {
    });
  }

  /** Recent jobs, newest first */
  listJobs(query: ListJobsQuery = {}): Promise<ListJobsResponse> {
    return this.request<ListJobsResponse>('GET', `/api/jobs`, {
      query,
    });
  }

  /**
   * Write a consistent copy of the database
   *
   * Uses SQLite’s online backup rather than a file copy: under WAL the `.sqlite` file alone is not the whole database, so copying it while the API is running can miss the most recent commits.
   */
  backupData(): Promise<BackupDataResponse> {
    return this.request<BackupDataResponse>('POST', `/api/data/backup`, {
    });
  }

  /**
   * Export every transaction as JSON or CSV
   *
   * Money is exported twice on purpose: `amountCents` is the value, and `amount` is the rendered form for a human reading the file. Only the first is ever read back.
   */
  exportData(query: ExportDataQuery = {}): Promise<unknown> {
    return this.request<unknown>('POST', `/api/data/export`, {
      query,
    });
  }
  // ------------------------------------------------------------ plumbing ---

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}${path}${buildQuery(options.query ?? {})}`,
      {
        method,
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }
    );

    if (!response.ok) {
      let body: ApiError | null = null;
      try {
        body = (await response.json()) as ApiError;
      } catch {
        body = null;
      }
      throw new LedgerlineApiError(
        response.status,
        body,
        body?.message ?? `${method} ${path} failed with ${response.status}`
      );
    }

    // 204 has no body, and `DELETE` may legitimately return one.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}

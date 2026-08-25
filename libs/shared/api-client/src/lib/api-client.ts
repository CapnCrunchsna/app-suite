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
  StatementImport,
  TransactionDetail,
  Merchant,
  Category,
  Job,
  Finding,
  FindingPage,
  FindingsSummary,
  DismissalRule,
  AccountCoverage,
  AccountMergeResult,
  TransferLink,
  TransferProposeResult,
  TransactionFilter,
  TransactionBulkChange,
  TransactionBulkResult,
  ImportReview,
  UploadResult,
  CommitResult,
  DeleteImportResult,
  Series,
  SeriesPatch,
  FormatProfile,
  FormatProfileDraft,
  FormatProfilePreview,
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

export type ListImportsResponse = StatementImport[];

export type UpdateImportBody = {
  readonly accountId?: string;
  readonly formatProfileId?: string;
  readonly reparse?: boolean;
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

export type ListFormatProfilesResponse = FormatProfile[];

export type CreateFormatProfileBody = {
  readonly importId: string;
  readonly draft: FormatProfileDraft;
};

export type PreviewFormatProfileBody = {
  readonly importId: string;
  readonly draft: FormatProfileDraft;
  readonly limit?: number;
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

export type MergeAccountBody = {
  readonly sourceAccountId: string;
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

export interface ListTransfersQuery {
  readonly states?: string;
  readonly accountIds?: string;
}

export type ListTransfersResponse = TransferLink[];

export type ListMerchantsResponse = Merchant[];

export type ListCategoriesResponse = Category[];

export interface ListJobsQuery {
  readonly limit?: number;
}

export type ListJobsResponse = Job[];

export interface ListFindingsQuery {
  readonly ruleIds?: string;
  readonly bands?: string;
  readonly statuses?: string;
  readonly accountIds?: string;
  readonly impactKind?: 'savings' | 'visibility';
  readonly minAnnualImpactCents?: number;
  readonly visibility?: 'visible' | 'hidden' | 'all';
  readonly limit?: number;
  readonly offset?: number;
}

export interface GetFindingsSummaryQuery {
  readonly ruleIds?: string;
  readonly bands?: string;
  readonly accountIds?: string;
  readonly minAnnualImpactCents?: number;
}

export type SetFindingStateBody = {
  readonly status: 'acknowledged' | 'snoozed' | 'dismissed';
  readonly reason?: string | null;
  /** Snooze length in days. Defaults to 90 (spec 5.1). */
  readonly snoozeDays?: number;
};

export type ListDismissalRulesResponse = DismissalRule[];

export type CreateDismissalRuleBody = {
  readonly scope: 'merchant_rule' | 'rule';
  readonly ruleId: string;
  /** Required for `merchant_rule`, rejected for `rule` */
  readonly merchantId?: string | null;
  readonly reason?: string | null;
};

export type DeleteDismissalRuleResponse = {
  readonly deleted: boolean;
};

export type ListSeriesResponse = Series[];

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
  uploadImports(): Promise<UploadResult> {
    return this.request<UploadResult>('POST', `/api/imports`, {
    });
  }

  /**
   * Staged parse result for review
   *
   * Rows with their disposition, the exact duplicates the merge rule will absorb, the near-duplicates needing a three-way choice, unparsed rows, and the balance verdict (spec 6.1). The plan is null until an account is confirmed.
   */
  getImport(id: string): Promise<ImportReview> {
    return this.request<ImportReview>('GET', `/api/imports/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Confirm the account, override the profile, or re-parse
   *
   * Refused once the import is committed (spec 6.1).
   */
  updateImport(id: string, body: UpdateImportBody): Promise<ImportReview> {
    return this.request<ImportReview>('PATCH', `/api/imports/${encodeURIComponent(String(id))}`, {
      body,
    });
  }

  /**
   * Delete an import
   *
   * Removes only the transactions this import is the last remaining source for. Deleting the first of two overlapping imports keeps the rows the second still contains (spec 3.3).
   */
  deleteImport(id: string): Promise<DeleteImportResult> {
    return this.request<DeleteImportResult>('DELETE', `/api/imports/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Commit a staged import
   *
   * Idempotent. Applies the multiset merge rule, then the near-duplicate resolutions, then refund pairing — all inside one transaction, so a partial import never lands (spec 3.3, 2.5).
   */
  commitImport(id: string, body: CommitImportBody): Promise<CommitResult> {
    return this.request<CommitResult>('POST', `/api/imports/${encodeURIComponent(String(id))}/commit`, {
      body,
    });
  }

  /**
   * Column-mapping profiles, keyed on header signature
   *
   * Both shipped (`source: "seed"`) and mapper-created (`source: "user"`) profiles. The mapper lists them so a near-miss can be copied rather than rebuilt (spec 6.1).
   */
  listFormatProfiles(): Promise<ListFormatProfilesResponse> {
    return this.request<ListFormatProfilesResponse>('GET', `/api/format-profiles`, {
    });
  }

  /**
   * Save a column mapping as a reusable profile
   *
   * Keyed on the header signature read from the import’s own bytes, never from the request. An existing profile for that signature is updated in place with its version bumped — `header_signature` is UNIQUE (spec 3.1), so a second row for one signature is not a thing that can exist. Re-parse the import with `PATCH /api/imports/:id { formatProfileId }`.
   */
  createFormatProfile(body: CreateFormatProfileBody): Promise<FormatProfile> {
    return this.request<FormatProfile>('POST', `/api/format-profiles`, {
      body,
    });
  }

  /**
   * Parse a candidate mapping without saving it
   *
   * Runs the real parser over the import’s stored bytes, so spec 6.1’s live preview shows what the importer would actually produce rather than a second opinion about it. Nothing is written — not the profile, not the rows.
   */
  previewFormatProfile(body: PreviewFormatProfileBody): Promise<FormatProfilePreview> {
    return this.request<FormatProfilePreview>('POST', `/api/format-profiles/preview`, {
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
   * Per-month statement coverage for spec 6.2’s coverage bar
   *
   * A month is covered when a single committed import’s `[period_start, period_end]` spans it (spec 7.2). Derived from statements rather than from transaction dates: an account can be covered for a month in which nothing was spent, and reading that as a missing statement is what turns a quiet month into a lapsed subscription.
   */
  getAccountCoverage(id: string): Promise<AccountCoverage> {
    return this.request<AccountCoverage>('GET', `/api/accounts/${encodeURIComponent(String(id))}/coverage`, {
    });
  }

  /**
   * Merge another account into this one
   *
   * Re-points transactions, imports, series and finding evidence, then archives the source (spec 6.2). **Re-points history; does not deduplicate it.** Spec 3.3’s `dedupe_key` hashes the account id, so the same charge in two accounts has two keys and the merge rule cannot see them as one row — delete the redundant import afterwards, which spec 3.3 already does exactly.
   */
  mergeAccount(id: string, body: MergeAccountBody): Promise<AccountMergeResult> {
    return this.request<AccountMergeResult>('POST', `/api/accounts/${encodeURIComponent(String(id))}/merge`, {
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
   * Spec 6.2’s Possible Transfers queue
   *
   * Defaults to the pairs awaiting a decision. A `proposed` pair is **not** excluded from spend until it is confirmed (spec 2.6), so this list is the difference between the totals on screen and the totals the user would get by agreeing with all of it.
   */
  listTransfers(query: ListTransfersQuery = {}): Promise<ListTransfersResponse> {
    return this.request<ListTransfersResponse>('GET', `/api/transfers`, {
      query,
    });
  }

  /**
   * Re-run spec 2.6’s matcher over everything
   *
   * Replaces every machine-owned link: pairs scoring at or above the auto threshold are linked and leave the spend totals, the rest go to spec 6.2’s queue, and a link this pass no longer produces is withdrawn. Confirmed and rejected links are untouched.
   */
  proposeTransfers(): Promise<TransferProposeResult> {
    return this.request<TransferProposeResult>('POST', `/api/transfers/propose`, {
    });
  }

  /**
   * Confirm a proposed transfer
   *
   * Both sides leave every spend total, and spec 2.6’s learning writes a `transfer_rule` so the same pairing auto-links next month. Reversible: `DELETE /api/transfers/:id` puts it all back. A partial payment (spec 2.6’s second pass) is confirmed as a whole group and teaches no rule.
   */
  confirmTransfer(id: string): Promise<TransferLink> {
    return this.request<TransferLink>('POST', `/api/transfers/${encodeURIComponent(String(id))}/confirm`, {
    });
  }

  /**
   * Reject a transfer link, or undo a confirmed one
   *
   * Sets state `rejected` rather than deleting the row, so the decision survives the next pass — a deleted row is one the matcher re-proposes. Any flags the link set are cleared, which puts the money back into the spend totals. Reversible with `POST /api/transfers/:id/confirm`.
   */
  rejectTransfer(id: string): Promise<TransferLink> {
    return this.request<TransferLink>('DELETE', `/api/transfers/${encodeURIComponent(String(id))}`, {
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
   * Enqueue an analysis run
   *
   * Spec 2.7: enqueues and returns a job id; poll `GET /api/jobs/:id`. Runs of this kind coalesce, so two requests in flight are one run.
   */
  runAnalysis(): Promise<Job> {
    return this.request<Job>('POST', `/api/analysis/run`, {
    });
  }

  /**
   * List findings with spec 6.4’s filters
   *
   * Grouped by rule and sorted by annual impact descending (spec 6.4). Dismissed and snoozed findings are hidden by default and return the moment their evidence hash or the config hash moves (spec 5.1).
   */
  listFindings(query: ListFindingsQuery = {}): Promise<FindingPage> {
    return this.request<FindingPage>('GET', `/api/findings`, {
      query,
    });
  }

  /**
   * Spec 6.4’s three headline numbers
   *
   * Active subscriptions and their monthly/annual total, total flagged annual savings (`impact_kind = savings` only — spec 5.1 and 7.3), and the unreviewed count. Takes the same filters as the list so the headline and the cards describe one set.
   */
  getFindingsSummary(query: GetFindingsSummaryQuery = {}): Promise<FindingsSummary> {
    return this.request<FindingsSummary>('GET', `/api/findings/summary`, {
      query,
    });
  }

  /**
   * Acknowledge, snooze or dismiss one finding
   *
   * Spec 5.1’s per-finding scope. A dismissal stores the finding’s evidence hash and the config hash in force, which is what makes it stick — and what makes it lift when the price changes or a lapsed series resumes.
   */
  setFindingState(id: string, body: SetFindingStateBody): Promise<Finding> {
    return this.request<Finding>('POST', `/api/findings/${encodeURIComponent(String(id))}/state`, {
      body,
    });
  }

  /**
   * Standing merchant-scoped and rule-scoped dismissals
   *
   * Spec 5.1’s second and third dismissal scopes, applied at emit time.
   */
  listDismissalRules(): Promise<ListDismissalRulesResponse> {
    return this.request<ListDismissalRulesResponse>('GET', `/api/dismissal-rules`, {
    });
  }

  /**
   * Dismiss a rule, or a rule for one merchant
   *
   * Applied at emit time (spec 3.1), so findings it covers become `suppressed` on the next run rather than being deleted. Idempotent on (scope, ruleId, merchantId).
   */
  createDismissalRule(body: CreateDismissalRuleBody): Promise<DismissalRule> {
    return this.request<DismissalRule>('POST', `/api/dismissal-rules`, {
      body,
    });
  }

  /**
   * Lift a standing dismissal
   *
   * The findings it suppressed return to `active` on the next run — their rows were never deleted, so `first_detected_at` and any per-finding state survive (spec 5.1).
   */
  deleteDismissalRule(id: string): Promise<DeleteDismissalRuleResponse> {
    return this.request<DeleteDismissalRuleResponse>('DELETE', `/api/dismissal-rules/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * The recurring ledger behind spec 6.5’s Subscriptions page
   *
   * Every series spec 5.2 fitted, with its charge history and price steps as the run that produced it recorded them. Sorted by annual cost, descending — spec 6.5 calls that "the view that produces the *I pay what for that?* reaction", so it is the order the list arrives in rather than one the page has to ask for.
   */
  listSeries(): Promise<ListSeriesResponse> {
    return this.request<ListSeriesResponse>('GET', `/api/series`, {
    });
  }

  /**
   * One series, with its full charge history
   *
   * The same shape the list returns. Spec 6.5’s detail drawer needs the charge history and the price-step table, and both travel on every series rather than behind a second request, because the drawer opens from a row the page already holds.
   */
  getSeries(id: string): Promise<Series> {
    return this.request<Series>('GET', `/api/series/${encodeURIComponent(String(id))}`, {
    });
  }

  /**
   * Spec 6.5’s three user-owned fields
   *
   * The cancellation URL, the notes, and the manual status override — which always beats the computed one (spec 6.5). Omitting a field leaves it alone; sending `userStatus: null` clears the override and hands the series back to spec 5.2. Nothing here is recomputed by an analysis run: `replaceSeries` writes the other half of the row and never these three.
   */
  updateSeries(id: string, body: SeriesPatch): Promise<Series> {
    return this.request<Series>('PATCH', `/api/series/${encodeURIComponent(String(id))}`, {
      body,
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

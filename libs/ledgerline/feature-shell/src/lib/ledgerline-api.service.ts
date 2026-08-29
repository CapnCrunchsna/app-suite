/**
 * The one seam between this lib and the API.
 *
 * §2.2 gives `type:feature` `['type:domain', 'type:ui', 'type:api-client']` and
 * the hard rule "No direct `data`/`analyzers` imports — everything through HTTP."
 * `@metrum/api-client` is framework-free by its own constraint
 * (`onlyDependOnLibsWithTags: []`), so somebody has to make it injectable, and
 * this is the only file in the lib that knows the transport exists.
 *
 * Thin on purpose: it adds a base URL, DI, and nothing else. Every method below is
 * a pass-through to a generated one. The moment this file starts reshaping
 * responses it becomes a second, undocumented API surface that drifts from
 * `openapi.json` — the exact failure the generation step exists to prevent.
 */

import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  API_BASE_PATH,
  DEFAULT_BASE_URL,
  LedgerlineApi,
  LedgerlineApiError,
} from '@metrum/api-client';
import type {
  Account,
  AccountCoverage,
  AccountMergeResult,
  ApiError,
  BulkUpdateTransactionsBody,
  Category,
  CommitImportBody,
  CommitResult,
  CreateDismissalRuleBody,
  CreateFormatProfileBody,
  DegradedCallLog,
  DeleteImportResult,
  DismissalRule,
  Finding,
  FindingPage,
  FindingsSummary,
  FormatProfile,
  FormatProfilePreview,
  GetFindingsSummaryQuery,
  GetHealthResponse,
  ImportReview,
  Job,
  ListFindingsQuery,
  ListTransactionsQuery,
  ListTransfersQuery,
  LlmHealth,
  Merchant,
  MergeAccountBody,
  MerchantMergeResult,
  MerchantReviewQueue,
  MergeMerchantBody,
  PreviewFormatProfileBody,
  ProposeMerchantsResponse,
  RenormalizeAllResponse,
  Series,
  SeriesPatch,
  Settings,
  SettingsUpdate,
  SetFindingStateBody,
  StatementImport,
  Transaction,
  TransactionBulkChange,
  TransactionBulkResult,
  TransactionDetail,
  TransactionFilter,
  TransactionPage,
  TransferLink,
  TransferProposeResult,
  UpdateAccountBody,
  UpdateImportBody,
  UpdateSettingsBody,
  UploadResult,
  WipeDataBody,
  WipeResult,
} from '@metrum/api-client';

/**
 * Where the API lives.
 *
 * A token rather than a constant because the API's port is configurable
 * (`LEDGERLINE_PORT`) while its host is deliberately not — `apps/CLAUDE.md` and
 * §2.1 both fix it at `127.0.0.1`, and the reason it is not a setting is that the
 * only way to get it wrong is to make it one. Overriding this to a non-loopback
 * host would be pointing the UI at someone else's statements, so don't.
 */
export const LEDGERLINE_API_BASE_URL = new InjectionToken<string>('LEDGERLINE_API_BASE_URL');

@Injectable({ providedIn: 'root' })
export class LedgerlineApiService {
  /** Kept, not just handed to the client, because one route below cannot go
   *  through the client at all — see `uploadImports`. */
  private readonly baseUrl = (
    inject(LEDGERLINE_API_BASE_URL, { optional: true }) ?? DEFAULT_BASE_URL
  ).replace(/\/$/, '');

  private readonly api = new LedgerlineApi({ baseUrl: this.baseUrl });

  listTransactions(query: ListTransactionsQuery): Promise<TransactionPage> {
    return this.api.listTransactions(query);
  }

  /** §6.3's row expander — the verbatim line and the covering imports. */
  getTransaction(id: string): Promise<TransactionDetail> {
    return this.api.getTransaction(id);
  }

  updateTransaction(id: string, change: TransactionBulkChange): Promise<Transaction> {
    return this.api.updateTransaction(id, change);
  }

  /**
   * §6.3's "apply to all 47 matching descriptors", both halves.
   *
   * The count and the apply take the *same* filter object, which is the whole
   * reason this takes one argument and derives both calls from it. A UI that built
   * the two filters separately could show a count for one set and change another.
   */
  countMatching(filter: TransactionFilter): Promise<TransactionBulkResult> {
    return this.api.bulkUpdateTransactions({ filter } as BulkUpdateTransactionsBody, {
      dryRun: true,
    });
  }

  applyBulk(
    filter: TransactionFilter,
    change: TransactionBulkChange,
  ): Promise<TransactionBulkResult> {
    return this.api.bulkUpdateTransactions({
      filter,
      change,
    } as BulkUpdateTransactionsBody);
  }

  listAccounts(): Promise<Account[]> {
    return this.api.listAccounts();
  }

  // ------------------------------------------------------------- §6.2 ---

  updateAccount(id: string, body: UpdateAccountBody): Promise<Account> {
    return this.api.updateAccount(id, body);
  }

  /** §6.2's coverage bar. Statement periods, never transaction dates (§7.2). */
  getAccountCoverage(id: string): Promise<AccountCoverage> {
    return this.api.getAccountCoverage(id);
  }

  mergeAccount(id: string, body: MergeAccountBody): Promise<AccountMergeResult> {
    return this.api.mergeAccount(id, body);
  }

  /** §6.2's Possible Transfers queue (§2.6). */
  listTransfers(query: ListTransfersQuery = {}): Promise<TransferLink[]> {
    return this.api.listTransfers(query);
  }

  /** Re-runs §2.6's matcher over everything and returns what moved. */
  proposeTransfers(): Promise<TransferProposeResult> {
    return this.api.proposeTransfers();
  }

  confirmTransfer(id: string): Promise<TransferLink> {
    return this.api.confirmTransfer(id);
  }

  /** Rejects a proposal, or undoes a confirmed link. Reversible by `confirm`. */
  rejectTransfer(id: string): Promise<TransferLink> {
    return this.api.rejectTransfer(id);
  }

  listMerchants(): Promise<Merchant[]> {
    return this.api.listMerchants();
  }

  listCategories(): Promise<Category[]> {
    return this.api.listCategories();
  }

  /** §4.1 step 7: what the chain could not settle on its own. A read — it
   *  proposes, and nothing here has been applied. */
  getMerchantReviewQueue(): Promise<MerchantReviewQueue> {
    return this.api.getMerchantReviewQueue();
  }

  /** §4.3, aimed at a merchant: writes a `user` alias for every spelling and
   *  sweeps the history. Permanent and top-precedence. */
  mergeMerchant(id: string, body: MergeMerchantBody): Promise<MerchantMergeResult> {
    return this.api.mergeMerchant(id, body);
  }

  /** §2.7: the UI polls a job rather than blocking on it. */
  getJob(id: string): Promise<Job> {
    return this.api.getJob(id);
  }

  // ------------------------------------------------------------- §6.1 ---

  /**
   * `POST /api/imports` — the one method here that is not a pass-through, and
   * the only place in this lib that calls `fetch` itself.
   *
   * The route consumes `multipart/form-data`, which OpenAPI's `consumes` records
   * but does not *describe*: there is no schema for the parts, so the generator
   * has nothing to emit a body parameter from and `uploadImports()` on the
   * generated client takes none. Rather than hand-edit generated code (which the
   * next `npx nx generate-client api-client` would overwrite) or invent a JSON
   * shape the route does not accept, the `FormData` goes out directly — and it
   * throws the client's own `LedgerlineApiError` so a caller branches on
   * `error.code` here exactly as it does everywhere else.
   *
   * No `content-type` header on purpose: the browser has to set it, because only
   * the browser knows the multipart boundary it generated.
   */
  async uploadImports(files: readonly File[]): Promise<UploadResult> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);

    const path = `${API_BASE_PATH}/imports`;
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST', body: form });

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
        body?.message ?? `POST ${path} failed with ${response.status}`,
      );
    }

    return (await response.json()) as UploadResult;
  }

  /** §6.1's import history. */
  listImports(): Promise<StatementImport[]> {
    return this.api.listImports();
  }

  /** The staged parse result §2.5 requires a reviewer to see before commit. */
  getImport(id: string): Promise<ImportReview> {
    return this.api.getImport(id);
  }

  /** Confirm the guessed account, apply a saved profile, or re-parse. */
  updateImport(id: string, body: UpdateImportBody): Promise<ImportReview> {
    return this.api.updateImport(id, body);
  }

  /** The one call that lands rows in `transaction`. */
  commitImport(id: string, body: CommitImportBody): Promise<CommitResult> {
    return this.api.commitImport(id, body);
  }

  /** Removes only the rows this import is the last remaining source for (§3.3). */
  deleteImport(id: string): Promise<DeleteImportResult> {
    return this.api.deleteImport(id);
  }

  /** Named profiles, for the detected badge and for copying a near miss. */
  listFormatProfiles(): Promise<FormatProfile[]> {
    return this.api.listFormatProfiles();
  }

  /** The mapper's live preview — the real parser over the real bytes. */
  previewFormatProfile(body: PreviewFormatProfileBody): Promise<FormatProfilePreview> {
    return this.api.previewFormatProfile(body);
  }

  /** Saves the mapping. Deliberately does not re-parse — that is `updateImport`. */
  createFormatProfile(body: CreateFormatProfileBody): Promise<FormatProfile> {
    return this.api.createFormatProfile(body);
  }

  // ------------------------------------------------------------- §6.4 ---

  /** §2.7: enqueues and returns a job; the UI polls `getJob` rather than
   *  blocking on a run that reads every transaction in the database. */
  runAnalysis(): Promise<Job> {
    return this.api.runAnalysis();
  }

  listFindings(query: ListFindingsQuery): Promise<FindingPage> {
    return this.api.listFindings(query);
  }

  /**
   * §6.4's three headline numbers.
   *
   * Taken from the API rather than summed from the page's own rows, and not
   * only to save arithmetic: §5.1 admits **`savings` alone** into the headline,
   * the rows the page holds are one filtered page of many, and a total computed
   * from them would be wrong by every finding the user has filtered out or not
   * scrolled to.
   */
  getFindingsSummary(query: GetFindingsSummaryQuery): Promise<FindingsSummary> {
    return this.api.getFindingsSummary(query);
  }

  /** §5.1's per-finding user state — acknowledge, snooze, or dismiss *this one*. */
  setFindingState(id: string, body: SetFindingStateBody): Promise<Finding> {
    return this.api.setFindingState(id, body);
  }

  /**
   * §5.1's other two dismissal scopes, which are a different table and a
   * different lifecycle (§3.1): a standing filter applied at emit time rather
   * than user state on one finding.
   */
  listDismissalRules(): Promise<DismissalRule[]> {
    return this.api.listDismissalRules();
  }

  createDismissalRule(body: CreateDismissalRuleBody): Promise<DismissalRule> {
    return this.api.createDismissalRule(body);
  }

  deleteDismissalRule(id: string): Promise<{ readonly deleted?: boolean }> {
    return this.api.deleteDismissalRule(id);
  }

  // ------------------------------------------------------------- §6.5 ---

  /**
   * §6.5's recurring ledger, already sorted by annual cost.
   *
   * The sort is the API's rather than the page's because §6.5 names it as the
   * default view — "sortable by annual cost, which is the view that produces the
   * 'I pay *what* for that?' reaction" — and because `annualCents` is computed
   * server-side from the stored `cadences_per_year` (§5.2), so re-sorting here
   * would mean re-deriving it here too.
   */
  listSeries(): Promise<Series[]> {
    return this.api.listSeries();
  }

  getSeries(id: string): Promise<Series> {
    return this.api.getSeries(id);
  }

  /** §6.5's three user-owned fields. A manual status always beats the computed
   *  one, and an omitted field is left alone rather than cleared. */
  updateSeries(id: string, body: SeriesPatch): Promise<Series> {
    return this.api.updateSeries(id, body);
  }

  // ------------------------------------------------------------- §6.8 ---

  /** §7.4's config: every tunable threshold with its shipped default, every §5
   *  rule with its switch, and the `config_hash` the findings on screen were
   *  computed under. */
  getSettings(): Promise<Settings> {
    return this.api.getSettings();
  }

  /** One write for thresholds, rule switches and the LLM provider alike — a rule's
   *  `enabled` is a field in its own config section, and the provider travels
   *  beside them but lands in its own settings key (§2.4, §7.4). A `null` value
   *  restores the default. */
  updateSettings(body: UpdateSettingsBody): Promise<SettingsUpdate> {
    return this.api.updateSettings(body);
  }

  /** §6.8's Test Connection. Probes the configured provider *now* — never a
   *  remembered answer, which is the one thing this button must not give. */
  getLlmHealth(): Promise<LlmHealth> {
    return this.api.getLlmHealth();
  }

  /** §6.8's degraded-LLM-call log, in the Data section. */
  listDegradedCalls(limit?: number): Promise<DegradedCallLog> {
    return this.api.listDegradedCalls(limit === undefined ? {} : { limit });
  }

  /** §4.2's stage. Returns §2.7's job id; the page polls it like every other. */
  proposeMerchants(): Promise<ProposeMerchantsResponse> {
    return this.api.proposeMerchants();
  }

  /** §2.7's full sweep, §6.8's trigger. Returns a job id and the row count it will
   *  walk, so the page can say what it started without counting anything itself. */
  renormalizeAll(): Promise<RenormalizeAllResponse> {
    return this.api.renormalizeAll();
  }

  /** Liveness, and the transaction count §6.8's re-normalize trigger shows before
   *  anyone presses it. */
  getHealth(): Promise<GetHealthResponse> {
    return this.api.getHealth();
  }

  /** §2.3's backup: a consistent copy, returning the path it wrote. */
  backupData(): Promise<{ readonly path: string; readonly createdAt: string }> {
    return this.api.backupData() as Promise<{ path: string; createdAt: string }>;
  }

  /** §2.3's wipe. Irreversible, so the API takes its own backup first and returns
   *  the path — see `routes/data.ts`. */
  wipeData(body: WipeDataBody): Promise<WipeResult> {
    return this.api.wipeData(body);
  }

  /**
   * §2.3's export, and the second route that cannot go through the generated
   * client.
   *
   * `request()` calls `JSON.parse` on every response body, and a CSV export is not
   * JSON — it would throw on the format most people want. Same escape hatch
   * `uploadImports` uses above and for the same kind of reason: the generated
   * client describes JSON, and this route does not always answer with it. Returns a
   * `Blob` so the caller can hand it to the browser as a download rather than
   * holding a megabyte of statement text in a signal.
   */
  async exportData(format: 'json' | 'csv'): Promise<Blob> {
    const path = `${API_BASE_PATH}/data/export?format=${format}`;
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST' });

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
        body?.message ?? `POST ${path} failed with ${response.status}`,
      );
    }

    return response.blob();
  }
}



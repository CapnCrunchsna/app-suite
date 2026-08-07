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
import { LedgerlineApi } from '@metrum/api-client';
import type {
  Account,
  BulkUpdateTransactionsBody,
  Category,
  Job,
  ListTransactionsQuery,
  Merchant,
  Transaction,
  TransactionBulkChange,
  TransactionBulkResult,
  TransactionDetail,
  TransactionFilter,
  TransactionPage,
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
  private readonly api = new LedgerlineApi({
    baseUrl: inject(LEDGERLINE_API_BASE_URL, { optional: true }) ?? undefined,
  });

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

  listMerchants(): Promise<Merchant[]> {
    return this.api.listMerchants();
  }

  listCategories(): Promise<Category[]> {
    return this.api.listCategories();
  }

  /** §2.7: the UI polls a job rather than blocking on it. */
  getJob(id: string): Promise<Job> {
    return this.api.getJob(id);
  }
}

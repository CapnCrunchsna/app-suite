/**
 * §6.3's row expander: "the verbatim statement line and the imports that cover
 * it."
 *
 * Presentational — the page fetches `GET /api/transactions/:id` and passes the
 * result in. Two things here are deliberate rather than decorative:
 *
 * **The verbatim line is rendered in a `<pre>`, unmodified.** §2.5 keeps
 * `raw_row.raw_text` "never normalized, trimmed or re-encoded", and this is the one
 * screen that exists to show it. Collapsing its whitespace here would undo the
 * only property that makes it useful when a parse looks wrong.
 *
 * **A row covered by two statements shows both lines.** §3.1's
 * `transaction_source.raw_row_id` is justified on exactly this — "the same
 * transaction is a different printed line in each statement that carries it" — so
 * the panel lists one line per covering import rather than one line and a count.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Account, Category, Merchant, TransactionDetail as Detail } from '@metrum/api-client';

@Component({
  selector: 'll-transaction-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let d = detail();
    @if (d) {
      <div class="detail">
        <div class="detail__block">
          <h4 class="detail__heading">Verbatim statement line</h4>
          @if (d.rawText) {
            <pre class="detail__raw">{{ d.rawText }}</pre>
          } @else {
            <p class="detail__empty">
              No raw line is attached to this row. Its source import was deleted and the row
              survived on another statement's coverage.
            </p>
          }
        </div>

        <div class="detail__block">
          <h4 class="detail__heading">
            Covering imports
            <span class="detail__count">{{ d.coveringImports.length }}</span>
          </h4>
          @if (d.coveringImports.length === 0) {
            <p class="detail__empty">Nothing covers this row.</p>
          } @else {
            <ul class="detail__imports">
              @for (statement of d.coveringImports; track statement.id) {
                <li class="detail__import">
                  <span class="detail__filename">{{ statement.sourceFilename }}</span>
                  <span class="detail__account">{{ accountName(statement.accountId) }}</span>
                  <span class="detail__period">
                    @if (statement.periodStart && statement.periodEnd) {
                      {{ statement.periodStart }} → {{ statement.periodEnd }}
                    } @else {
                      period unknown
                    }
                  </span>
                  @let line = lineFor(statement.id);
                  @if (line && line !== d.rawText) {
                    <pre class="detail__raw detail__raw--secondary">{{ line }}</pre>
                  }
                </li>
              }
            </ul>
          }
        </div>

        <div class="detail__block">
          <h4 class="detail__heading">Row</h4>
          <dl class="detail__facts">
            <dt>Effective date</dt>
            <dd>{{ d.transaction.effectiveDate }}</dd>

            <dt
              title="Display and statement reconciliation only — it never orders or groups anything."
            >
              Posted date
            </dt>
            <dd>{{ d.transaction.postedDate ?? '—' }}</dd>

            <dt>Amount</dt>
            <dd [class.detail__credit]="d.transaction.amountCents > 0">
              {{ formatCents(d.transaction.amountCents) }}
              <span class="detail__cents">({{ d.transaction.amountCents }} cents)</span>
            </dd>

            <dt>Normalized</dt>
            <dd>
              <code>{{ d.transaction.descriptionNormalized }}</code>
            </dd>

            <dt>Merchant</dt>
            <dd>{{ merchantName() }}</dd>

            <dt>Category</dt>
            <dd>
              {{ categoryName() }}
              @if (d.transaction.categorySource) {
                <span class="detail__source">{{ d.transaction.categorySource }}</span>
              }
            </dd>

            @if (d.transaction.balanceCents !== null) {
              <dt>Statement balance</dt>
              <dd>{{ formatCents(d.transaction.balanceCents) }}</dd>
            }

            <dt
              title="The frozen row-identity key. Shown as provenance; nothing on this page recomputes it."
            >
              Dedupe key
            </dt>
            <dd>
              <code class="detail__key">{{ d.transaction.dedupeKey.slice(0, 16) }}…</code>
              <span class="detail__source">{{ d.transaction.dedupeKeyVersion }}</span>
              @if (d.transaction.occurrenceIndex > 0) {
                <span class="detail__source">occurrence {{ d.transaction.occurrenceIndex }}</span>
              }
            </dd>
          </dl>
        </div>
      </div>
    } @else {
      <div class="detail detail--loading">Loading the statement line…</div>
    }
  `,
  styleUrl: './transaction-detail.scss',
})
export class TransactionDetailPanel {
  readonly detail = input<Detail | null>(null);
  readonly accounts = input<ReadonlyMap<string, Account>>(new Map());
  readonly merchants = input<ReadonlyMap<string, Merchant>>(new Map());
  readonly categories = input<ReadonlyMap<string, Category>>(new Map());

  /** Money is formatted for display only, never parsed back (§7.3). */
  protected readonly formatCents = formatCents;

  protected readonly merchantName = computed(() => {
    const id = this.detail()?.transaction.merchantId;
    if (!id) return 'unresolved';
    const merchant = this.merchants().get(id);
    if (!merchant) return id;
    // §4.1 step 7's provisional merchants are the ones worth correcting, so the
    // panel says which kind this is rather than showing a name and hoping.
    return merchant.source === 'rule'
      ? `${merchant.displayName} (provisional)`
      : merchant.displayName;
  });

  protected readonly categoryName = computed(() => {
    const id = this.detail()?.transaction.categoryId;
    if (!id) return 'uncategorized';
    return this.categories().get(id)?.name ?? id;
  });

  /**
   * Which account a covering statement was filed into.
   *
   * The filename alone does not identify an import: two cards at the same bank
   * export the same name, and the period does not separate them either when both
   * statements cover the same month. §6.1's history has carried the account
   * beside the filename since it was built; this list is the other place an
   * import is named, and it did not.
   */
  protected accountName(accountId: string | null): string {
    if (!accountId) return 'no account';
    return this.accounts().get(accountId)?.displayName ?? accountId;
  }

  protected lineFor(importId: string): string | null {
    return this.detail()?.sources.find((source) => source.importId === importId)?.rawText ?? null;
  }
}

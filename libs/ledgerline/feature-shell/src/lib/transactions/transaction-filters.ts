/**
 * §6.3's filter bar: "account, date range, amount range, merchant, category,
 * has-finding, pending, and an internal-transfer toggle (off by default)."
 *
 * Presentational. It holds no query, makes no request, and emits a whole new
 * filter object rather than twelve separate events — the page owns the state, so
 * there is exactly one place where a filter change turns into a fetch.
 *
 * Amounts are the only input here that needs care. The user types dollars and the
 * filter carries cents, and the conversion goes through `parseMoneyToCents` from
 * `@metrum/ledgerline-domain` rather than `Number(value) * 100`: that function
 * reads the integer and fraction parts as strings and refuses anything
 * ambiguous, which is the workspace's one sanctioned way to turn typed money into
 * an integer (§3.1, §7.3). `12.30` must be 1230 and not 1229.9999999999998.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { parseMoneyToCents } from '@metrum/ledgerline-domain';
import type { Account, Category, Merchant } from '@metrum/api-client';

/** A tri-state filter: unset, or an explicit yes/no. */
export type Tristate = '' | 'yes' | 'no';

/**
 * Everything the user can narrow the table by.
 *
 * Amounts are held as the **typed text**, not as cents, because a half-typed
 * `-1` is not yet a number and clearing the box is not the same as filtering on
 * zero. The conversion to cents happens once, on the way out, in
 * `amountCents` below.
 */
export interface TransactionFilterState {
  readonly accountIds: readonly string[];
  readonly merchantIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly minAmountText: string;
  readonly maxAmountText: string;
  readonly hasFinding: Tristate;
  readonly pending: Tristate;
  /** §6.3: **off by default.** A credit-card payment is not spending. */
  readonly includeInternalTransfers: boolean;
  readonly includeExcluded: boolean;
  readonly q: string;
}

export const EMPTY_FILTER: TransactionFilterState = {
  accountIds: [],
  merchantIds: [],
  categoryIds: [],
  from: '',
  to: '',
  minAmountText: '',
  maxAmountText: '',
  hasFinding: '',
  pending: '',
  includeInternalTransfers: false,
  includeExcluded: false,
  q: '',
};

/** Typed dollars to integer cents, or `undefined` when the box is empty or the
 *  text is not an unambiguous amount. */
export function amountCents(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const parsed = parseMoneyToCents(text);
  return parsed.ok ? parsed.cents : undefined;
}

/** True when text was typed but could not be read as money — the input shows a
 *  warning rather than silently filtering on nothing. */
export function isUnreadableAmount(text: string): boolean {
  return text.trim() !== '' && amountCents(text) === undefined;
}

@Component({
  selector: 'll-transaction-filters',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="filters">
      <label class="filters__field filters__field--wide">
        <span class="filters__label">Search</span>
        <input
          type="search"
          class="filters__input"
          placeholder="raw or normalized descriptor"
          [ngModel]="filter().q"
          (ngModelChange)="patch({ q: $event })"
        />
      </label>

      <label class="filters__field">
        <span class="filters__label">Account</span>
        <select
          class="filters__input"
          [ngModel]="single(filter().accountIds)"
          (ngModelChange)="patch({ accountIds: $event ? [$event] : [] })"
        >
          <option value="">All accounts</option>
          @for (account of accounts(); track account.id) {
            <option [value]="account.id">{{ account.displayName }}</option>
          }
        </select>
      </label>

      <label class="filters__field">
        <span class="filters__label">Merchant</span>
        <select
          class="filters__input"
          [ngModel]="single(filter().merchantIds)"
          (ngModelChange)="patch({ merchantIds: $event ? [$event] : [] })"
        >
          <option value="">All merchants</option>
          @for (merchant of merchants(); track merchant.id) {
            <option [value]="merchant.id">
              {{ merchant.displayName }}{{ merchant.source === 'rule' ? ' ·' : '' }}
            </option>
          }
        </select>
      </label>

      <label class="filters__field">
        <span class="filters__label">Category</span>
        <select
          class="filters__input"
          [ngModel]="single(filter().categoryIds)"
          (ngModelChange)="patch({ categoryIds: $event ? [$event] : [] })"
        >
          <option value="">All categories</option>
          @for (category of categories(); track category.id) {
            <option [value]="category.id">{{ category.name }}</option>
          }
        </select>
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">From</span>
        <input
          type="date"
          class="filters__input"
          [ngModel]="filter().from"
          (ngModelChange)="patch({ from: $event })"
        />
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">To</span>
        <input
          type="date"
          class="filters__input"
          [ngModel]="filter().to"
          (ngModelChange)="patch({ to: $event })"
        />
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">Min $</span>
        <input
          type="text"
          inputmode="decimal"
          class="filters__input"
          [class.filters__input--invalid]="minInvalid()"
          [attr.aria-invalid]="minInvalid() ? 'true' : null"
          placeholder="-100.00"
          [ngModel]="filter().minAmountText"
          (ngModelChange)="patch({ minAmountText: $event })"
        />
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">Max $</span>
        <input
          type="text"
          inputmode="decimal"
          class="filters__input"
          [class.filters__input--invalid]="maxInvalid()"
          [attr.aria-invalid]="maxInvalid() ? 'true' : null"
          placeholder="0.00"
          [ngModel]="filter().maxAmountText"
          (ngModelChange)="patch({ maxAmountText: $event })"
        />
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">Finding</span>
        <select
          class="filters__input"
          [ngModel]="filter().hasFinding"
          (ngModelChange)="patch({ hasFinding: $event })"
        >
          <option value="">Any</option>
          <option value="yes">Flagged</option>
          <option value="no">Not flagged</option>
        </select>
      </label>

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">Pending</span>
        <select
          class="filters__input"
          [ngModel]="filter().pending"
          (ngModelChange)="patch({ pending: $event })"
        >
          <option value="">Any</option>
          <option value="yes">Pending only</option>
          <option value="no">Posted only</option>
        </select>
      </label>

      <div class="filters__toggles">
        <label class="filters__toggle" [title]="TRANSFER_HINT">
          <input
            type="checkbox"
            [ngModel]="filter().includeInternalTransfers"
            (ngModelChange)="patch({ includeInternalTransfers: $event })"
          />
          <span>Internal transfers</span>
        </label>

        <label
          class="filters__toggle"
          title="Rows marked as excluded from analysis are hidden by default."
        >
          <input
            type="checkbox"
            [ngModel]="filter().includeExcluded"
            (ngModelChange)="patch({ includeExcluded: $event })"
          />
          <span>Excluded rows</span>
        </label>

        <button type="button" class="filters__reset" (click)="reset()" [disabled]="isEmpty()">
          Clear filters
        </button>
      </div>

      @if (minInvalid() || maxInvalid()) {
        <p class="filters__warning" role="status">
          An amount has to be an unambiguous USD figure — <code>-18.75</code>,
          <code>1,234.56</code>, <code>(45.00)</code>. That box is being ignored until it is.
        </p>
      }
    </div>
  `,
  styleUrl: './transaction-filters.scss',
})
export class TransactionFilters {
  readonly accounts = input<readonly Account[]>([]);
  readonly merchants = input<readonly Merchant[]>([]);
  readonly categories = input<readonly Category[]>([]);
  readonly filter = input.required<TransactionFilterState>();

  readonly filterChange = output<TransactionFilterState>();

  /** Spelled out in the toggle's tooltip because the default is a claim about
   *  money, not a display preference (§2.6, §6.3). */
  protected readonly TRANSFER_HINT =
    'Off by default: a credit-card payment is money moving between your own accounts, ' +
    'not spending. Showing it here would double-count on screen what transfer linking ' +
    'exists to keep out of the totals.';

  protected readonly minInvalid = computed(() => isUnreadableAmount(this.filter().minAmountText));
  protected readonly maxInvalid = computed(() => isUnreadableAmount(this.filter().maxAmountText));

  protected readonly isEmpty = computed(() => {
    const filter = this.filter();
    return JSON.stringify({ ...filter }) === JSON.stringify({ ...EMPTY_FILTER });
  });

  /** The selects are single-choice for now; the filter carries arrays because the
   *  API does, and multi-select is a control change rather than a contract one. */
  protected single(ids: readonly string[]): string {
    return ids[0] ?? '';
  }

  protected patch(change: Partial<TransactionFilterState>): void {
    this.filterChange.emit({ ...this.filter(), ...change });
  }

  protected reset(): void {
    this.filterChange.emit(EMPTY_FILTER);
  }
}

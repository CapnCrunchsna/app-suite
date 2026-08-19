/**
 * §6.4's filter bar: "Filters for band, rule, account, and minimum annual
 * impact."
 *
 * Presentational, and the same shape as §6.3's filter bar: it holds no query,
 * makes no request, and emits a whole new filter object rather than four
 * separate events, so the page has exactly one place where a filter change turns
 * into a fetch.
 *
 * All four are **server-side** — `ListFindingsQuery` takes every one of them.
 * Filtering client-side would filter one page of rows and leave the headline
 * numbers, which are computed over the whole set, describing something else.
 *
 * The minimum-impact box is the only input where a human types money, and it
 * goes through `parseMoneyToCents` for the reason §7.3 gives: `12.30` must be
 * 1230 and not 1229.9999999999998.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { parseMoneyToCents } from '@metrum/ledgerline-domain';
import type { Account } from '@metrum/api-client';

export interface FindingFilterState {
  readonly bands: readonly string[];
  readonly ruleIds: readonly string[];
  readonly accountIds: readonly string[];
  /** The typed text, not cents — a half-typed "1" is not yet a number and
   *  clearing the box is not the same as filtering on zero. */
  readonly minAnnualText: string;
  /** §5.1's lifecycle: dismissed and snoozed findings are hidden by default,
   *  which is what makes dismissing them worth doing. */
  readonly visibility: 'visible' | 'hidden' | 'all';
}

export const EMPTY_FINDING_FILTER: FindingFilterState = {
  bands: [],
  ruleIds: [],
  accountIds: [],
  minAnnualText: '',
  visibility: 'visible',
};

/** Typed dollars to integer cents, or `undefined` when the box is empty or the
 *  text is not an unambiguous amount. */
export function minAnnualCents(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const parsed = parseMoneyToCents(text);
  return parsed.ok ? parsed.cents : undefined;
}

const BANDS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

@Component({
  selector: 'll-finding-filters',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="filters">
      <fieldset class="filters__bands">
        <legend class="filters__label">Confidence</legend>
        @for (band of BANDS; track band.value) {
          <label class="filters__toggle">
            <input
              type="checkbox"
              [checked]="filter().bands.includes(band.value)"
              (change)="toggleBand(band.value, $any($event.target).checked)"
            />
            <span>{{ band.label }}</span>
          </label>
        }
      </fieldset>

      <label class="filters__field">
        <span class="filters__label">Rule</span>
        <select
          class="filters__input"
          [ngModel]="single(filter().ruleIds)"
          (ngModelChange)="patch({ ruleIds: $event ? [$event] : [] })"
        >
          <option value="">All rules</option>
          @for (rule of rules(); track rule) {
            <option [value]="rule">{{ rule }}</option>
          }
        </select>
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

      <label class="filters__field filters__field--narrow">
        <span class="filters__label">Min $/yr</span>
        <input
          type="text"
          inputmode="decimal"
          class="filters__input"
          [class.filters__input--invalid]="minInvalid()"
          [attr.aria-invalid]="minInvalid() ? 'true' : null"
          placeholder="100.00"
          [ngModel]="filter().minAnnualText"
          (ngModelChange)="patch({ minAnnualText: $event })"
        />
      </label>

      <label class="filters__field">
        <span class="filters__label">Show</span>
        <select
          class="filters__input"
          [ngModel]="filter().visibility"
          (ngModelChange)="patch({ visibility: $event })"
        >
          <option value="visible">Open findings</option>
          <option value="hidden">Dismissed &amp; snoozed</option>
          <option value="all">Everything</option>
        </select>
      </label>

      <button type="button" class="filters__reset" (click)="reset()" [disabled]="isEmpty()">
        Clear filters
      </button>

      @if (minInvalid()) {
        <p class="filters__warning" role="status">
          A minimum has to be an unambiguous USD figure — <code>100</code>, <code>1,250.00</code>.
          That box is being ignored until it is.
        </p>
      }
    </div>
  `,
  styleUrl: './finding-filters.scss',
})
export class FindingFilters {
  readonly accounts = input<readonly Account[]>([]);
  /** Rule ids present in the current result set, so the dropdown offers only
   *  rules that actually produced something. */
  readonly rules = input<readonly string[]>([]);
  readonly filter = input.required<FindingFilterState>();

  readonly filterChange = output<FindingFilterState>();

  protected readonly BANDS = BANDS;

  protected readonly minInvalid = computed(() => {
    const text = this.filter().minAnnualText;
    return text.trim() !== '' && minAnnualCents(text) === undefined;
  });

  protected readonly isEmpty = computed(
    () => JSON.stringify({ ...this.filter() }) === JSON.stringify({ ...EMPTY_FINDING_FILTER }),
  );

  protected single(ids: readonly string[]): string {
    return ids[0] ?? '';
  }

  protected toggleBand(band: string, on: boolean): void {
    const bands = on
      ? [...this.filter().bands, band]
      : this.filter().bands.filter((value) => value !== band);
    this.patch({ bands });
  }

  protected patch(change: Partial<FindingFilterState>): void {
    this.filterChange.emit({ ...this.filter(), ...change });
  }

  protected reset(): void {
    this.filterChange.emit(EMPTY_FINDING_FILTER);
  }
}

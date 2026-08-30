/**
 * §6.6's Insights page — "the secondary goal's home".
 *
 * "Category spend by month as stacked bars with a date-range selector, a
 * month-over-month movers table (biggest risers and fallers), the fees and interest
 * rollup per account, the outliers list, and the small-spend aggregate table with
 * annualized columns. Months that are not fully covered are rendered hatched rather
 * than omitted, so a gap reads as a gap and not as a drop in spending."
 *
 * ## The hatching is the whole design, not a decoration
 *
 * Every other page in this app can afford to omit what it does not know. This one
 * cannot: a month with no statement, drawn as a short bar or left out of the axis, is
 * indistinguishable from a month you barely spent anything — and the reader has no
 * way to tell which they are looking at. §7.2 already made the *totals* exclude those
 * months; §6.6's sentence is about making the exclusion visible. So the bar is drawn
 * at zero height with a hatched footprint and the month keeps its place on the axis.
 *
 * ## Five resources, not one
 *
 * The three range-driven views re-read when the range changes; the two rule-backed
 * ones do not, because §5.9 and §5.11 answer over the whole ledger and re-fetching
 * them on a date change would be two requests to get the same rows back.
 *
 * Same split as the other pages: the container owns state and every request, and
 * `LedgerlineApiService` is the one seam.
 */

import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Panel } from '@metrum/ui';
import type { CategoryInsight, FeesInsight, MoversInsight, RuleBackedInsight } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';

/** §6.6's date-range selector. Empty means the whole ledger, which is what the API
 *  defaults to — the page does not invent a range the data may not cover. */
interface Range {
  readonly from: string;
  readonly to: string;
}

const EMPTY_WINDOW = { from: '', to: '', coveredMonths: 0, uncoveredMonths: [] };

@Component({
  selector: 'll-insights-page',
  imports: [FormsModule, Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './insights-page.html',
  styleUrl: './insights-page.scss',
})
export class InsightsPage {
  private readonly api = inject(LedgerlineApiService);

  protected readonly range = signal<Range>({ from: '', to: '' });

  private readonly query = computed(() => {
    const { from, to } = this.range();
    return {
      ...(from === '' ? {} : { from }),
      ...(to === '' ? {} : { to }),
    };
  });

  private readonly categoryResource = resource({
    params: () => this.query(),
    loader: ({ params }) => this.api.getCategoryInsight(params),
    defaultValue: { months: [], categories: [], window: EMPTY_WINDOW } satisfies CategoryInsight,
  });

  private readonly moversResource = resource({
    params: () => this.query(),
    loader: ({ params }) => this.api.getMoversInsight(params),
    defaultValue: {
      fromMonth: null,
      toMonth: null,
      risers: [],
      fallers: [],
      window: EMPTY_WINDOW,
    } satisfies MoversInsight,
  });

  private readonly feesResource = resource({
    params: () => this.query(),
    loader: ({ params }) => this.api.getFeesInsight(params),
    defaultValue: { accounts: [], totalCents: 0, window: EMPTY_WINDOW } satisfies FeesInsight,
  });

  // §5.9 and §5.11 answer over the whole ledger, so these do not take the range.
  private readonly outlierResource = resource({
    params: () => 0,
    loader: () => this.api.getOutlierInsight(),
    defaultValue: { rows: [], unavailableReason: null } satisfies RuleBackedInsight,
  });

  private readonly smallSpendResource = resource({
    params: () => 0,
    loader: () => this.api.getSmallSpendInsight(),
    defaultValue: { rows: [], unavailableReason: null } satisfies RuleBackedInsight,
  });

  protected readonly categories = computed(() => this.categoryResource.value());
  protected readonly movers = computed(() => this.moversResource.value());
  protected readonly fees = computed(() => this.feesResource.value());
  protected readonly outliers = computed(() => this.outlierResource.value());
  protected readonly smallSpend = computed(() => this.smallSpendResource.value());

  protected readonly loading = computed(
    () => this.categoryResource.isLoading() || this.moversResource.isLoading(),
  );

  /**
   * The tallest month in the window, used to scale every bar.
   *
   * Computed over **covered** months only. An uncovered month's total is whatever
   * happened to be imported for part of it, and letting a partial month set the
   * scale would shrink every complete one beside it — the same distortion §7.2
   * exists to keep out of the numbers, arriving instead through the axis.
   */
  protected readonly peakCents = computed(() => {
    const covered = this.categories().months.filter((month) => month.covered);
    return covered.reduce((peak, month) => Math.max(peak, Math.abs(month.totalCents)), 0);
  });

  /** A bar's height as a percentage of the tallest covered month. Uncovered months
   *  render at zero and are shown by their hatched footprint instead. */
  protected heightOf(totalCents: number, covered: boolean): number {
    const peak = this.peakCents();
    if (!covered || peak === 0) return 0;
    return Math.min(100, (Math.abs(totalCents) / peak) * 100);
  }

  protected money(cents: number | null | undefined): string {
    if (cents === null || cents === undefined) return '—';
    return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }

  /** §6.6's movers table. A null percentage is a rise from zero, which has none. */
  protected percent(value: number | null): string {
    if (value === null) return 'new';
    const rounded = Math.round(value);
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  }

  protected setRange(part: 'from' | 'to', value: string): void {
    this.range.update((current) => ({ ...current, [part]: value }));
  }

  protected clearRange(): void {
    this.range.set({ from: '', to: '' });
  }
}

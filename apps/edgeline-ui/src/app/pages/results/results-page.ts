/**
 * §11.1's results page — "summary tiles (P&L, hit rate, avg CLV) + per-day
 * table; rec-vs-executed toggle".
 *
 * ## Average CLV is the number to read, and the page says so
 *
 * While `paper_mode` is on nothing is placed, so the P&L is hypothetical by
 * construction. CLV compares the price alerted at against where the market
 * closed, which makes it the one figure carrying information about whether the
 * detector finds real edges or noise — and §15's Phase 4 go-live gate rests on
 * it. The tiles are ordered accordingly rather than putting the money first.
 *
 * ## `null` is not zero, and this page is where that matters most
 *
 * `hit_rate` and `avg_clv_pct` come back as `null` — not `0` — when nothing has
 * settled (`results.py` returns `None` "rather than 0.0 … a hit rate of zero and
 * no data yet are very different claims"). A tile that rendered both as `0.0%`
 * would tell a reader with an empty database that they lose every bet. So the
 * tiles say "nothing has settled yet" in words, and the per-day table renders
 * the em-dash.
 */

import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { Panel } from '@metrum/ui';
import type { SummaryBucket, SummaryResponse } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';
import {
  NO_DATA,
  formatCents,
  formatLocalDay,
  formatRatioAsPercent,
  formatSignedCents,
  formatSignedPercent,
} from '../../formatting';

type Group = 'day' | 'week';
/** §11.1's toggle: every graded recommendation, or only the ones you actually
 *  placed and confirmed. */
type Scope = 'all' | 'executed';

@Component({
  selector: 'el-results-page',
  imports: [Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './results-page.html',
  styleUrl: './results-page.scss',
})
export class ResultsPage {
  private readonly api = inject(EdgelineApiService);
  protected readonly status = inject(SystemStatus);

  protected readonly group = signal<Group>('day');
  protected readonly scope = signal<Scope>('all');

  private readonly summaryResource = resource({
    params: () => this.group(),
    loader: ({ params }) => this.api.getResultsSummary({ group: params }),
    defaultValue: {
      group: 'day',
      buckets: [],
      totals: { graded: 0, pnl_cents: 0, avg_clv_pct: null, hit_rate: null },
    } satisfies SummaryResponse,
  });

  protected readonly loading = this.summaryResource.isLoading;
  protected readonly loadError = computed(() => this.summaryResource.error());
  protected readonly buckets = computed(() => this.summaryResource.value().buckets ?? []);
  protected readonly totals = computed(() => this.summaryResource.value().totals);

  protected readonly executedCount = computed(() =>
    this.buckets().reduce((sum, bucket) => sum + bucket.executed, 0),
  );
  protected readonly executedPnlCents = computed(() =>
    this.buckets().reduce((sum, bucket) => sum + bucket.executed_pnl_cents, 0),
  );

  /** Nothing has been graded at all — a different sentence from "graded, but
   *  none of it settled". */
  protected readonly nothingGraded = computed(() => this.totals().graded === 0);
  protected readonly nothingSettled = computed(() => this.totals().hit_rate === null);

  /** The headline P&L, following §11.1's toggle. */
  protected readonly pnlCents = computed(() =>
    this.scope() === 'executed' ? this.executedPnlCents() : this.totals().pnl_cents,
  );
  protected readonly countLabel = computed(() =>
    this.scope() === 'executed'
      ? `${this.executedCount()} confirmed as placed`
      : `${this.totals().graded} graded`,
  );

  protected setGroup(value: string): void {
    this.group.set(value as Group);
  }

  protected setScope(value: Scope): void {
    this.scope.set(value);
  }

  protected bucketPnl(bucket: SummaryBucket): number {
    return this.scope() === 'executed' ? bucket.executed_pnl_cents : bucket.pnl_cents;
  }

  protected bucketCount(bucket: SummaryBucket): number {
    return this.scope() === 'executed' ? bucket.executed : bucket.graded;
  }

  protected readonly noData = NO_DATA;
  protected money = formatCents;
  protected signedMoney = formatSignedCents;
  protected signedPercent = formatSignedPercent;
  protected ratio = formatRatioAsPercent;
  protected day = formatLocalDay;
}

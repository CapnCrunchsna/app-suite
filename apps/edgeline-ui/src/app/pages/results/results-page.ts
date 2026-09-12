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
 *
 * ## The CLV tile names its own evidence
 *
 * Since 2026-09-11 a CLV may be measured against a bought closing snapshot or
 * derived from the last price stored before kickoff, which at the dev cadence
 * can be twelve hours old (§3.2 `closing_capture_mode`). The tile used to say
 * "against the closing line" whatever the number was. It now reports the split,
 * and shows the closing-only average beside the mixed one when they can differ —
 * the same reasoning as the `null` rule above, one level up: a number that
 * overstates where it came from is worse than no number.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Panel } from '@metrum/ui';
import { NO_DATA, formatCents, formatLocalDay, formatRatioAsPercent, formatSignedCents, formatSignedPercent } from '@metrum/format';
import type { SummaryBucket, SummaryResponse } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';

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

  /**
   * Where the CLV figure actually came from, in words.
   *
   * This tile used to read "against the closing line" whatever the number was.
   * That stopped being true when §3.2's `closing_capture_mode` gained a free
   * fallback: a CLV may now be measured against a price up to twelve hours
   * before kickoff. Overstating the evidence matters more here than anywhere
   * else on the page — §15's go-live gate reads this tile, and "against the
   * closing line" is precisely the claim it would be relying on.
   */
  protected readonly clvProvenance = computed(() => {
    const totals = this.totals();
    const closing = totals.clv_from_closing ?? 0;
    const derived = totals.clv_from_derived ?? 0;
    if (closing + derived === 0) return 'no closing price available yet';
    if (derived === 0) return 'against the closing line';
    if (closing === 0) return 'derived from the last price before kickoff';
    return `${closing} against closing lines, ${derived} derived`;
  });

  /** The same average over bought closing lines alone, shown only when the
   *  headline figure is a mix and the two can therefore disagree. */
  protected readonly clvClosingOnly = computed(() => {
    const totals = this.totals();
    const closing = totals.clv_from_closing ?? 0;
    const derived = totals.clv_from_derived ?? 0;
    if (!closing || !derived) return null;
    return totals.avg_clv_pct_closing ?? null;
  });

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

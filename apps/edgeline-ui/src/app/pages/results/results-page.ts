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
import { humanise, sportLabel } from '../../labels';
import { SystemStatus } from '../../system-status.service';

/** `excluded_reason` values (`audit.py`), as the clause that follows a count. */
const EXCLUSION_REASONS: Record<string, string> = {
  detected_after_start:
    'detected after the game had already started — dead lines a book had not taken down, not edges',
  duplicate_alert:
    'repeated an earlier recommendation of the same opportunity — graded at the same price, so the same evidence twice',
};

type Group = 'day' | 'week';
/** §11.1's toggle: every graded recommendation, or only the ones you actually
 *  placed and confirmed. */
type Scope = 'all' | 'executed';

/** T4.4 as restated 2026-10-08 (spec §15): the detector is read at 200
 *  non-circular opportunity CLVs, the go-live gate at 50 recommended ones,
 *  which must sit within ~2 points of the rest. */
const DETECTOR_TARGET = 200;
const GATE_TARGET = 50;
const GAP_TOLERANCE_PTS = 2;

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
    // Sentence case: these sit in the same tile caption as "No closing lines
    // captured yet" beside them, and a caption that starts lower-case reads as
    // a fragment that lost its first word.
    if (closing + derived === 0) return 'No closing price available yet';
    if (derived === 0) return 'Against the closing line';
    if (closing === 0) return 'Derived from the last price before kickoff';
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

  /**
   * Results set aside by `audit.py` and left out of every figure on this page.
   *
   * Said out loud rather than dropped silently. Until 2026-09-23 five bets
   * detected after their games had started were most of this page — −$39.03 and
   * a 33% hit rate over a real record of one win — and a page that quietly shows
   * fewer rows would be the same failure one level down.
   */
  protected readonly excluded = computed(() => this.totals().excluded ?? 0);

  /**
   * Why, reason by reason. Until 2026-10-01 every excluded row was a dead line
   * detected after its game started, and the note said so unconditionally; a
   * repeat recommendation of one opportunity is the second reason now, and a
   * note that called it a dead line would misstate it.
   */
  protected readonly excludedWhy = computed(() =>
    Object.entries(this.totals().excluded_by_reason ?? {})
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${EXCLUSION_REASONS[reason] ?? humanise(reason)}`)
      .join('; '),
  );

  /**
   * CLV over every opportunity whose game has started (§12, 2026-10-01), not
   * only the recommendations above — the cooldown keeps those to about one in
   * six. Supporting evidence, shown as such: T4.4 still reads the
   * recommendations, and circular measurements are counted, not averaged.
   */
  protected readonly opportunityClv = computed(
    () => this.summaryResource.value().opportunity_clv ?? null,
  );
  /** The overall figures, or null before anything is measured. */
  protected readonly clvMeasured = computed(() => {
    const measured = this.opportunityClv()?.measured;
    return measured && (measured.count ?? 0) > 0 ? measured : null;
  });
  protected readonly detectorTarget = DETECTOR_TARGET;
  protected readonly gateTarget = GATE_TARGET;

  /**
   * T4.4's two reads as tiles (2026-10-08), so their progress sits beside the
   * headline figures rather than at the foot of the page. Both read every
   * opportunity, so neither follows the all/executed toggle.
   */
  protected readonly alertSplit = computed(() => {
    const rows = this.opportunityClv()?.by_alert ?? [];
    const pick = (key: string) => rows.find((row) => row.key === key) ?? null;
    const recommended = pick('recommended');
    const rest = pick('not recommended');
    const gap =
      recommended?.mean_clv_pct != null && rest?.mean_clv_pct != null
        ? recommended.mean_clv_pct - rest.mean_clv_pct
        : null;
    return {
      recommended,
      rest,
      gap,
      gapLabel: gap === null ? null : `${gap >= 0 ? '+' : ''}${gap.toFixed(2)} pts`,
      // Outside the gate's tolerance: the recommendations need their own testing.
      wide: gap !== null && gap < -GAP_TOLERANCE_PTS,
    };
  });

  /** The breakdowns in the order the table shows them, sports by name. */
  protected readonly opportunityClvGroups = computed(() => {
    const clv = this.opportunityClv();
    if (!clv) return [];
    return [
      {
        title: 'By sport',
        rows: (clv.by_sport ?? []).map((row) => ({ ...row, label: sportLabel(row.key ?? '') })),
      },
      { title: 'By odds', rows: (clv.by_odds ?? []).map((row) => ({ ...row, label: row.key ?? '' })) },
      {
        title: 'By lead time',
        rows: (clv.by_lead ?? []).map((row) => ({ ...row, label: row.key ?? '' })),
      },
      // The go-live gate beside the detector (T4.4, 2026-10-08): the opportunities
      // that became recommendations, and the rest.
      {
        title: 'By alert',
        rows: (clv.by_alert ?? []).map((row) => ({ ...row, label: humanise(row.key ?? '') })),
      },
    ];
  });

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

/**
 * §11.1's opportunities page — "live table (poll `GET /api/opportunities` every
 * 15 s), filters status/type".
 *
 * This is the one screen that shows what the detectors saw *before* the
 * thresholds had their say. `min_edge_to_bet_pct` logs an opportunity without
 * alerting it (§3.2), so a row here with no matching recommendation is the
 * system working — which is why the page says so rather than leaving the reader
 * to wonder why they were not told.
 *
 * ## Polling, and why it is a plain interval
 *
 * Fifteen seconds, from §11.1. There is no websocket to subscribe to and the
 * response is a bounded table, so an interval that bumps a signal the resource
 * depends on is the whole mechanism. It is cleared on destroy — an interval that
 * outlives its component keeps a dead page's requests going, and in a test it
 * keeps the runner alive.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Panel } from '@metrum/ui';
import { formatLocalTime, formatPercent } from '@metrum/format';
import type { OpportunityLegRow, OpportunityRow } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';
import { formatDecimalOdds, toAmerican } from '../../formatting';
import { marketLabel, matchup, sportLabel, statusLabel, typeLabel } from '../../labels';

/** §11.1's cadence, named so the test can assert it rather than guess. */
export const POLL_INTERVAL_MS = 15_000;

type StatusFilter = 'all' | 'open' | 'alerted' | 'closed' | 'expired';
type TypeFilter = 'all' | 'ev' | 'arb';

@Component({
  selector: 'el-opportunities-page',
  imports: [Panel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './opportunities-page.html',
  styleUrl: './opportunities-page.scss',
})
export class OpportunitiesPage {
  private readonly api = inject(EdgelineApiService);
  protected readonly status = inject(SystemStatus);

  protected readonly statuses: readonly StatusFilter[] = [
    'all',
    'open',
    'alerted',
    'closed',
    'expired',
  ];
  protected readonly types: readonly TypeFilter[] = ['all', 'ev', 'arb'];

  protected readonly statusFilter = signal<StatusFilter>('all');
  protected readonly typeFilter = signal<TypeFilter>('all');
  protected readonly lastRefresh = signal<string | null>(null);
  private readonly tick = signal(0);

  private readonly rowsResource = resource({
    params: () => ({
      tick: this.tick(),
      status: this.statusFilter(),
      type: this.typeFilter(),
    }),
    loader: async ({ params }) => {
      const rows = await this.api.listOpportunities({
        status: params.status === 'all' ? null : params.status,
        type: params.type === 'all' ? null : params.type,
        limit: 200,
      });
      this.lastRefresh.set(new Date().toISOString());
      this.settled.set(rows);
      return rows;
    },
    defaultValue: [] as OpportunityRow[],
  });

  /**
   * The last rows that actually arrived, which is what the table renders.
   *
   * `resource` reverts `value()` to `defaultValue` the moment its params change,
   * and the 15-second tick is a param — so every poll emptied the table for the
   * length of one request. On a page of rows that collapsed the `<tbody>` to a
   * single "nothing detected" cell, the document lost most of its height, and the
   * browser pinned the scroll position to the top. It read as a full page reload
   * every fifteen seconds.
   *
   * Holding the last good value means a refresh changes the rows and nothing
   * else: no height change, no scroll jump, and the toolbar's "reading…" is what
   * says a request is in flight.
   */
  private readonly settled = signal<OpportunityRow[]>([]);

  protected readonly rows = this.settled.asReadonly();
  protected readonly loading = this.rowsResource.isLoading;
  /** Only before the first response — after that the table has rows to show and
   *  a spinner over them would be the same flicker in another form. */
  protected readonly loadingFirst = computed(
    () => this.rowsResource.isLoading() && this.settled().length === 0,
  );
  protected readonly loadError = computed(() => this.rowsResource.error());
  protected readonly filtered = computed(
    () => this.statusFilter() !== 'all' || this.typeFilter() !== 'all',
  );

  constructor() {
    const handle = setInterval(() => this.tick.update((value) => value + 1), POLL_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(handle));
  }

  protected setStatus(value: string): void {
    this.statusFilter.set(value as StatusFilter);
  }

  protected setType(value: string): void {
    this.typeFilter.set(value as TypeFilter);
  }

  protected refreshNow(): void {
    this.tick.update((value) => value + 1);
  }

  /**
   * Whether to draw `line` beside the selection.
   *
   * §7.2's normalizer writes a selection that already carries it — `Over 29.5`,
   * `Kansas City Royals -3.5` — so rendering the field beside it repeats the
   * number: "Over 29.5  29.5". The column is still worth keeping for a market or
   * a future provider whose selection does not embed the handicap, which is why
   * this asks rather than dropping the field.
   */
  protected showLine(leg: OpportunityLegRow): boolean {
    if (leg.line === null || leg.line === undefined) return false;
    return !leg.selection.includes(String(leg.line));
  }

  protected time = formatLocalTime;
  protected percent = formatPercent;
  protected odds = formatDecimalOdds;
  protected american = toAmerican;
  protected marketLabel = marketLabel;
  protected sportLabel = sportLabel;
  protected statusLabel = statusLabel;
  protected typeLabel = typeLabel;
  protected matchup = matchup;
}

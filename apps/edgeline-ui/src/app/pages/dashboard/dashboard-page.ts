/**
 * §11.1's dashboard — "health card (scheduler, quota, kill switch, paper badge),
 * today's recommendations, bankroll figure, big KILL/RESUME button".
 *
 * ## The page's real job today is explaining a silence
 *
 * Every table in this app is empty, and it is empty for a structural reason
 * rather than because the market is quiet: no sportsbook is enabled, because the
 * user holds no accounts yet. A dashboard that renders four zeroes and a blank
 * list is indistinguishable from a broken engine, and the person reading it has
 * no way to tell which they are looking at.
 *
 * So the page computes *why* and says it in a sentence. The two thresholds it
 * quotes are read from §3.2 rather than hard-coded — `min_books_for_consensus`
 * is a setting, and a dashboard that said "4" while the settings page said 6
 * would be teaching the reader something false about their own configuration.
 * The arb floor of two is arithmetic, not configuration: an arbitrage is two
 * prices at two different books, so one book can never produce one.
 *
 * ## Why RESUME asks twice and KILL does not
 *
 * Killing tightens a guardrail; resuming loosens one. §16.2 reserves loosening a
 * guardrail to an explicit user action in that session, and the API logs the
 * release loudly for the same reason. A single misplaced click on a button
 * sitting where KILL used to be is not that explicit action, and §12's daily
 * loss stop can have been what engaged it — in which case the honest prompt is
 * "check today's P&L first", which is what the confirmation says.
 */

import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Panel } from '@metrum/ui';
import type {
  BankrollResponse,
  RecommendationRow,
  Settings,
  SportsbookRow,
} from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';
import {
  formatAge,
  formatCents,
  formatLocalClock,
  formatPercent,
  isFresh,
  startOfLocalDayIso,
} from '../../formatting';

/** §13 stamps the heartbeat every 60 s, so three missed ones is a stopped
 *  worker rather than a slow one. */
const HEARTBEAT_STALE_S = 180;

/** An arbitrage is two prices at two different books. Not a setting — you
 *  cannot configure your way to one book disagreeing with itself. */
const ARB_MIN_BOOKS = 2;

@Component({
  selector: 'el-dashboard-page',
  imports: [Panel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-page.html',
  styleUrl: './dashboard-page.scss',
})
export class DashboardPage {
  private readonly api = inject(EdgelineApiService);
  protected readonly status = inject(SystemStatus);

  protected readonly confirmingResume = signal(false);

  private readonly settingsResource = resource({
    params: () => 0,
    loader: () => this.api.getSettings(),
    defaultValue: {} satisfies Settings,
  });

  private readonly booksResource = resource({
    params: () => 0,
    loader: () => this.api.listSportsbooks(),
    defaultValue: [] as SportsbookRow[],
  });

  private readonly bankrollResource = resource({
    params: () => 0,
    loader: () => this.api.getBankroll({ limit: 1 }),
    defaultValue: { total_cents: 0 } satisfies BankrollResponse,
  });

  /** "Today" is the reader's today. The API stores UTC, so the bound is local
   *  midnight expressed as a UTC instant — see `startOfLocalDayIso`. */
  private readonly todayResource = resource({
    params: () => startOfLocalDayIso(),
    loader: ({ params }) => this.api.listRecommendations({ from: params, limit: 50 }),
    defaultValue: [] as RecommendationRow[],
  });

  protected readonly settings = computed(() => this.settingsResource.value());
  protected readonly today = computed(() => this.todayResource.value());
  protected readonly loading = computed(
    () => this.booksResource.isLoading() || this.todayResource.isLoading(),
  );

  protected readonly bankrollCents = computed(
    () => this.bankrollResource.value().total_cents,
  );

  protected readonly enabledBooks = computed(() =>
    this.booksResource.value().filter((book) => book.enabled === true),
  );
  protected readonly bookCount = computed(() => this.booksResource.value().length);

  /** §3.2's `min_books_for_consensus`; the §3.2 default only stands in until
   *  the settings read lands. */
  protected readonly minBooksForConsensus = computed(
    () => this.settings().min_books_for_consensus ?? 4,
  );

  /**
   * How many books have to quote one market before a +EV call is possible —
   * **one more** than `min_books_for_consensus`.
   *
   * §6.4 is precise about this and it is the easiest thing in the system to get
   * wrong: the consensus has to come from that many *other* books, because the
   * book being priced never votes on its own fair value. So four enabled books
   * at the default gives each of them three others, and the gate cannot open at
   * all — which is exactly the dead end commit db40040 was written to stop
   * anyone rediscovering. A dashboard that printed the raw setting here would
   * send the reader to look for a market that cannot exist.
   */
  protected readonly evMinBooks = computed(() => this.minBooksForConsensus() + 1);

  protected readonly heartbeatAt = this.status.lastHeartbeatAt;
  protected readonly heartbeatAge = computed(() => formatAge(this.status.lastHeartbeatAt()));
  protected readonly workerAlive = computed(() =>
    isFresh(this.status.lastHeartbeatAt(), HEARTBEAT_STALE_S),
  );
  protected readonly quota = this.status.quota;

  /**
   * Which of the two detectors could fire at all with the books enabled right
   * now.
   *
   * `null` does not mean "everything is fine" — it means nothing is blocked by
   * *this* count. Enabling books is necessary and not sufficient: the provider
   * still has to quote them for the market in question, and §6.4 counts the ones
   * that actually did. The page says so rather than falling silent, because a
   * dashboard that goes quiet at eight enabled books is the failure this panel
   * exists to prevent.
   */
  protected readonly blockedReason = computed<'no-books' | 'ev-and-arb' | 'ev-only' | null>(() => {
    if (this.booksResource.isLoading()) return null;
    const enabled = this.enabledBooks().length;
    if (enabled === 0) return 'no-books';
    if (enabled < ARB_MIN_BOOKS) return 'ev-and-arb';
    if (enabled < this.evMinBooks()) return 'ev-only';
    return null;
  });

  protected readonly arbMinBooks = ARB_MIN_BOOKS;

  constructor() {
    // The shell asks for health too, and `ensureLoaded` is idempotent — but this
    // page is the one that *renders* health, and it must not depend on having
    // been reached through the shell to have any.
    void this.status.ensureLoaded();
  }

  protected async toggleKillSwitch(): Promise<void> {
    if (this.status.killSwitch()) {
      // Loosening a guardrail. Two presses, and the second one is labelled.
      if (!this.confirmingResume()) {
        this.confirmingResume.set(true);
        return;
      }
      this.confirmingResume.set(false);
      await this.status.setKillSwitch(false);
      return;
    }
    await this.status.setKillSwitch(true);
  }

  protected cancelResume(): void {
    this.confirmingResume.set(false);
  }

  /** A recommendation's total stake, from §5's stored `StakePlan`. The plan is
   *  an open blob on the wire, so the read is defensive by necessity. */
  protected stakeCents(row: RecommendationRow): number | null {
    const total = row.stakes?.['total_cents'];
    return typeof total === 'number' ? total : null;
  }

  protected money = formatCents;
  protected clock = formatLocalClock;
  protected percent = formatPercent;
}

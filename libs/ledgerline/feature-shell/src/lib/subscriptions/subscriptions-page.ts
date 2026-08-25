/**
 * §6.5, the Subscriptions page.
 *
 * "The recurring ledger: merchant, amount, cadence, next expected date, first seen,
 * total paid to date, status. Sortable by annual cost, which is the view that produces
 * the 'I pay *what* for that?' reaction. A month strip shows which days charges land [...]
 * The detail drawer holds the full charge history [...] A manual status always beats the
 * computed one."
 *
 * Same split as the other four pages: the container owns all state and every request, the
 * children are presentational, `resource()` for reads, and `LedgerlineApiService` is the
 * one seam to the API.
 *
 * ## Annual cost is the default sort, and that is a design claim
 *
 * §6.5 names the reaction it is after, and the reaction depends on the ordering: a ledger
 * sorted by merchant shows a tidy alphabet, and a ledger sorted by annual cost shows that
 * the $4.99 thing nobody thinks about costs more per year than the $40 thing everybody
 * argues over. The API returns the list already in that order (§9i) rather than sorting
 * here, because `annualCents` is computed server-side from the stored `cadences_per_year`
 * (§5.2) and re-sorting here would mean re-deriving it here.
 *
 * ## The page opens on what is still being paid for
 *
 * Cancelled and lapsed series stay in the ledger — §5.2 marks a lapse rather than
 * deleting, and "did I actually cancel that?" is a question this page should answer — but
 * they are not what the headline is about, so the default filter is what is live and the
 * others are one click away with their counts stated.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Panel } from '@metrum/ui';
import { formatCents } from '@metrum/ledgerline-domain';
import { LedgerlineApiError } from '@metrum/api-client';
import type { Account, Merchant, Series } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { MonthStrip } from './month-strip.js';
import type { StripDay } from './month-strip.js';
import { SeriesDetail } from './series-detail.js';
import type { SeriesEditEvent } from './series-detail.js';

export type SeriesScope = 'live' | 'all';

@Component({
  selector: 'll-subscriptions-page',
  imports: [Panel, MonthStrip, SeriesDetail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subscriptions-page.html',
  styleUrl: './subscriptions-page.scss',
})
export class SubscriptionsPage {
  private readonly api = inject(LedgerlineApiService);
  private readonly route = inject(ActivatedRoute);

  // ------------------------------------------------------------- state ---

  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly scope = signal<SeriesScope>('live');

  /**
   * §6.4's "Open subscription" deep link.
   *
   * A series finding's `subject_id` **is** the series id (§5.1's natural key), so the
   * Findings page can hand one over without a lookup. Read from the snapshot rather
   * than subscribed: the page is lazily loaded on navigation, so it is constructed
   * once per arrival and there is no second value to react to.
   */
  protected readonly selectedId = signal<string | null>(
    this.route.snapshot.queryParamMap.get('series'),
  );

  /** Bumped after a write so the page re-reads rather than patching a row it
   *  believes it knows the new state of — an override moves `effectiveStatus`,
   *  which moves the headline and the month strip. */
  private readonly revision = signal(0);

  // -------------------------------------------------------------- data ---

  private readonly seriesList = resource({
    params: () => this.revision(),
    loader: () => this.api.listSeries(),
    defaultValue: [] as Series[],
  });

  private readonly merchantList = resource({
    params: () => this.revision(),
    loader: () => this.api.listMerchants(),
    defaultValue: [] as Merchant[],
  });

  private readonly accountList = resource({
    params: () => this.revision(),
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  protected readonly merchantsById = computed(
    () => new Map(this.merchantList.value().map((m) => [m.id, m.displayName])),
  );

  private readonly accountsById = computed(
    () => new Map(this.accountList.value().map((a) => [a.id, a.displayName])),
  );

  /** Already sorted by annual cost, descending — see the header. */
  private readonly all = computed(() => this.seriesList.value());

  /**
   * The default scope hides what is not live — but a deep link from §6.4 is very often
   * *about* a lapsed series (§5.7's "did you mean to cancel this?"), and arriving on a
   * page that has filtered away the row you asked for reads as a broken link. So a
   * selected row is always in the list, whatever the scope says.
   */
  protected readonly rows = computed(() => {
    const all = this.all();
    if (this.scope() === 'all') return all;

    const selected = this.selectedId();
    return all.filter(
      (entry) => entry.effectiveStatus === 'active' || entry.id === selected,
    );
  });

  protected readonly inactiveCount = computed(
    () => this.all().filter((entry) => entry.effectiveStatus !== 'active').length,
  );

  /**
   * §5.2's summary, on the page it feeds: "14 active subscriptions, $247/mo, $2,964/yr".
   *
   * Summed over `effectiveStatus`, so a subscription the user has marked cancelled
   * leaves the headline the moment they say so rather than after `1.5 × cadence` of
   * silence makes §5.2 agree. The per-series figures are the API's (§5.2 stores
   * `cadences_per_year` precisely so these cannot disagree), and only the addition
   * happens here.
   */
  protected readonly headline = computed(() => {
    const active = this.all().filter((entry) => entry.effectiveStatus === 'active');
    const annualCents = active.reduce((total, entry) => total + entry.annualCents, 0);
    return {
      count: active.length,
      annualCents,
      monthlyCents: Math.round(annualCents / 12),
    };
  });

  protected readonly selected = computed(
    () => this.all().find((entry) => entry.id === this.selectedId()) ?? null,
  );

  protected readonly loading = computed(
    () => this.seriesList.isLoading() || this.merchantList.isLoading(),
  );

  protected readonly failure = computed(() => this.seriesList.error());

  protected readonly formatCents = formatCents;

  // ----------------------------------------------------------- helpers ---

  protected merchantNameFor(entry: Series): string {
    return this.merchantsById().get(entry.merchantId) ?? entry.merchantId;
  }

  protected accountNameFor(entry: Series): string | null {
    return this.accountsById().get(entry.accountId) ?? null;
  }

  /**
   * §5.2 measures liveness against the account's own coverage end, never the wall
   * clock, so `nextExpected` is routinely a date in the past — for a lapsed series it
   * is the charge that never arrived. Saying "overdue" would read as a bill the user
   * has missed; the honest phrasing is that it was expected and did not appear.
   */
  protected nextLabel(entry: Series): string {
    if (!entry.nextExpected) return '—';
    if (entry.effectiveStatus === 'active') return entry.nextExpected;
    return `${entry.nextExpected} (not seen)`;
  }

  // ---------------------------------------------------------- handlers ---

  protected onScope(next: SeriesScope): void {
    this.scope.set(next);
    this.notice.set(null);
  }

  protected onSelect(entry: Series): void {
    this.selectedId.set(this.selectedId() === entry.id ? null : entry.id);
    this.notice.set(null);
  }

  /** The strip's cells are subscriptions; clicking one opens it. A day with several
   *  opens the first, which is the one the strip lists first. */
  protected onDaySelected(day: StripDay): void {
    const first = day.series[0];
    if (first) this.selectedId.set(first.id);
  }

  protected async onEdited(event: SeriesEditEvent): Promise<void> {
    const name = this.merchantNameFor(event.series);

    await this.write(async () => {
      await this.api.updateSeries(event.series.id, event.patch);

      if (event.patch.userStatus !== undefined) {
        this.notice.set(
          event.patch.userStatus === null
            ? `${name} is back to whatever the analysis computes.`
            : `${name} is marked ${event.patch.userStatus}. It counts that way in every total.`,
        );
      } else if (event.patch.cancellationUrl !== undefined) {
        this.notice.set(
          event.patch.cancellationUrl ? `Cancellation link saved for ${name}.` : `Link cleared.`,
        );
      } else {
        this.notice.set(`Notes saved for ${name}.`);
      }
    });
  }

  /**
   * One write at a time, and a re-read after every one.
   *
   * `LedgerlineApiError` carries the API's own message — the 422 from an unusable
   * cancellation URL is the case this exists for, and rewording it here would mean two
   * descriptions of one rule drifting apart.
   */
  private async write(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
      this.revision.update((n) => n + 1);
    } catch (cause) {
      this.notice.set(
        cause instanceof LedgerlineApiError
          ? cause.message
          : `That did not save: ${(cause as Error).message}`,
      );
    } finally {
      this.busy.set(false);
    }
  }
}

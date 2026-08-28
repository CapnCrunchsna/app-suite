/**
 * The front door. Not a §6 section — see §9u.
 *
 * ## Why the app needed one
 *
 * Ledgerline opened on §6.4's Findings, which §6 calls the hero page and which is
 * the right *answer* — but it is an answer to a question the app has only earned
 * once you have imported something and run an analysis. On a fresh database it is
 * three em-dashes and an empty list, with no indication that the next move is
 * Import. And on a working database it is still a filtered table: it tells you
 * what was found, not what state you are in.
 *
 * This page answers the second question in one screen, and every block on it is a
 * doorway to the section that owns the subject. It computes nothing of its own.
 *
 * ## What is on it, and why each one earned its place
 *
 * - **The headline savings figure**, alone and large. §6.4 names it the number
 *   that justifies the app, and §5.1 restricts it to `impact_kind = savings`, so
 *   it is the one figure that means "this much would stop leaving".
 * - **Subscriptions, questions waiting, last run** — three facts about the state
 *   of the data rather than about the money. The middle one is §6.9's queue,
 *   read from the same `ReviewQueue` holder the rail's badge uses, so the two
 *   cannot disagree.
 * - **Statement coverage**, per account. §5.10 and §5.11 refuse to compute over
 *   partial months and every other rule degrades quietly across a gap, so "your
 *   findings are only as good as your months" belongs on the page that shows the
 *   findings total — not two clicks away on §6.2.
 * - **A real first-run state.** With no accounts, none of the above means
 *   anything, and the page becomes one instruction pointing at §6.1.
 *
 * ## What is deliberately not on it
 *
 * **Run analysis.** §6.4 owns that write, along with §2.7's job poll, the busy
 * state and the failure text. A second button here would be a second copy of all
 * four, and two run buttons on two pages can disagree about whether a run is in
 * flight. The stale-config warning links to Findings instead, which is where the
 * button already is and where the result would be read anyway.
 */

import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Panel } from '@metrum/ui';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Account, AccountCoverage, FindingsSummary } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { ReviewQueue } from '../review/review-queue.service.js';

@Component({
  selector: 'll-home-page',
  imports: [Panel, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home-page.html',
  styleUrl: './home-page.scss',
})
export class HomePage {
  private readonly api = inject(LedgerlineApiService);
  private readonly reviewQueue = inject(ReviewQueue);

  // -------------------------------------------------------------- data ---

  /** The loader's return type is widened rather than the default narrowed: the
   *  page renders before the first read lands, and `null` is what "not read yet"
   *  looks like everywhere in the template. */
  private readonly summaryResource = resource({
    loader: (): Promise<FindingsSummary | null> => this.api.getFindingsSummary({}),
    defaultValue: null,
  });

  private readonly accountList = resource({
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  /** One request per account, issued together — §6.2's argument for the same
   *  shape, and there is still no batch endpoint to use instead. */
  private readonly coverageList = resource({
    params: () => this.accountList.value().map((account) => account.id),
    loader: ({ params }) => Promise.all(params.map((id) => this.api.getAccountCoverage(id))),
    defaultValue: [] as AccountCoverage[],
  });

  protected readonly summary = computed(() => this.summaryResource.value());
  protected readonly accounts = computed(() =>
    this.accountList.value().filter((account) => account.isActive),
  );

  protected readonly loading = computed(
    () => this.summaryResource.isLoading() || this.accountList.isLoading(),
  );

  /** The API not answering is a different fact from an empty database, and the
   *  template says so rather than showing the first-run instruction to someone
   *  whose server is down. */
  protected readonly failure = computed(
    () => this.summaryResource.error() ?? this.accountList.error() ?? null,
  );

  /** No accounts is the fresh-install state, and it is the only one where none of
   *  the figures below mean anything. */
  protected readonly firstRun = computed(
    () => !this.loading() && !this.failure() && this.accountList.value().length === 0,
  );

  // ------------------------------------------------------------ figures ---

  /** §6.9's queue, from the holder the rail's badge reads. Not a second request,
   *  and not a second number that can drift from the one in the rail. */
  protected readonly outstanding = this.reviewQueue.outstanding;

  constructor() {
    // `ensureLoaded` and not `refresh`: the shell already read this at startup,
    // and §6.9's page re-reads it on entry because that is where being wrong
    // costs something. Here it is one figure among five. Idempotent, so this
    // costs nothing when the shell got there first — and it is what makes the
    // page correct on its own, rather than only inside a shell that happens to
    // have loaded it.
    void this.reviewQueue.ensureLoaded();
  }

  /**
   * §7.4: the findings on screen were scored under a `config_hash`, and a
   * threshold change since then means they are stale rather than wrong. Saying so
   * is the difference between a headline figure and a measurement.
   */
  protected readonly staleRun = computed(() => {
    const summary = this.summary();
    return Boolean(
      summary?.lastRunConfigHash && summary.lastRunConfigHash !== summary.configHash,
    );
  });

  protected readonly neverRun = computed(() => {
    const summary = this.summary();
    return Boolean(summary) && !summary?.lastRunAt;
  });

  private readonly coverageByAccount = computed(
    () => new Map(this.coverageList.value().map((entry) => [entry.accountId, entry])),
  );

  protected coverageFor(account: Account): AccountCoverage | null {
    return this.coverageByAccount().get(account.id) ?? null;
  }

  /**
   * "Jan 2025 – Aug 2026", from the statement periods rather than from
   * transaction dates — §7.2's rule, and the reason §6.2's bar exists at all.
   */
  protected coverageSpan(coverage: AccountCoverage): string {
    if (!coverage.coverageStart || !coverage.coverageEnd) return 'no statements yet';
    return `${monthLabel(coverage.coverageStart)} – ${monthLabel(coverage.coverageEnd)}`;
  }

  /** Total months with a hole in them: an outright gap and a partial month both
   *  break §5.10 and §5.11, so they are counted as one problem. */
  protected gapCount(coverage: AccountCoverage): number {
    return coverage.gapMonths.length + coverage.partialMonths.length;
  }

  protected readonly totalGaps = computed(() =>
    this.coverageList.value().reduce((total, entry) => total + this.gapCount(entry), 0),
  );

  protected formatDay(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  protected readonly formatCents = formatCents;
}

/** `2026-08` or `2026-08-25` → `Aug 2026`. Parsed by hand rather than through
 *  `Date`, which reads a bare `YYYY-MM` as UTC and can shift it a month west. */
function monthLabel(value: string): string {
  const [year, month] = value.split('-');
  const index = Number(month) - 1;
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return names[index] ? `${names[index]} ${year}` : value;
}

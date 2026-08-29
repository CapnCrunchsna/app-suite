/**
 * §6.4, the hero page.
 *
 * "A top strip with the three numbers that justify the app [...] Findings are
 * grouped by rule, sorted by **annual impact** descending."
 *
 * Same split as the other two pages: the container owns all state and every
 * request, and the four children are presentational. No child fetches.
 *
 * ## Three things worth knowing before changing this file
 *
 * **The headline is not computed here, and must not be.** §5.1 admits only
 * `impact_kind = savings` into the total and §7.3 forbids two findings claiming
 * the same dollars. `GET /api/findings/summary` answers that over the whole
 * finding set; this page holds one filtered page of rows. Summing what is on
 * screen would produce a number that changes when you page, which is the kind of
 * wrong that looks right.
 *
 * **The dismiss scope picker routes to two different endpoints**, because §3.1
 * makes them two tables with two lifecycles: `finding_state` is per-finding user
 * state keyed by natural key, `dismissal_rule` is a standing filter applied at
 * emit time to findings that do not exist yet. Dismissing a rule marks its
 * existing findings `suppressed` rather than `resolved` — §9e explains why that
 * third status had to exist, and it is why lifting a rule restores exactly what
 * it hid.
 *
 * **Grouping is by rule and ordering is by annual impact**, and both are done
 * here rather than asked of the API: `GET /api/findings` pages a flat list, and
 * §6.4's grouping is a presentation of the page you have. The *sort* is applied
 * within each group, so a group's first card is its biggest — matching §5.1's
 * "default sort" without pretending the page is the whole set.
 *
 * ## The evidence charges are one request for the page, not one per card
 *
 * §6.4 wants the transactions a finding was built from on the card. They now
 * arrive here, in a single `GET /api/transactions?ids=…` keyed by the union of
 * every visible card's evidence — the filter §9w added for exactly this.
 *
 * One request for the page rather than one per card, and neither of those rather
 * than the twelve-per-series `GET /api/transactions/:id` loop the old filter-less
 * contract forced. Per-card would have been defensible and is still worse in
 * every direction that matters here: nine rules' worth of cards is nine to two
 * hundred requests against a local Fastify process for data that fits in one, the
 * cards would populate raggedly as each landed, and a card that fetches is a card
 * that owns a resource, an error state and a loading state — which is the split
 * this file's second paragraph exists to prevent. The page already re-reads on
 * `revision`, so the charges invalidate with everything else for free.
 *
 * The union is **capped, twice**, and both caps are visible to the reader rather
 * than silent. `EVIDENCE_PER_CARD` is what a card may show: §5.1 caps a rule at 25
 * findings but says nothing about how many charges one may cite, and `micro.v1`
 * cites every charge in a high-frequency group by design. `EVIDENCE_ID_BUDGET` is
 * what the URL may carry, because `GET` is where this lives and a query string has
 * a length. Cards are served in the page's own reading order — biggest group,
 * biggest card — so a budget that runs out runs out at the bottom, on the cards
 * nobody scrolled to, and those degrade to the charge count they showed before.
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
import { formatCents } from '@metrum/ledgerline-domain';
import { Router } from '@angular/router';
import { LedgerlineApiError } from '@metrum/api-client';
import type {
  Account,
  Finding,
  FindingsSummary,
  ListFindingsQuery,
  Merchant,
  Transaction,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { ruleBlurb, ruleLabel } from '../rule-copy.js';
import { chargesFor, evidenceIdsForPage } from './evidence-charges.js';
import { FindingCard } from './finding-card.js';
import type { FindingActionEvent } from './finding-card.js';
import { FindingFilters, EMPTY_FINDING_FILTER, minAnnualCents } from './finding-filters.js';
import type { FindingFilterState } from './finding-filters.js';
import { FindingsSummaryStrip } from './findings-summary.js';

/** One rule's findings, biggest annual impact first. */
export interface FindingGroup {
  readonly ruleId: string;
  readonly findings: readonly Finding[];
  /** The group's own total, shown on its header. `visibility` findings are
   *  included here and excluded from the page headline — the distinction §7.3
   *  cares about is the *headline*, not whether a number may ever be added up. */
  readonly annualCents: number;
}

/** A page of findings is small — §5.1 caps every rule at 25 plus a rollup, so
 *  nine rules cannot exceed a few hundred. One request, no pagination UI. */
const PAGE_SIZE = 250;


@Component({
  selector: 'll-findings-page',
  imports: [Panel, FindingsSummaryStrip, FindingFilters, FindingCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './findings-page.html',
  styleUrl: './findings-page.scss',
})
export class FindingsPage {
  private readonly api = inject(LedgerlineApiService);
  private readonly router = inject(Router);

  // ------------------------------------------------------------- state ---

  protected readonly filter = signal<FindingFilterState>(EMPTY_FINDING_FILTER);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly running = signal(false);

  /** Bumped after a write so the page re-reads rather than patching a row it
   *  believes it knows the new state of. */
  private readonly revision = signal(0);

  private readonly query = computed<ListFindingsQuery>(() => {
    const f = this.filter();
    return {
      bands: f.bands.join(',') || undefined,
      ruleIds: f.ruleIds.join(',') || undefined,
      accountIds: f.accountIds.join(',') || undefined,
      minAnnualImpactCents: minAnnualCents(f.minAnnualText),
      visibility: f.visibility,
      limit: PAGE_SIZE,
      offset: 0,
    };
  });

  // -------------------------------------------------------------- data ---

  protected readonly page = resource({
    params: () => ({ query: this.query(), revision: this.revision() }),
    loader: ({ params }) => this.api.listFindings(params.query),
  });

  /**
   * The summary takes the same filters minus `visibility` — §6.4's three numbers
   * describe the findings in scope, so narrowing to one account should narrow
   * them too, but hiding dismissed cards must not change what you are owed.
   */
  private readonly summaryResource = resource({
    params: () => {
      const f = this.filter();
      return {
        revision: this.revision(),
        query: {
          bands: f.bands.join(',') || undefined,
          ruleIds: f.ruleIds.join(',') || undefined,
          accountIds: f.accountIds.join(',') || undefined,
          minAnnualImpactCents: minAnnualCents(f.minAnnualText),
        },
      };
    },
    loader: ({ params }) => this.api.getFindingsSummary(params.query),
  });

  private readonly accountList = resource({
    params: () => this.revision(),
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  private readonly merchantList = resource({
    params: () => this.revision(),
    loader: () => this.api.listMerchants(),
    defaultValue: [] as Merchant[],
  });

  protected readonly accounts = computed(() => this.accountList.value());

  private readonly merchantsById = computed(
    () => new Map(this.merchantList.value().map((merchant) => [merchant.id, merchant])),
  );

  /** `hasValue()` before `value()`, always: a `resource` in an error state throws
   *  from `value()`, and this page has to render when the API is unreachable. */
  protected readonly summary = computed<FindingsSummary | null>(() =>
    this.summaryResource.hasValue() ? this.summaryResource.value() : null,
  );

  protected readonly findings = computed<readonly Finding[]>(() =>
    this.page.hasValue() ? this.page.value().rows : [],
  );

  protected readonly total = computed(() => (this.page.hasValue() ? this.page.value().total : 0));

  /** Rule ids actually present, so the filter offers only rules that produced
   *  something rather than a hardcoded list of nine that goes stale. */
  protected readonly ruleIds = computed(() =>
    [...new Set(this.findings().map((finding) => finding.ruleId))].sort(),
  );

  /**
   * §6.4: "grouped by rule, sorted by annual impact descending."
   *
   * Groups are ordered by their own total so the rule that found the most money
   * leads, and cards within a group by their impact.
   */
  protected readonly groups = computed<readonly FindingGroup[]>(() => {
    const byRule = new Map<string, Finding[]>();
    for (const finding of this.findings()) {
      byRule.set(finding.ruleId, [...(byRule.get(finding.ruleId) ?? []), finding]);
    }

    return [...byRule.entries()]
      .map(([ruleId, findings]) => ({
        ruleId,
        findings: [...findings].sort(
          (a, b) => Math.abs(b.impactAnnualCents) - Math.abs(a.impactAnnualCents),
        ),
        annualCents: findings.reduce((total, finding) => total + finding.impactAnnualCents, 0),
      }))
      .sort((a, b) => Math.abs(b.annualCents) - Math.abs(a.annualCents));
  });

  // -------------------------------------------------- evidence charges ---

  /**
   * The ids to ask for, in the order the reader meets them.
   *
   * Flattened from `groups` rather than from `findings` because the budget has to
   * spend itself top-down on the page as rendered, and the API's paging order is
   * not that order.
   */
  private readonly evidenceIds = computed(() =>
    evidenceIdsForPage(this.groups().flatMap((group) => group.findings)),
  );

  /**
   * §6.4's charges, in one request for the whole page.
   *
   * `includeInternalTransfers` and `includeExcluded` are both on, against the
   * defaults §6.3 sets for browsing. An id list is an explicit selection, not a
   * browse: a rule cited these exact rows, and if the user has since marked one
   * an internal transfer the honest thing is to show a card whose charges match
   * its own count. Silently dropping it would leave "6 charges" above five rows
   * with no account of the sixth.
   *
   * `limit` matches the request rather than defaulting to 100 — the union is
   * already bounded by `EVIDENCE_ID_BUDGET`, and a second, quieter cap underneath
   * it would truncate the bottom of the page for a reason nothing on screen
   * explains.
   */
  private readonly evidenceResource = resource({
    params: () => ({ ids: this.evidenceIds(), revision: this.revision() }),
    loader: ({ params }) =>
      params.ids.length === 0
        ? Promise.resolve([])
        : this.api
            .listTransactions({
              ids: params.ids.join(','),
              includeInternalTransfers: true,
              includeExcluded: true,
              limit: params.ids.length,
            })
            .then((page) => page.rows.map((row) => row.transaction)),
    defaultValue: [] as Transaction[],
  });

  private readonly chargesById = computed(
    () => new Map(this.evidenceResource.value().map((row) => [row.id, row])),
  );

  /** The rows one card renders. Resolved here because the page owns the request;
   *  the card is handed transactions and renders them. */
  protected chargesFor(finding: Finding): readonly Transaction[] {
    return chargesFor(finding, this.chargesById());
  }

  /**
   * Which groups the reader has folded away.
   *
   * Collapsed rather than expanded is stored, so a rule that appears for the first
   * time after an analysis run arrives open. The alternative — remembering what is
   * *open* — silently hides a brand-new finding behind a fold the user never made.
   */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected isCollapsed(ruleId: string): boolean {
    return this.collapsed().has(ruleId);
  }

  protected toggleGroup(ruleId: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }

  protected collapseAll(): void {
    this.collapsed.set(new Set(this.groups().map((group) => group.ruleId)));
  }

  protected expandAll(): void {
    this.collapsed.set(new Set());
  }

  protected readonly allCollapsed = computed(
    () => this.groups().length > 0 && this.groups().every((group) => this.isCollapsed(group.ruleId)),
  );

  /** §6.4's page is one long column once a few rules fire; this is the strip that
   *  makes it navigable without scrolling to find out what is down there. */
  protected ruleLabel(ruleId: string): string {
    return ruleLabel(ruleId);
  }

  protected ruleBlurb(ruleId: string): string | null {
    return ruleBlurb(ruleId);
  }

  protected anchorFor(ruleId: string): string {
    return `rule-${ruleId.replace(/[^a-z0-9]+/gi, '-')}`;
  }

  /** Opens the group first, so a contents link never scrolls to a folded heading. */
  protected jumpTo(ruleId: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      next.delete(ruleId);
      return next;
    });

    // After the fold has opened, or the browser measures the old height.
    setTimeout(() => {
      document.getElementById(this.anchorFor(ruleId))?.scrollIntoView({ block: 'start' });
    });
  }

  // ----------------------------------------------------------- handlers ---

  /**
   * A group's total, labelled by what kind of money it is.
   *
   * §7.3's distinction is worth carrying onto the group header rather than only
   * the headline: a `visibility` rule's total is real money the user is spending
   * and is *not* part of the savings figure above, and a header that showed both
   * kinds identically would invite adding them together by eye.
   */
  protected formatGroupTotal(annualCents: number): string {
    return `${formatCents(annualCents)}/yr`;
  }

  protected onFilterChange(next: FindingFilterState): void {
    this.filter.set(next);
    this.notice.set(null);
  }

  protected merchantNameFor(finding: Finding): string | null {
    const id = finding.detail['merchantId'];
    if (typeof id !== 'string' || id === '') return null;
    return this.merchantsById().get(id)?.displayName ?? null;
  }

  /**
   * §6.4's four actions, routed by scope.
   *
   * Acknowledge, snooze and dismiss-this are per-finding state. The other two
   * dismissals write a standing rule — a different table, and one that affects
   * findings this run has not produced yet.
   */
  protected async onAction(event: FindingActionEvent): Promise<void> {
    const { finding, action } = event;

    switch (action.kind) {
      case 'acknowledge':
        await this.write(async () => {
          await this.api.setFindingState(finding.id, { status: 'acknowledged' });
          this.notice.set(`Acknowledged "${finding.title}".`);
        });
        return;

      case 'snooze':
        await this.write(async () => {
          // 90 days is §5.1's default and the API's; not restated here.
          const updated = await this.api.setFindingState(finding.id, { status: 'snoozed' });
          this.notice.set(
            updated.snoozeUntil ? `Snoozed until ${updated.snoozeUntil}.` : 'Snoozed for 90 days.',
          );
        });
        return;

      case 'dismiss_finding':
        await this.write(async () => {
          await this.api.setFindingState(finding.id, { status: 'dismissed' });
          this.notice.set(
            `Dismissed "${finding.title}". It comes back if the amount or the series' status changes.`,
          );
        });
        return;

      case 'dismiss_merchant': {
        const merchantId = finding.detail['merchantId'];
        if (typeof merchantId !== 'string' || merchantId === '') return;
        const name = this.merchantNameFor(finding) ?? merchantId;
        await this.write(async () => {
          await this.api.createDismissalRule({
            scope: 'merchant_rule',
            ruleId: finding.ruleId,
            merchantId,
          });
          this.notice.set(
            `${finding.ruleId} will not report ${name} again. Its existing findings are ` +
              'suppressed rather than resolved, so lifting the rule restores them.',
          );
        });
        return;
      }

      case 'dismiss_rule':
        await this.write(async () => {
          await this.api.createDismissalRule({ scope: 'rule', ruleId: finding.ruleId });
          this.notice.set(
            `${finding.ruleId} is off. Every finding it emitted is suppressed, not deleted — ` +
              'delete the dismissal rule to bring them back.',
          );
        });
        return;
    }
  }

  /**
   * §6.4's "Open subscription", which now goes somewhere (§9i).
   *
   * A series finding's `subject_id` **is** the series id (§5.1's natural key), so
   * the deep link needs no lookup — the Subscriptions page selects the row from the
   * query parameter and opens its drawer. Until §6.5 was built this action set a
   * notice explaining its own absence, which was the honest thing to do with a
   * button that could not lead anywhere, and is now dead weight.
   */
  protected async onOpenSubscription(finding: Finding): Promise<void> {
    await this.router.navigate(['/subscriptions'], {
      queryParams: { series: finding.subjectId },
    });
  }

  /**
   * §2.7: the run is a job. The runner exists, so this polls until it settles
   * rather than assuming — a run over a decade of statements is not instant, and
   * §2.2's guard can refuse it outright.
   */
  protected async runAnalysis(): Promise<void> {
    this.running.set(true);
    this.notice.set(null);
    try {
      let job = await this.api.runAnalysis();

      for (
        let attempt = 0;
        attempt < 60 && (job.state === 'queued' || job.state === 'running');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await this.api.getJob(job.id);
      }

      if (job.state === 'failed') {
        this.notice.set(`The analysis run failed: ${job.message ?? 'no reason given'}`);
      } else if (job.state === 'succeeded') {
        this.notice.set(job.message ?? 'Analysis finished.');
      } else {
        this.notice.set(
          'The analysis job is still running; the numbers will update when it lands.',
        );
      }

      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.report(cause, 'Could not start an analysis run');
    } finally {
      this.running.set(false);
    }
  }

  /** One place a write happens, so one place that clears busy, re-reads, and
   *  turns a failure into something the user can read. */
  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.report(cause, 'That did not apply');
    } finally {
      this.busy.set(false);
    }
  }

  /** Branching on `error.code` rather than on prose — the code is documented as
   *  stable, the message may be reworded. */
  private report(cause: unknown, prefix: string): void {
    if (cause instanceof LedgerlineApiError && cause.code === 'not_found') {
      this.notice.set('That finding is gone — the last analysis run resolved it.');
      return;
    }
    this.notice.set(`${prefix}: ${(cause as Error).message}`);
  }

  protected dismissNotice(): void {
    this.notice.set(null);
  }

  protected reload(): void {
    this.revision.update((value) => value + 1);
  }
}

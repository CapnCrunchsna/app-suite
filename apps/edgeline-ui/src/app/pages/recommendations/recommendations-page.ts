/**
 * §11.1's recommendations page — "history table; row action 'confirm bet'
 * dialog → confirm endpoint".
 *
 * ## What "confirm" is, and what it is emphatically not
 *
 * §16.1 makes it an architectural boundary rather than a phase-1 limitation:
 * nothing in this system places a bet. The confirm dialog records that *you*
 * already did — it is §9.3's ✅ reaction, reachable from a browser instead of
 * from Discord, and it writes a `bets` row with `confirmed_via='ui'`.
 *
 * That is why the two fields are the stake and the odds you *got*, not the ones
 * that were recommended. They will differ — the line moves between the alert and
 * the tap — and that difference is the point of recording them: it is what makes
 * §12's P&L real rather than hypothetical, and what promotes a paper
 * recommendation to an executed one in the results split.
 *
 * ## Deep links render as absent, never as dead
 *
 * Every stake leg carries `deep_link: ""` and `link_level: "none"` today,
 * because no book has a verified URL template (T4.3) and §16.3 forbids inventing
 * one. A blank anchor styled like a link is the worst available rendering: it
 * looks tappable, does nothing, and reads as a bug in the app rather than as a
 * fact about the data. So a missing link is words, not a link.
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
import { centsFromDollars, dollarsFromCents, formatCents, formatLocalTime, formatPercent, formatSignedCents, formatSignedPercent } from '@metrum/format';
import type { RecommendationRow } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { SystemStatus } from '../../system-status.service';
import { formatDecimalOdds, toAmerican } from '../../formatting';

/** One leg of a stored §5 `StakePlan`, read defensively out of an open blob. */
export interface StakeLegView {
  readonly bookKey: string;
  readonly selection: string;
  readonly stakeCents: number | null;
  readonly toWinCents: number | null;
  readonly deepLink: string;
  readonly linkLevel: string;
}

export interface StakePlanView {
  readonly totalCents: number | null;
  readonly method: string;
  readonly guardrails: readonly string[];
  readonly legs: readonly StakeLegView[];
}

type PaperFilter = 'all' | 'paper' | 'executed';

@Component({
  selector: 'el-recommendations-page',
  imports: [Panel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recommendations-page.html',
  styleUrl: './recommendations-page.scss',
})
export class RecommendationsPage {
  private readonly api = inject(EdgelineApiService);
  protected readonly status = inject(SystemStatus);

  protected readonly paperFilter = signal<PaperFilter>('all');
  protected readonly from = signal('');
  protected readonly to = signal('');

  protected readonly confirming = signal<string | null>(null);
  protected readonly stakeDollars = signal('');
  protected readonly oddsDecimal = signal('');
  protected readonly saving = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly failure = signal<string | null>(null);

  private readonly rowsResource = resource({
    params: () => ({ paper: this.paperFilter(), from: this.from(), to: this.to() }),
    loader: ({ params }) =>
      this.api.listRecommendations({
        paper: params.paper === 'all' ? null : params.paper === 'paper',
        from: params.from || null,
        to: params.to || null,
        limit: 200,
      }),
    defaultValue: [] as RecommendationRow[],
  });

  protected readonly rows = computed(() => this.rowsResource.value());
  protected readonly loading = this.rowsResource.isLoading;
  protected readonly loadError = computed(() => this.rowsResource.error());
  protected readonly filtered = computed(
    () => this.paperFilter() !== 'all' || this.from() !== '' || this.to() !== '',
  );

  protected setPaperFilter(value: string): void {
    this.paperFilter.set(value as PaperFilter);
  }

  protected setFrom(value: string): void {
    this.from.set(value);
  }

  protected setTo(value: string): void {
    this.to.set(value);
  }

  protected clearFilters(): void {
    this.paperFilter.set('all');
    this.from.set('');
    this.to.set('');
  }

  /** §5's stored `StakePlan`, which is `dict[str, Any]` on the wire. */
  protected plan(row: RecommendationRow): StakePlanView {
    const stakes = row.stakes ?? {};
    const rawLegs = stakes['legs'];
    const legs = Array.isArray(rawLegs) ? rawLegs.map(toLeg) : [];
    const guardrails = stakes['guardrails_applied'];
    return {
      totalCents: numberOrNull(stakes['total_cents']),
      method: typeof stakes['method'] === 'string' ? stakes['method'] : '—',
      guardrails: Array.isArray(guardrails) ? guardrails.map((value) => String(value)) : [],
      legs,
    };
  }

  protected hasLink(leg: StakeLegView): boolean {
    return leg.deepLink !== '' && leg.linkLevel !== 'none';
  }

  /** Already recorded as placed — the row has a graded result carrying a bet. */
  protected isExecuted(row: RecommendationRow): boolean {
    const betId = row.result?.bet_id;
    return typeof betId === 'string' && betId !== '';
  }

  protected openConfirm(row: RecommendationRow): void {
    this.confirming.set(row.id);
    this.notice.set(null);
    this.failure.set(null);
    // Prefilled with what was recommended, because that is the closest honest
    // starting point — and left editable, because what you got is the number
    // that matters.
    const plan = this.plan(row);
    const dollars = dollarsFromCents(plan.totalCents);
    this.stakeDollars.set(dollars === null ? '' : String(dollars));
    const firstLeg = row.opportunity?.legs?.[0];
    this.oddsDecimal.set(firstLeg ? String(firstLeg.price_decimal) : '');
  }

  protected closeConfirm(): void {
    this.confirming.set(null);
  }

  /** The odds being typed, echoed in the convention the book will quote back
   *  (§1: American only at display edges). */
  protected readonly oddsAmerican = computed(() => toAmerican(Number(this.oddsDecimal())));

  protected confirmValid(): boolean {
    const cents = centsFromDollars(this.stakeDollars());
    const odds = Number(this.oddsDecimal());
    return cents !== null && cents >= 0 && Number.isFinite(odds) && odds > 1;
  }

  protected async confirm(row: RecommendationRow): Promise<void> {
    if (!this.confirmValid()) return;
    const stake = centsFromDollars(this.stakeDollars());
    if (stake === null) return;
    this.saving.set(true);
    this.failure.set(null);
    try {
      await this.api.confirmRecommendation(row.id, {
        stake_actual_cents: stake,
        odds_actual_decimal: Number(this.oddsDecimal()),
      });
      this.confirming.set(null);
      this.notice.set(
        `Recorded ${formatCents(stake)} at ${this.oddsDecimal()} as a bet you placed. Edgeline placed nothing.`,
      );
      this.rowsResource.reload();
    } catch (cause) {
      this.failure.set(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.saving.set(false);
    }
  }

  protected money = formatCents;
  protected signedMoney = formatSignedCents;
  protected time = formatLocalTime;
  protected percent = formatPercent;
  protected signedPercent = formatSignedPercent;
  protected odds = formatDecimalOdds;
  protected american = toAmerican;
}

function toLeg(value: unknown): StakeLegView {
  const leg = (value ?? {}) as Record<string, unknown>;
  return {
    bookKey: typeof leg['book_key'] === 'string' ? leg['book_key'] : '—',
    selection: typeof leg['selection'] === 'string' ? leg['selection'] : '—',
    stakeCents: numberOrNull(leg['stake_cents']),
    toWinCents: numberOrNull(leg['to_win_cents']),
    deepLink: typeof leg['deep_link'] === 'string' ? leg['deep_link'] : '',
    linkLevel: typeof leg['link_level'] === 'string' ? leg['link_level'] : 'none',
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

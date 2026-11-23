/**
 * What if (§11, added 2026-11-13): the Results page's question, asked several
 * ways at once.
 *
 * Results answers "what did the paper ledger do". This page answers "was that
 * good or bad, and what would a different rule have done": the same bets, or
 * every settled opportunity the detector found, filtered by sport, odds, edge,
 * market and period, and each view set against what its closing-line value
 * expected and the range luck alone would give (`what-if-math.ts`).
 *
 * The rows come from `/api/results/what-if` once and are re-totalled in the
 * browser, so every toggle is instant. The default view, paper bets as staked,
 * is the Results page's own P&L, which is the bridge between the two pages.
 */

import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { Panel } from '@metrum/ui';
import { formatLocalDay, formatRatioAsPercent, formatSignedCents, formatSignedPercent } from '@metrum/format';
import type { WhatIfResponse } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from '../../edgeline-api.service';
import { toAmerican } from '../../formatting';
import { LoadFailure } from '../../datastore-outage';
import { marketLabel, sportLabel } from '../../labels';
import { valueOr } from '../../resource-value';
import { LuckChart } from './luck-chart';
import {
  DEFAULT_FLAT_CENTS,
  VERDICT_LABELS,
  breakdown,
  chanceThisBad,
  running,
  select,
  stats,
  verdict,
  type BetSet,
  type Detector,
  type Dimension,
  type Filters,
  type Staking,
  type Stats,
} from './what-if-math';

const EMPTY: WhatIfResponse = { paper: [], opportunities: [] };

/** The day the current alert rules took effect: the per-game cooldown (11-01),
 *  the NBA and NHL pause and the 3% threshold (11-04). */
const RULES_SINCE = '2026-11-04T12:00:00Z';

interface Option<T> {
  readonly value: T;
  readonly label: string;
}

const ODDS_OPTIONS: readonly Option<number | null>[] = [
  { value: null, label: 'Any' },
  { value: 10, label: 'Up to +900' },
  { value: 5, label: 'Up to +400' },
  { value: 3, label: 'Up to +200' },
];

const EDGE_OPTIONS: readonly Option<number | null>[] = [
  { value: null, label: 'Any' },
  { value: 3, label: '3%+' },
  { value: 5, label: '5%+' },
  { value: 8, label: '8%+' },
];

type Period = 'all' | '30d' | 'rules';
const PERIOD_OPTIONS: readonly Option<Period>[] = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'rules', label: 'Since the 11-04 rules' },
];

const DIMENSIONS: readonly Option<Dimension>[] = [
  { value: 'sport', label: 'Sport' },
  { value: 'odds', label: 'Odds' },
  { value: 'edge', label: 'Edge' },
  { value: 'market', label: 'Market' },
  { value: 'book', label: 'Book' },
];

/** The bet list is a table view of the chart; past this it stops being read. */
const BET_LIST_LIMIT = 400;

@Component({
  selector: 'el-what-if-page',
  imports: [Panel, LoadFailure, LuckChart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './what-if-page.html',
  styleUrl: './what-if-page.scss',
})
export class WhatIfPage {
  private readonly api = inject(EdgelineApiService);

  private readonly data = resource({ loader: () => this.api.getWhatIf(), defaultValue: EMPTY });
  private readonly settings = resource({ loader: () => this.api.getSettings() });

  protected readonly loading = this.data.isLoading;
  protected readonly loadError = computed(() => this.data.error());

  // ---- the controls --------------------------------------------------------

  protected readonly set = signal<BetSet>('paper');
  protected readonly detector = signal<Detector>('as-run');
  protected readonly detectorOptions: readonly Option<Detector>[] = [
    { value: 'as-run', label: 'As run' },
    { value: 'consensus', label: 'Consensus' },
    { value: 'pinnacle', label: 'Pinnacle' },
  ];
  protected readonly staking = signal<Staking>('ledger');
  protected readonly excludedSports = signal<ReadonlySet<string>>(new Set());
  protected readonly excludedMarkets = signal<ReadonlySet<string>>(new Set());
  protected readonly maxPrice = signal<number | null>(null);
  protected readonly minEdge = signal<number | null>(null);
  protected readonly period = signal<Period>('all');
  protected readonly dimension = signal<Dimension>('sport');

  protected readonly oddsOptions = ODDS_OPTIONS;
  protected readonly edgeOptions = EDGE_OPTIONS;
  protected readonly periodOptions = PERIOD_OPTIONS;
  protected readonly dimensions = DIMENSIONS;
  protected readonly flatLabel = formatSignedCents(DEFAULT_FLAT_CENTS).replace(/^\+/, '').replace(/\.00$/, '');

  private readonly rows = computed(() => {
    const data = valueOr(this.data, EMPTY);
    return (this.set() === 'paper' ? data.paper : data.opportunities) ?? [];
  });

  /** The paper set's own stakes exist only there; every opportunity is flat. */
  protected readonly effectiveStaking = computed<Staking>(() =>
    this.set() === 'paper' ? this.staking() : 'flat',
  );

  protected readonly pausedSports = computed(
    () => new Set(this.settings.hasValue() ? (this.settings.value()?.alerts_paused_sports ?? []) : []),
  );

  /** Every sport and market the chosen set holds, so a chip is never offered
   *  for something with no bets behind it. */
  protected readonly sportChips = computed(() =>
    [...new Set(this.rows().map((r) => r.sport_key))]
      .sort((a, b) => sportLabel(a).localeCompare(sportLabel(b)))
      .map((key) => ({ key, label: sportLabel(key), paused: this.pausedSports().has(key) })),
  );
  protected readonly marketChips = computed(() =>
    [...new Set(this.rows().map((r) => r.market_key))].map((key) => ({ key, label: marketLabel(key) })),
  );

  private readonly filters = computed<Filters>(() => ({
    set: this.set(),
    detector: this.detector(),
    staking: this.effectiveStaking(),
    flatCents: DEFAULT_FLAT_CENTS,
    excludedSports: this.excludedSports(),
    excludedMarkets: this.excludedMarkets(),
    maxPrice: this.maxPrice(),
    minEdgePct: this.minEdge(),
    since:
      this.period() === 'rules'
        ? RULES_SINCE
        : this.period() === '30d'
          ? new Date(Date.now() - 30 * 86_400_000).toISOString()
          : null,
  }));

  // ---- what the view says ---------------------------------------------------

  protected readonly bets = computed(() => select(this.rows(), this.filters()));
  protected readonly totals = computed(() => stats(this.bets()));
  protected readonly verdict = computed(() => verdict(this.totals()));
  protected readonly verdictLabel = computed(() => VERDICT_LABELS[this.verdict()]);
  protected readonly chance = computed(() => chanceThisBad(this.bets()));
  protected readonly points = computed(() => running(this.bets()));
  protected readonly rowsByDimension = computed(() =>
    breakdown(this.bets(), this.dimension(), (dimension, key) =>
      dimension === 'sport' ? sportLabel(key) : dimension === 'market' ? marketLabel(key) : key,
    ),
  );
  protected readonly betList = computed(() => [...this.points()].reverse().slice(0, BET_LIST_LIMIT));
  protected readonly betListLimit = BET_LIST_LIMIT;

  protected readonly withoutClv = computed(() => {
    const data = valueOr(this.data, EMPTY);
    return (this.set() === 'paper' ? data.paper_without_clv : data.opportunities_without_clv) ?? 0;
  });

  protected readonly isDefault = computed(
    () =>
      this.excludedSports().size === 0 &&
      this.excludedMarkets().size === 0 &&
      this.maxPrice() === null &&
      this.minEdge() === null &&
      this.period() === 'all',
  );

  // ---- actions --------------------------------------------------------------

  protected toggleSport(key: string): void {
    this.excludedSports.update((set) => toggled(set, key));
  }

  protected toggleMarket(key: string): void {
    this.excludedMarkets.update((set) => toggled(set, key));
  }

  /** The view most worth a click: football alone, the sports still alerted. */
  protected footballOnly(): void {
    this.excludedSports.set(new Set(this.sportChips().map((c) => c.key).filter((k) => !k.startsWith('americanfootball_'))));
  }

  protected reset(): void {
    this.excludedSports.set(new Set());
    this.excludedMarkets.set(new Set());
    this.maxPrice.set(null);
    this.minEdge.set(null);
    this.period.set('all');
  }

  // ---- formatting -----------------------------------------------------------

  protected money(cents: number): string {
    return formatSignedCents(Math.round(cents));
  }

  protected range(s: Stats, k = 1): string {
    if (!s.settled) return '—';
    return `${this.money(s.expectedCents - k * s.sdCents)} to ${this.money(s.expectedCents + k * s.sdCents)}`;
  }

  protected pct(value: number | null | undefined): string {
    return formatSignedPercent(value ?? null);
  }

  protected ratio(value: number | null): string {
    return formatRatioAsPercent(value, 0);
  }

  protected verdictOf(s: Stats): string {
    return VERDICT_LABELS[verdict(s)];
  }

  protected tone(s: Stats): 'pos' | 'neg' | '' {
    const v = verdict(s);
    return v === 'above' || v === 'lucky' ? 'pos' : v === 'below' || v === 'unlucky' ? 'neg' : '';
  }

  protected day(iso: string): string {
    return formatLocalDay(iso);
  }

  protected odds(price: number): string {
    return toAmerican(price);
  }

  protected sport(key: string): string {
    return sportLabel(key);
  }

  protected market(key: string): string {
    return marketLabel(key);
  }
}

function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

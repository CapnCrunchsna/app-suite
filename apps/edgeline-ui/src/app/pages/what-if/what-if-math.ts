/**
 * The What-if page's arithmetic (§11, added 2026-11-13), kept free of Angular so
 * every number on the page is testable on its own.
 *
 * ## What "expected" and "luck range" mean here
 *
 * Each bet's CLV is its expected return if the closing line is right:
 * `clv = closing_prob × price − 1`. So for a stake `s` at decimal `price`:
 *
 * - **expected P&L** is `s × clv`;
 * - **win probability** is `p = (1 + clv) / price`;
 * - **luck** is the spread of a win-or-lose bet around its expectation, with
 *   variance `p(1 − p)(s × price)²`. Variances add across independent bets, so
 *   the range for a run of bets is the expected total ± its standard deviation.
 *
 * ±1 sd holds about two runs in three, ±2 sd about nineteen in twenty. Long shots
 * have a large `s × price`, which is why a long-shot strategy's range is wide.
 *
 * `chanceThisBad` is a simulation rather than the normal approximation: with
 * a few dozen +500 bets the distribution is badly skewed, and the normal curve
 * would overstate how unusual a losing run is.
 */

import type { WhatIfBet } from '@metrum/edgeline-api-client';

export type BetSet = 'paper' | 'opportunities';
export type Staking = 'ledger' | 'flat';
/**
 * Which detector the opportunity set is judged as (2026-11-22). `as-run` is
 * whatever was in charge when each was found, shadows left out. `consensus`
 * and `pinnacle` keep the opportunities whose edge against that fair price
 * cleared the live 3%, shadows included, so the two detectors can be compared
 * on the same games. Pinnacle edges exist from 2026-11-22.
 */
export type Detector = 'as-run' | 'consensus' | 'pinnacle';

/** The threshold a detector toggle applies, the live one since 2026-11-04. */
export const DETECTOR_THRESHOLD_PCT = 3;

export interface Filters {
  readonly set: BetSet;
  /** Ignored for the paper set, which is what was recommended. */
  readonly detector?: Detector;
  /** `ledger` is the paper ledger's own (Kelly) stakes; only the paper set has them. */
  readonly staking: Staking;
  readonly flatCents: number;
  /** Sport keys left out. Excluding rather than including, so a sport that
   *  appears in the data later is shown rather than silently hidden. */
  readonly excludedSports: ReadonlySet<string>;
  readonly excludedMarkets: ReadonlySet<string>;
  /** Longest odds taken, as a decimal price; `null` takes everything. */
  readonly maxPrice: number | null;
  readonly minEdgePct: number | null;
  /** Bets on games starting at or after this ISO stamp; `null` is all time. */
  readonly since: string | null;
}

export interface PricedBet {
  readonly row: WhatIfBet;
  readonly stakeCents: number;
  readonly pnlCents: number;
  readonly expectedCents: number;
  readonly variance: number;
  /** Win probability at the close; `null` for a push or void, which carries no risk. */
  readonly p: number | null;
}

export interface Stats {
  readonly bets: number;
  readonly settled: number;
  readonly wins: number;
  readonly expectedWins: number;
  readonly stakedCents: number;
  readonly pnlCents: number;
  readonly expectedCents: number;
  readonly sdCents: number;
  /** P&L over stake; `null` with nothing staked. */
  readonly roi: number | null;
  readonly meanClvPct: number | null;
  readonly sharpCount: number;
  readonly meanSharpClvPct: number | null;
  /** (actual − expected) / sd, `null` when there is no spread to measure by. */
  readonly z: number | null;
}

export type Verdict = 'none' | 'within' | 'unlucky' | 'lucky' | 'below' | 'above';

/** Paper stakes run about $4; a flat $10 keeps the numbers readable. */
export const DEFAULT_FLAT_CENTS = 1000;

/** Win probabilities are clamped so a stray CLV can never give certainty. */
const P_FLOOR = 0.001;
const P_CEILING = 0.999;

/**
 * One bet per pick for the opportunity set: the same selection found at three
 * books, or found again at a later poll, is one bet, not three. The best price
 * is kept (the earliest on a tie), which is the one an alert would have named.
 * The paper set is already one row per recommendation, duplicates excluded.
 */
export function onePerPick(rows: readonly WhatIfBet[]): WhatIfBet[] {
  const best = new Map<string, WhatIfBet>();
  for (const row of rows) {
    const key = `${row.event_id}|${row.market_key}|${row.selection}`;
    const held = best.get(key);
    if (
      !held ||
      row.price_decimal > held.price_decimal ||
      (row.price_decimal === held.price_decimal && (row.detected_at ?? '') < (held.detected_at ?? ''))
    ) {
      best.set(key, row);
    }
  }
  return [...best.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function passes(row: WhatIfBet, filters: Filters): boolean {
  if (filters.excludedSports.has(row.sport_key)) return false;
  if (filters.excludedMarkets.has(row.market_key)) return false;
  if (filters.maxPrice !== null && row.price_decimal > filters.maxPrice) return false;
  if (filters.minEdgePct !== null && (row.edge_pct ?? -Infinity) < filters.minEdgePct) return false;
  if (filters.since !== null && row.starts_at < filters.since) return false;
  return true;
}

export function price(row: WhatIfBet, filters: Filters): PricedBet {
  const ledger = filters.staking === 'ledger' && row.stake_cents != null;
  const stakeCents = ledger ? (row.stake_cents as number) : filters.flatCents;
  const settled = row.outcome === 'win' || row.outcome === 'loss';
  const pnlCents = ledger
    ? (row.pnl_cents ?? 0)
    : row.outcome === 'win'
      ? Math.round(stakeCents * (row.price_decimal - 1))
      : row.outcome === 'loss'
        ? -stakeCents
        : 0;
  if (!settled) return { row, stakeCents, pnlCents, expectedCents: 0, variance: 0, p: null };
  const clv = row.clv_pct / 100;
  const p = Math.min(P_CEILING, Math.max(P_FLOOR, (1 + clv) / row.price_decimal));
  return {
    row,
    stakeCents,
    pnlCents,
    expectedCents: stakeCents * clv,
    variance: p * (1 - p) * (stakeCents * row.price_decimal) ** 2,
    p,
  };
}

/** The edge `detector` judged this row by, or `null` if it never measured one.
 *  Rows from before 2026-11-22 carry only `edge_pct`, which was the consensus. */
export function edgeFor(row: WhatIfBet, detector: Detector): number | null {
  if (detector === 'pinnacle') return row.sharp_edge_pct ?? null;
  if (detector === 'consensus') return row.consensus_edge_pct ?? (row.shadow ? null : (row.edge_pct ?? null));
  return row.edge_pct ?? null;
}

/** The opportunity set as `detector` would have found it, each row's
 *  `edge_pct` replaced by that detector's edge so every later filter and
 *  breakdown reads it. */
export function asDetector(rows: readonly WhatIfBet[], detector: Detector): WhatIfBet[] {
  if (detector === 'as-run') return rows.filter((row) => !row.shadow);
  return rows
    .map((row) => ({ ...row, edge_pct: edgeFor(row, detector) }))
    .filter((row) => row.edge_pct !== null && (row.edge_pct as number) >= DETECTOR_THRESHOLD_PCT);
}

export function select(rows: readonly WhatIfBet[], filters: Filters): PricedBet[] {
  const base =
    filters.set === 'opportunities'
      ? onePerPick(asDetector(rows, filters.detector ?? 'as-run'))
      : [...rows];
  return base.filter((row) => passes(row, filters)).map((row) => price(row, filters));
}

const mean = (xs: readonly number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function stats(bets: readonly PricedBet[]): Stats {
  let stakedCents = 0, pnlCents = 0, expectedCents = 0, variance = 0, wins = 0, expectedWins = 0, settled = 0;
  for (const bet of bets) {
    stakedCents += bet.stakeCents;
    pnlCents += bet.pnlCents;
    expectedCents += bet.expectedCents;
    variance += bet.variance;
    if (bet.p !== null) {
      settled += 1;
      expectedWins += bet.p;
      if (bet.row.outcome === 'win') wins += 1;
    }
  }
  const sdCents = Math.sqrt(variance);
  const sharp = bets.map((b) => b.row.clv_sharp_pct).filter((x): x is number => x != null);
  return {
    bets: bets.length,
    settled,
    wins,
    expectedWins,
    stakedCents,
    pnlCents,
    expectedCents,
    sdCents,
    roi: stakedCents ? pnlCents / stakedCents : null,
    meanClvPct: mean(bets.map((b) => b.row.clv_pct)),
    sharpCount: sharp.length,
    meanSharpClvPct: mean(sharp),
    z: sdCents > 0 ? (pnlCents - expectedCents) / sdCents : null,
  };
}

/** How the result sits against luck alone, in words the page can print. */
export function verdict(s: Stats): Verdict {
  if (s.z === null) return 'none';
  if (s.z <= -2) return 'below';
  if (s.z >= 2) return 'above';
  if (s.z <= -1) return 'unlucky';
  if (s.z >= 1) return 'lucky';
  return 'within';
}

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  none: 'Too few bets to say',
  within: 'Within normal luck',
  unlucky: 'Unlucky, still within luck',
  lucky: 'Lucky, still within luck',
  below: 'Worse than luck explains',
  above: 'Better than luck explains',
};

/**
 * Of runs where every bet wins with exactly its closing-line probability, the
 * share that end at or below this P&L. Seeded, so the figure is stable between
 * renders of the same view. `null` with nothing settled.
 */
export function chanceThisBad(bets: readonly PricedBet[], runs = 4000): number | null {
  const live = bets.filter((b) => b.p !== null);
  if (!live.length) return null;
  const actual = live.reduce((sum, b) => sum + b.pnlCents, 0);
  let seed = 0x2545f491;
  const random = () => {
    // xorshift32: fast, and plenty for a share to the nearest percent.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  let worse = 0;
  for (let run = 0; run < runs; run++) {
    let total = 0;
    for (const bet of live) {
      total += random() < (bet.p as number) ? bet.stakeCents * (bet.row.price_decimal - 1) : -bet.stakeCents;
    }
    if (total <= actual + 0.5) worse += 1;
  }
  return worse / runs;
}

export interface Point {
  readonly index: number;
  readonly bet: PricedBet;
  readonly actualCents: number;
  readonly expectedCents: number;
  readonly sdCents: number;
}

/** The running totals the chart draws, one point per bet in start order. */
export function running(bets: readonly PricedBet[]): Point[] {
  let actual = 0, expected = 0, variance = 0;
  return bets.map((bet, index) => {
    actual += bet.pnlCents;
    expected += bet.expectedCents;
    variance += bet.variance;
    return { index: index + 1, bet, actualCents: actual, expectedCents: expected, sdCents: Math.sqrt(variance) };
  });
}

// ---- breakdowns -------------------------------------------------------------

export type Dimension = 'sport' | 'odds' | 'edge' | 'market' | 'book';

export interface Band {
  readonly key: string;
  readonly label: string;
  readonly test: (row: WhatIfBet) => boolean;
}

/** Decimal-price bands, the T4.4a report's, with the American odds a bettor reads. */
export const ODDS_BANDS: readonly Band[] = [
  { key: 'fav', label: 'Favourites (under +100)', test: (r) => r.price_decimal < 2 },
  { key: '2-3', label: '+100 to +200', test: (r) => r.price_decimal >= 2 && r.price_decimal < 3 },
  { key: '3-5', label: '+200 to +400', test: (r) => r.price_decimal >= 3 && r.price_decimal < 5 },
  { key: '5-10', label: '+400 to +900', test: (r) => r.price_decimal >= 5 && r.price_decimal < 10 },
  { key: '10+', label: '+900 and longer', test: (r) => r.price_decimal >= 10 },
];

export const EDGE_BANDS: readonly Band[] = [
  { key: '<3', label: 'Under 3%', test: (r) => (r.edge_pct ?? 0) < 3 },
  { key: '3-5', label: '3% to 5%', test: (r) => (r.edge_pct ?? 0) >= 3 && (r.edge_pct ?? 0) < 5 },
  { key: '5-10', label: '5% to 10%', test: (r) => (r.edge_pct ?? 0) >= 5 && (r.edge_pct ?? 0) < 10 },
  { key: '10+', label: '10% and over', test: (r) => (r.edge_pct ?? 0) >= 10 },
];

export interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly stats: Stats;
}

/** The current view split one way. Groups with no bets are dropped, and groups
 *  keyed by value (sport, market, book) are ordered by how many bets they hold. */
export function breakdown(
  bets: readonly PricedBet[],
  dimension: Dimension,
  label: (dimension: Dimension, key: string) => string,
): BreakdownRow[] {
  const bands = dimension === 'odds' ? ODDS_BANDS : dimension === 'edge' ? EDGE_BANDS : null;
  if (bands) {
    return bands
      .map((band) => ({ key: band.key, label: band.label, stats: stats(bets.filter((b) => band.test(b.row))) }))
      .filter((row) => row.stats.bets > 0);
  }
  const field = dimension === 'sport' ? 'sport_key' : dimension === 'market' ? 'market_key' : 'book_key';
  const groups = new Map<string, PricedBet[]>();
  for (const bet of bets) {
    const key = bet.row[field];
    groups.set(key, [...(groups.get(key) ?? []), bet]);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: label(dimension, key), stats: stats(group) }))
    .sort((a, b) => b.stats.bets - a.stats.bets);
}

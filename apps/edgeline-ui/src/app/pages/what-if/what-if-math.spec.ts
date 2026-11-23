/**
 * The What-if arithmetic on numbers small enough to check by hand.
 */

import type { WhatIfBet } from '@metrum/edgeline-api-client';

import {
  breakdown,
  chanceThisBad,
  onePerPick,
  running,
  select,
  stats,
  verdict,
  type Filters,
} from './what-if-math';

function bet(overrides: Partial<WhatIfBet> = {}): WhatIfBet {
  return {
    id: 'b', sport_key: 'americanfootball_ncaaf', event_id: 'g1', market_key: 'h2h',
    selection: 'Owls', book_key: 'fanduel', price_decimal: 5, edge_pct: 6, clv_pct: 10,
    outcome: 'loss', starts_at: '2026-11-07T17:00:00Z', detected_at: '2026-11-07T12:00:00Z',
    recommended: false, ...overrides,
  };
}

const ALL: Filters = {
  set: 'opportunities', staking: 'flat', flatCents: 1000, excludedSports: new Set(),
  excludedMarkets: new Set(), maxPrice: null, minEdgePct: null, since: null,
};

describe('What-if arithmetic', () => {
  it('prices a flat bet: expected = stake x CLV, win probability (1 + CLV) / price', () => {
    // $10 at 5.0 with CLV +10%: expected +$1, p = 1.1 / 5 = 0.22.
    const [priced] = select([bet()], ALL);
    expect(priced.expectedCents).toBeCloseTo(100);
    expect(priced.p).toBeCloseTo(0.22);
    expect(priced.pnlCents).toBe(-1000);
    // Variance p(1-p)(stake x price)^2 = 0.22 x 0.78 x 5000^2.
    expect(priced.variance).toBeCloseTo(0.22 * 0.78 * 5000 ** 2);
    const won = select([bet({ outcome: 'win' })], ALL)[0];
    expect(won.pnlCents).toBe(4000);
  });

  it('uses the paper ledger’s own stake and P&L when staking as staked', () => {
    const row = bet({ stake_cents: 300, pnl_cents: -300 });
    const [priced] = select([row], { ...ALL, set: 'paper', staking: 'ledger' });
    expect(priced.stakeCents).toBe(300);
    expect(priced.pnlCents).toBe(-300);
    expect(priced.expectedCents).toBeCloseTo(30);
  });

  it('counts a pick once, at its best price, however many books offered it', () => {
    const picks = onePerPick([
      bet({ id: 'a', price_decimal: 4.8 }),
      bet({ id: 'b', price_decimal: 5.0, detected_at: '2026-11-07T13:00:00Z' }),
      bet({ id: 'c', price_decimal: 5.0, detected_at: '2026-11-07T12:30:00Z' }),
      bet({ id: 'd', selection: 'Tigers' }),
    ]);
    expect(picks.map((p) => p.id).sort()).toEqual(['c', 'd']);
    // The paper set is never collapsed: each row is its own recommendation.
    expect(select([bet({ id: 'a' }), bet({ id: 'b' })], { ...ALL, set: 'paper' })).toHaveLength(2);
  });

  it('filters by sport, market, longest odds, edge and start date', () => {
    const rows = [
      bet({ id: 'nba', event_id: 'n', sport_key: 'basketball_nba' }),
      bet({ id: 'long', event_id: 'l', price_decimal: 11 }),
      bet({ id: 'small', event_id: 's', edge_pct: 2 }),
      bet({ id: 'spread', event_id: 'p', market_key: 'spreads' }),
      bet({ id: 'old', event_id: 'o', starts_at: '2026-10-01T17:00:00Z' }),
      bet({ id: 'keep', event_id: 'k' }),
    ];
    const kept = select(rows, {
      ...ALL, excludedSports: new Set(['basketball_nba']), excludedMarkets: new Set(['spreads']),
      maxPrice: 10, minEdgePct: 3, since: '2026-11-04T12:00:00Z',
    });
    expect(kept.map((b) => b.row.id)).toEqual(['keep']);
  });

  it('totals a view and judges it against luck', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      bet({ id: `b${i}`, event_id: `g${i}`, outcome: i < 4 ? 'win' : 'loss' }),
    );
    const s = stats(select(rows, ALL));
    // 4 wins x $40 - 16 losses x $10 = 0, against +$20 expected.
    expect(s.pnlCents).toBe(0);
    expect(s.expectedCents).toBeCloseTo(2000);
    expect(s.expectedWins).toBeCloseTo(4.4);
    expect(s.sdCents).toBeCloseTo(Math.sqrt(20 * 0.22 * 0.78 * 5000 ** 2));
    expect(verdict(s)).toBe('within'); // -$20 against a $92.63 sd
    // Twenty straight losses is -$200, (-200 - 20) / 92.63 = -2.4 sd: more than
    // luck explains. Two wins (+$80 - $180 = -$100) is -1.3 sd: unlucky.
    const cold = stats(select(rows.map((r) => ({ ...r, outcome: 'loss' })), ALL));
    expect(verdict(cold)).toBe('below');
    const cool = stats(select(rows.map((r, i) => ({ ...r, outcome: i < 2 ? 'win' : 'loss' })), ALL));
    expect(verdict(cool)).toBe('unlucky');
  });

  it('says how often a fair run ends this low, and is stable between renders', () => {
    const rows = Array.from({ length: 10 }, (_, i) => bet({ id: `b${i}`, event_id: `g${i}` }));
    const priced = select(rows, ALL);
    // Ten straight losses at p = 0.22 each: 0.78^10, about 8%.
    const chance = chanceThisBad(priced, 20_000) as number;
    expect(chance).toBeGreaterThan(0.06);
    expect(chance).toBeLessThan(0.11);
    expect(chanceThisBad(priced, 20_000)).toBe(chance);
    expect(chanceThisBad([])).toBeNull();
  });

  it('judges the opportunity set as either detector would have found it', () => {
    const rows = [
      // Found by the consensus, Pinnacle disagrees.
      bet({ id: 'c', event_id: 'c', edge_pct: 5, consensus_edge_pct: 5, sharp_edge_pct: 1 }),
      // A shadow: only Pinnacle liked it.
      bet({ id: 'p', event_id: 'p', edge_pct: 9, consensus_edge_pct: 2, sharp_edge_pct: 9, shadow: true }),
      // From before 2026-11-22: the consensus's, with no Pinnacle edge.
      bet({ id: 'old', event_id: 'old', edge_pct: 4 }),
    ];
    const ids = (detector: 'as-run' | 'consensus' | 'pinnacle') =>
      select(rows, { ...ALL, detector }).map((b) => b.row.id).sort();
    expect(ids('as-run')).toEqual(['c', 'old']);
    expect(ids('consensus')).toEqual(['c', 'old']);
    expect(ids('pinnacle')).toEqual(['p']);
    // The edge filter and bands read the chosen detector's edge.
    expect(select(rows, { ...ALL, detector: 'pinnacle', minEdgePct: 8 })[0].row.edge_pct).toBe(9);
    // The paper set is what was recommended, whatever the toggle says.
    expect(select(rows, { ...ALL, set: 'paper', detector: 'pinnacle' })).toHaveLength(3);
  });

  it('runs the totals in start order and breaks a view down', () => {
    const rows = [
      bet({ id: 'a', event_id: 'a', outcome: 'win', price_decimal: 2.5 }),
      bet({ id: 'b', event_id: 'b', sport_key: 'americanfootball_nfl', price_decimal: 12 }),
    ];
    const priced = select(rows, ALL);
    const points = running(priced);
    expect(points.map((p) => p.actualCents)).toEqual([1500, 500]);
    const odds = breakdown(priced, 'odds', (_d, k) => k);
    expect(odds.map((r) => r.key)).toEqual(['2-3', '10+']);
    const sports = breakdown(priced, 'sport', (_d, k) => k.toUpperCase());
    expect(sports.map((r) => r.stats.bets)).toEqual([1, 1]);
  });
});

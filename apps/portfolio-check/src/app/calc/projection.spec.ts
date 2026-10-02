import { compare, project } from './projection';
import type { FeeSchedule } from './fees';

const flat1pct: FeeSchedule = { kind: 'aum', method: 'tiered', minimumAnnual: 0, tiers: [{ upTo: null, rate: 0.01 }] };

describe('project', () => {
  it('compounds a percentage fee into the closed form', () => {
    // No contributions and one flat rate: B_n = B_0 × ((1 + g)(1 − fee))^n.
    const points = project({
      startBalance: 100_000,
      annualContribution: 0,
      years: 30,
      grossReturn: 0.06,
      fundEr: 0.005,
      schedule: flat1pct,
    });
    expect(points).toHaveLength(31);
    expect(points[30].balance).toBeCloseTo(100_000 * Math.pow(1.06 * (1 - 0.015), 30), 4);
  });

  it('loses about a quarter of the ending balance to 1% a year over 30 years', () => {
    // The claim the whole page rests on, checked: 1% vs ~0 at 6% gross.
    const withFee = project({ startBalance: 100_000, annualContribution: 0, years: 30, grossReturn: 0.06, fundEr: 0, schedule: flat1pct });
    const without = project({ startBalance: 100_000, annualContribution: 0, years: 30, grossReturn: 0.06, fundEr: 0, schedule: null });
    const lost = 1 - withFee[30].balance / without[30].balance;
    expect(lost).toBeGreaterThan(0.25);
    expect(lost).toBeLessThan(0.27);
  });

  it('adds contributions at year end and tracks cumulative costs', () => {
    const points = project({ startBalance: 0, annualContribution: 10_000, years: 2, grossReturn: 0.1, fundEr: 0.01, schedule: null });
    expect(points[1].balance).toBeCloseTo(10_000);
    // Year 2: 10,000 grows to 11,000, pays 110, then 10,000 more lands.
    expect(points[2].balance).toBeCloseTo(20_890);
    expect(points[2].costsPaid).toBeCloseTo(110);
  });
});

describe('compare', () => {
  const input = {
    startBalance: 500_000,
    annualContribution: 12_000,
    years: 25,
    grossReturn: 0.06,
    currentFundEr: 0.006,
    schedule: flat1pct,
    indexEr: 0.0004,
  };

  it('shows the gap growing from zero', () => {
    const result = compare(input);
    expect(result.gap[0]).toBe(0);
    expect(result.gap[25]).toBeGreaterThan(result.gap[10]);
    expect(result.gap[25]).toBeGreaterThan(0);
  });

  it('solves a break-even rate that closes the gap exactly', () => {
    const result = compare(input);
    // Close to the cost difference, slightly more because the fee also bills the extra.
    expect(result.breakEvenRate).toBeGreaterThan(0.0156);
    expect(result.breakEvenRate).toBeLessThan(0.0175);

    const lifted = compare({ ...input, grossReturn: input.grossReturn + result.breakEvenRate });
    expect(lifted.current[25].balance).toBeCloseTo(result.index[25].balance, -1);
  });

  it('needs no added value when costs are equal', () => {
    const result = compare({ ...input, schedule: { kind: 'flat', annual: 0 }, currentFundEr: input.indexEr });
    expect(result.breakEvenRate).toBeCloseTo(0, 6);
  });
});

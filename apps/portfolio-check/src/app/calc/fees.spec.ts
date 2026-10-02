import {
  advisoryFee,
  allInCost,
  indexCost,
  stockShare,
  valueByAccountType,
  weightedExpenseRatio,
  type FeeSchedule,
  type Holding,
} from './fees';

const schedule = (method: 'tiered' | 'whole-balance', minimumAnnual = 0): FeeSchedule => ({
  kind: 'aum',
  method,
  minimumAnnual,
  tiers: [
    { upTo: 500_000, rate: 0.01 },
    { upTo: 1_000_000, rate: 0.008 },
    { upTo: null, rate: 0.006 },
  ],
});

describe('advisoryFee', () => {
  it('bills each slice at its own rate on a tiered schedule', () => {
    expect(advisoryFee(schedule('tiered'), 400_000)).toBeCloseTo(4_000);
    expect(advisoryFee(schedule('tiered'), 600_000)).toBeCloseTo(5_000 + 800);
    expect(advisoryFee(schedule('tiered'), 1_500_000)).toBeCloseTo(5_000 + 4_000 + 3_000);
  });

  it('bills the whole balance at the landing tier on a whole-balance schedule', () => {
    expect(advisoryFee(schedule('whole-balance'), 600_000)).toBeCloseTo(4_800);
    expect(advisoryFee(schedule('whole-balance'), 500_000)).toBeCloseTo(5_000);
    expect(advisoryFee(schedule('whole-balance'), 1_500_000)).toBeCloseTo(9_000);
  });

  it('applies the minimum fee', () => {
    expect(advisoryFee(schedule('tiered', 2_500), 100_000)).toBe(2_500);
    expect(advisoryFee(schedule('tiered', 2_500), 400_000)).toBeCloseTo(4_000);
  });

  it('does not depend on the order tiers were entered in', () => {
    const shuffled: FeeSchedule = {
      kind: 'aum',
      method: 'tiered',
      minimumAnnual: 0,
      tiers: [
        { upTo: null, rate: 0.006 },
        { upTo: 500_000, rate: 0.01 },
        { upTo: 1_000_000, rate: 0.008 },
      ],
    };
    expect(advisoryFee(shuffled, 1_500_000)).toBeCloseTo(12_000);
  });

  it('bills past a capped last tier at that tier’s rate rather than for free', () => {
    const capped: FeeSchedule = { kind: 'aum', method: 'tiered', minimumAnnual: 0, tiers: [{ upTo: 100_000, rate: 0.01 }] };
    expect(advisoryFee(capped, 300_000)).toBeCloseTo(3_000);
  });

  it('charges a flat fee regardless of balance, and nothing on an empty account', () => {
    expect(advisoryFee({ kind: 'flat', annual: 3_000 }, 2_000_000)).toBe(3_000);
    expect(advisoryFee({ kind: 'flat', annual: 3_000 }, 0)).toBe(0);
  });
});

const holdings: Holding[] = [
  { ticker: 'A', value: 300_000, expenseRatio: 0.006, accountType: 'taxable', stockShare: 1 },
  { ticker: 'B', value: 100_000, expenseRatio: 0.002, accountType: 'ira', stockShare: 0 },
];

describe('portfolio aggregates', () => {
  it('weights the expense ratio and stock share by value', () => {
    expect(weightedExpenseRatio(holdings)).toBeCloseTo(0.005);
    expect(stockShare(holdings)).toBeCloseTo(0.75);
  });

  it('is zero, not NaN, on an empty portfolio', () => {
    expect(weightedExpenseRatio([])).toBe(0);
    expect(stockShare([])).toBe(0);
  });

  it('totals value by account type', () => {
    expect(valueByAccountType(holdings)).toEqual({ taxable: 300_000, ira: 100_000, roth: 0, '401k': 0 });
  });
});

describe('allInCost', () => {
  it('adds the advisory fee to fund expenses', () => {
    const cost = allInCost(holdings, schedule('tiered'));
    expect(cost.advisoryFee).toBeCloseTo(4_000);
    expect(cost.fundExpenses).toBeCloseTo(2_000);
    expect(cost.total).toBeCloseTo(6_000);
    expect(cost.totalRate).toBeCloseTo(0.015);
  });

  it('prices the index alternative from the stock/bond mix', () => {
    const cost = indexCost(400_000, 0.75, { stockIndexEr: 0.0003, bondIndexEr: 0.0005 });
    expect(cost.fundRate).toBeCloseTo(0.00035);
    expect(cost.total).toBeCloseTo(140);
    expect(cost.advisoryFee).toBe(0);
  });
});

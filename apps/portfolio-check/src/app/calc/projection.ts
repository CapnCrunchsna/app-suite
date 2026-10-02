import { advisoryFee, type FeeSchedule } from './fees';

/**
 * Year-by-year growth of one balance under one cost structure.
 *
 * The model, kept deliberately simple so it can be checked by hand:
 *
 *   grown   = balance × (1 + grossReturn)
 *   cost    = grown × fundEr + advisoryFee(grown)
 *   balance = grown − cost + annualContribution
 *
 * Costs are taken on the year-end value, which is roughly how quarterly billing in
 * arrears and daily fund expense accrual net out over a year. Contributions land at
 * year end. Both scenarios get the *same* gross return — the point is to isolate
 * cost, not to forecast markets.
 */
export interface ProjectionInput {
  readonly startBalance: number;
  readonly annualContribution: number;
  readonly years: number;
  readonly grossReturn: number;
  readonly fundEr: number;
  /** Null for a self-managed portfolio. */
  readonly schedule: FeeSchedule | null;
}

export interface YearPoint {
  readonly year: number;
  readonly balance: number;
  /** Cumulative dollars paid in fees and fund expenses through this year. */
  readonly costsPaid: number;
}

export function project(input: ProjectionInput): YearPoint[] {
  const points: YearPoint[] = [{ year: 0, balance: input.startBalance, costsPaid: 0 }];
  let balance = input.startBalance;
  let costsPaid = 0;
  for (let year = 1; year <= input.years; year++) {
    const grown = balance * (1 + input.grossReturn);
    const cost = grown * input.fundEr + (input.schedule ? advisoryFee(input.schedule, grown) : 0);
    balance = grown - cost + input.annualContribution;
    costsPaid += cost;
    points.push({ year, balance, costsPaid });
  }
  return points;
}

export interface ComparisonInput {
  readonly startBalance: number;
  readonly annualContribution: number;
  readonly years: number;
  readonly grossReturn: number;
  readonly currentFundEr: number;
  readonly schedule: FeeSchedule;
  readonly indexEr: number;
}

export interface Comparison {
  readonly current: YearPoint[];
  readonly index: YearPoint[];
  /** Index balance minus current balance, per year. Positive = index ahead. */
  readonly gap: number[];
  /**
   * Extra return per year (fraction) the current setup must earn, on top of the
   * shared gross return, to finish level with the index portfolio. This is the
   * break-even "value added" — tax savings, avoided mistakes, better returns —
   * expressed as a rate.
   */
  readonly breakEvenRate: number;
}

function endBalance(input: ComparisonInput, extraReturn: number): number {
  const points = project({
    startBalance: input.startBalance,
    annualContribution: input.annualContribution,
    years: input.years,
    grossReturn: input.grossReturn + extraReturn,
    fundEr: input.currentFundEr,
    schedule: input.schedule,
  });
  return points[points.length - 1].balance;
}

/**
 * Solve for the extra return that closes the gap. Bisection, because a tiered
 * schedule makes the fee a step-wise function of balance and there is no closed
 * form; the ending balance is still monotone in the return, which is all
 * bisection needs.
 */
export function breakEvenRate(input: ComparisonInput, target: number): number {
  if (input.years <= 0 || input.startBalance + input.annualContribution <= 0) return 0;
  let lo = -0.2;
  let hi = 0.2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (endBalance(input, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function compare(input: ComparisonInput): Comparison {
  const current = project({
    startBalance: input.startBalance,
    annualContribution: input.annualContribution,
    years: input.years,
    grossReturn: input.grossReturn,
    fundEr: input.currentFundEr,
    schedule: input.schedule,
  });
  const index = project({
    startBalance: input.startBalance,
    annualContribution: input.annualContribution,
    years: input.years,
    grossReturn: input.grossReturn,
    fundEr: input.indexEr,
    schedule: null,
  });
  const gap = index.map((p, i) => p.balance - current[i].balance);
  const target = index[index.length - 1].balance;
  return { current, index, gap, breakEvenRate: breakEvenRate(input, target) };
}

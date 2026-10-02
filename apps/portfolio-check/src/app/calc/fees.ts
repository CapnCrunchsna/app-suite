/**
 * What the current setup costs per year, in dollars and as a share of assets.
 *
 * Every rate in this folder is a **fraction** (0.01 is 1%). The UI holds percents,
 * because that is how fee schedules and fund pages print them, and converts once
 * at the boundary in `inputs.ts`.
 */

export type AccountType = 'taxable' | 'ira' | 'roth' | '401k';

export interface Holding {
  readonly ticker: string;
  readonly value: number;
  /** Fund expense ratio, as a fraction. */
  readonly expenseRatio: number;
  readonly accountType: AccountType;
  /** Share of this holding that is stocks, 0..1. A 60/40 balanced fund is 0.6. */
  readonly stockShare: number;
}

/** One AUM breakpoint: `rate` applies up to `upTo` dollars; `null` is "and above". */
export interface FeeTier {
  readonly upTo: number | null;
  readonly rate: number;
}

/**
 * The two AUM conventions advisors actually use, and they differ by real money:
 *
 * - `tiered` — each slice of the balance pays its own tier's rate, like tax
 *   brackets. $600k on 1% to $500k / 0.8% above is $5,000 + $800.
 * - `whole-balance` — the entire balance pays the rate of the tier it lands in.
 *   The same $600k pays 0.8% of all of it, $4,800.
 *
 * Form ADV Part 2A says which one applies; the checklist asks for it.
 */
export type FeeSchedule =
  | {
      readonly kind: 'aum';
      readonly method: 'tiered' | 'whole-balance';
      readonly tiers: readonly FeeTier[];
      /** Many advisors bill at least this much a year regardless of balance. */
      readonly minimumAnnual: number;
    }
  | { readonly kind: 'flat'; readonly annual: number };

function sortedTiers(tiers: readonly FeeTier[]): FeeTier[] {
  // `null` ("and above") sorts last; a schedule entered out of order still bills right.
  return [...tiers].sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
}

/** The advisory fee, in dollars per year, on `balance`. */
export function advisoryFee(schedule: FeeSchedule, balance: number): number {
  if (balance <= 0) return 0;
  if (schedule.kind === 'flat') return schedule.annual;

  const tiers = sortedTiers(schedule.tiers);
  if (tiers.length === 0) return schedule.minimumAnnual;

  let fee = 0;
  if (schedule.method === 'tiered') {
    let floor = 0;
    for (const tier of tiers) {
      const ceiling = tier.upTo ?? Infinity;
      const slice = Math.min(balance, ceiling) - floor;
      if (slice <= 0) break;
      fee += slice * tier.rate;
      floor = ceiling;
    }
    // A schedule whose last tier has a ceiling bills the excess at that last rate
    // rather than for free — the generous reading would understate the cost.
    if (balance > floor) fee += (balance - floor) * tiers[tiers.length - 1].rate;
  } else {
    const tier = tiers.find((t) => t.upTo === null || balance <= t.upTo) ?? tiers[tiers.length - 1];
    fee = balance * tier.rate;
  }
  return Math.max(fee, schedule.minimumAnnual);
}

export function totalValue(holdings: readonly Holding[]): number {
  return holdings.reduce((sum, h) => sum + h.value, 0);
}

/** Value-weighted fund expense ratio across all holdings. */
export function weightedExpenseRatio(holdings: readonly Holding[]): number {
  const total = totalValue(holdings);
  if (total <= 0) return 0;
  return holdings.reduce((sum, h) => sum + h.value * h.expenseRatio, 0) / total;
}

/** Value-weighted stock share — what the matched index portfolio copies. */
export function stockShare(holdings: readonly Holding[]): number {
  const total = totalValue(holdings);
  if (total <= 0) return 0;
  return holdings.reduce((sum, h) => sum + h.value * h.stockShare, 0) / total;
}

export function valueByAccountType(holdings: readonly Holding[]): Record<AccountType, number> {
  const out: Record<AccountType, number> = { taxable: 0, ira: 0, roth: 0, '401k': 0 };
  for (const h of holdings) out[h.accountType] += h.value;
  return out;
}

export interface CostBreakdown {
  readonly balance: number;
  readonly advisoryFee: number;
  readonly fundExpenses: number;
  readonly total: number;
  /** Each as a fraction of `balance`. */
  readonly advisoryRate: number;
  readonly fundRate: number;
  readonly totalRate: number;
}

function breakdown(balance: number, advisory: number, fundRate: number): CostBreakdown {
  const fundExpenses = balance * fundRate;
  const total = advisory + fundExpenses;
  const rate = (x: number) => (balance > 0 ? x / balance : 0);
  return {
    balance,
    advisoryFee: advisory,
    fundExpenses,
    total,
    advisoryRate: rate(advisory),
    fundRate,
    totalRate: rate(total),
  };
}

/** All-in annual cost today: the advisory fee plus what the funds charge. */
export function allInCost(holdings: readonly Holding[], schedule: FeeSchedule): CostBreakdown {
  const balance = totalValue(holdings);
  return breakdown(balance, advisoryFee(schedule, balance), weightedExpenseRatio(holdings));
}

/** The comparison portfolio's assumed fund costs: a stock index fund and a bond index fund. */
export interface IndexAssumptions {
  readonly stockIndexEr: number;
  readonly bondIndexEr: number;
}

/** Expense ratio of a two-fund index portfolio holding `share` in stocks. */
export function indexExpenseRatio(share: number, a: IndexAssumptions): number {
  return share * a.stockIndexEr + (1 - share) * a.bondIndexEr;
}

/** The same balance, self-managed in index funds: no advisory fee. */
export function indexCost(balance: number, share: number, a: IndexAssumptions): CostBreakdown {
  return breakdown(balance, 0, indexExpenseRatio(share, a));
}

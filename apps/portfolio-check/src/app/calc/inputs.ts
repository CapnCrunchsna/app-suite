import type { AccountType, FeeSchedule, Holding, IndexAssumptions } from './fees';
import type { BenchmarkYear, HistoryYear } from './history';

/**
 * Everything the page asks for, in the units people read off statements and fee
 * schedules: dollars and **percents**. `toCalc*` converts to the fractions the
 * calc functions take — the only place that division by 100 happens.
 *
 * This whole object is what gets saved to localStorage, and nowhere else.
 */
export interface HoldingInput {
  ticker: string;
  description: string;
  value: number;
  expenseRatioPct: number | null;
  accountType: AccountType;
  stockPct: number;
}

export interface TierInput {
  /** Null on the last tier: "and above". */
  upTo: number | null;
  ratePct: number;
}

export interface FeeInput {
  kind: 'aum' | 'flat';
  method: 'tiered' | 'whole-balance';
  tiers: TierInput[];
  minimumAnnual: number;
  flatAnnual: number;
}

export interface BenchmarkInput {
  year: number;
  stockPct: number;
  bondPct: number;
}

export interface Inputs {
  holdings: HoldingInput[];
  fee: FeeInput;
  horizonYears: number;
  annualContribution: number;
  grossReturnPct: number;
  stockIndexErPct: number;
  bondIndexErPct: number;
  history: HistoryYear[];
  benchmarks: BenchmarkInput[];
}

const pct = (n: number | null | undefined) => (Number.isFinite(n) ? (n as number) / 100 : 0);
const num = (n: number | null | undefined) => (Number.isFinite(n) ? (n as number) : 0);

export function toCalcHoldings(holdings: readonly HoldingInput[]): Holding[] {
  return holdings.map((h) => ({
    ticker: h.ticker,
    value: num(h.value),
    expenseRatio: pct(h.expenseRatioPct),
    accountType: h.accountType,
    stockShare: Math.min(1, Math.max(0, pct(h.stockPct))),
  }));
}

export function toCalcSchedule(fee: FeeInput): FeeSchedule {
  if (fee.kind === 'flat') return { kind: 'flat', annual: num(fee.flatAnnual) };
  return {
    kind: 'aum',
    method: fee.method,
    tiers: fee.tiers.map((t) => ({ upTo: Number.isFinite(t.upTo) ? t.upTo : null, rate: pct(t.ratePct) })),
    minimumAnnual: num(fee.minimumAnnual),
  };
}

export function toCalcIndex(inputs: Inputs): IndexAssumptions {
  return { stockIndexEr: pct(inputs.stockIndexErPct), bondIndexEr: pct(inputs.bondIndexErPct) };
}

export function toCalcBenchmarks(rows: readonly BenchmarkInput[]): BenchmarkYear[] {
  return rows
    .filter((b) => Number.isFinite(b.year) && Number.isFinite(b.stockPct) && Number.isFinite(b.bondPct))
    .map((b) => ({ year: b.year, stock: pct(b.stockPct), bond: pct(b.bondPct) }));
}

/**
 * Calendar-year total returns, in percent: S&P 500 for stocks, the Bloomberg US
 * Aggregate for bonds — the indexes the cheapest S&P 500 and total-bond funds
 * track. Approximate, editable on the page, and worth checking against a source
 * you trust before relying on the look-back; 2025 especially.
 */
export const DEFAULT_BENCHMARKS: BenchmarkInput[] = [
  { year: 2015, stockPct: 1.38, bondPct: 0.55 },
  { year: 2016, stockPct: 11.96, bondPct: 2.65 },
  { year: 2017, stockPct: 21.83, bondPct: 3.54 },
  { year: 2018, stockPct: -4.38, bondPct: 0.01 },
  { year: 2019, stockPct: 31.49, bondPct: 8.72 },
  { year: 2020, stockPct: 18.4, bondPct: 7.51 },
  { year: 2021, stockPct: 28.71, bondPct: -1.54 },
  { year: 2022, stockPct: -18.11, bondPct: -13.01 },
  { year: 2023, stockPct: 26.29, bondPct: 5.53 },
  { year: 2024, stockPct: 25.02, bondPct: 1.25 },
  { year: 2025, stockPct: 17.88, bondPct: 7.3 },
];

export function emptyInputs(): Inputs {
  return {
    holdings: [],
    fee: {
      kind: 'aum',
      method: 'tiered',
      tiers: [
        { upTo: 1_000_000, ratePct: 1 },
        { upTo: null, ratePct: 0.75 },
      ],
      minimumAnnual: 0,
      flatAnnual: 0,
    },
    horizonYears: 25,
    annualContribution: 0,
    grossReturnPct: 6,
    stockIndexErPct: 0.03,
    bondIndexErPct: 0.04,
    history: [],
    benchmarks: DEFAULT_BENCHMARKS.map((b) => ({ ...b })),
  };
}

/**
 * Made-up sample data — fictional tickers, round numbers, no relation to any real
 * account. It exists so the page shows something the first time it opens and so
 * the tests have a fixture; real numbers never live in the repo.
 */
export function sampleInputs(): Inputs {
  return {
    ...emptyInputs(),
    holdings: [
      { ticker: 'GRWA', description: 'Sample Growth Fund A', value: 180_000, expenseRatioPct: 0.62, accountType: 'taxable', stockPct: 100 },
      { ticker: 'INCB', description: 'Sample Income Builder', value: 95_000, expenseRatioPct: 0.58, accountType: 'taxable', stockPct: 60 },
      { ticker: 'CASHX', description: 'Sample money market', value: 15_000, expenseRatioPct: 0.3, accountType: 'taxable', stockPct: 0 },
      { ticker: 'BDFX', description: 'Sample Core Bond', value: 120_000, expenseRatioPct: 0.45, accountType: 'ira', stockPct: 0 },
      { ticker: 'INTLE', description: 'Sample International Equity', value: 85_000, expenseRatioPct: 0.83, accountType: 'ira', stockPct: 100 },
      { ticker: 'LGCP', description: 'Sample Large Cap Index', value: 60_000, expenseRatioPct: 0.12, accountType: 'roth', stockPct: 100 },
    ],
    fee: {
      kind: 'aum',
      method: 'tiered',
      tiers: [
        { upTo: 500_000, ratePct: 1 },
        { upTo: 1_000_000, ratePct: 0.85 },
        { upTo: null, ratePct: 0.65 },
      ],
      minimumAnnual: 0,
      flatAnnual: 0,
    },
    annualContribution: 12_000,
    history: [
      { year: 2021, startValue: 410_000, netContributions: 12_000, endValue: 470_500 },
      { year: 2022, startValue: 470_500, netContributions: 12_000, endValue: 396_000 },
      { year: 2023, startValue: 396_000, netContributions: 12_000, endValue: 455_000 },
      { year: 2024, startValue: 455_000, netContributions: 12_000, endValue: 512_000 },
      { year: 2025, startValue: 512_000, netContributions: 12_000, endValue: 555_000 },
    ],
  };
}

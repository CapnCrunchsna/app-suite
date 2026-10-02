/**
 * The look back: what the account actually returned, year by year, against a
 * two-fund index portfolio with the same stock/bond mix over the same years.
 *
 * Statement values are the input, so the account's return is already net of
 * everything deducted *from the account* — fund expenses always, the advisory
 * fee only when it is billed to the account. A fee paid by check is not in these
 * numbers, and the page says so.
 */
export interface HistoryYear {
  readonly year: number;
  readonly startValue: number;
  /** Deposits minus withdrawals during the year. */
  readonly netContributions: number;
  readonly endValue: number;
}

/** Calendar-year total returns, as fractions, for the two benchmark sleeves. */
export interface BenchmarkYear {
  readonly year: number;
  readonly stock: number;
  readonly bond: number;
}

/**
 * Modified Dietz with mid-year cash flows: the standard way to get a return from
 * a start value, an end value and a net flow, without daily valuations.
 */
export function dietzReturn(y: HistoryYear): number {
  const base = y.startValue + y.netContributions / 2;
  if (base <= 0) return 0;
  return (y.endValue - y.startValue - y.netContributions) / base;
}

export function benchmarkReturn(b: BenchmarkYear, stockShare: number, er: number): number {
  return stockShare * b.stock + (1 - stockShare) * b.bond - er;
}

export interface HistoryRow {
  readonly year: number;
  readonly yourReturn: number;
  readonly benchmarkReturn: number;
}

export interface HistoricalCheck {
  readonly rows: HistoryRow[];
  /** Years entered with no benchmark return to compare against. */
  readonly missingYears: number[];
  readonly yourAnnualized: number;
  readonly benchmarkAnnualized: number;
  readonly actualEndValue: number;
  /**
   * What the benchmark would have ended at given the *same* starting value and the
   * same deposits and withdrawals — so the dollar difference is like for like.
   */
  readonly benchmarkEndValue: number;
}

function annualize(returns: number[]): number {
  if (returns.length === 0) return 0;
  const growth = returns.reduce((g, r) => g * (1 + r), 1);
  return Math.pow(growth, 1 / returns.length) - 1;
}

export function historicalCheck(
  years: readonly HistoryYear[],
  benchmarks: readonly BenchmarkYear[],
  stockShare: number,
  benchmarkEr: number,
): HistoricalCheck | null {
  const sorted = [...years].sort((a, b) => a.year - b.year);
  const byYear = new Map(benchmarks.map((b) => [b.year, b]));
  const usable = sorted.filter((y) => byYear.has(y.year));
  const missingYears = sorted.filter((y) => !byYear.has(y.year)).map((y) => y.year);
  if (usable.length === 0) return null;

  const rows = usable.map((y) => ({
    year: y.year,
    yourReturn: dietzReturn(y),
    benchmarkReturn: benchmarkReturn(byYear.get(y.year) as BenchmarkYear, stockShare, benchmarkEr),
  }));

  // Same Dietz convention in reverse: half the year's flow earns the year's return.
  let bench = usable[0].startValue;
  usable.forEach((y, i) => {
    const r = rows[i].benchmarkReturn;
    bench = (bench + y.netContributions / 2) * (1 + r) + y.netContributions / 2;
  });

  return {
    rows,
    missingYears,
    yourAnnualized: annualize(rows.map((r) => r.yourReturn)),
    benchmarkAnnualized: annualize(rows.map((r) => r.benchmarkReturn)),
    actualEndValue: usable[usable.length - 1].endValue,
    benchmarkEndValue: bench,
  };
}

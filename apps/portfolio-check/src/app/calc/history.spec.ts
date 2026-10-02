import { benchmarkReturn, dietzReturn, historicalCheck } from './history';

describe('dietzReturn', () => {
  it('is the plain return with no flows', () => {
    expect(dietzReturn({ year: 2024, startValue: 100_000, netContributions: 0, endValue: 110_000 })).toBeCloseTo(0.1);
  });

  it('does not count a deposit as a gain', () => {
    // 100k + 10k deposited mid-year, ends at 115k: 5k of gain on ~105k at work.
    expect(dietzReturn({ year: 2024, startValue: 100_000, netContributions: 10_000, endValue: 115_000 })).toBeCloseTo(
      5_000 / 105_000,
    );
  });
});

describe('benchmarkReturn', () => {
  it('blends the sleeves by stock share and subtracts fund costs', () => {
    expect(benchmarkReturn({ year: 2024, stock: 0.2, bond: 0.02 }, 0.6, 0.0004)).toBeCloseTo(0.128 - 0.0004);
  });
});

describe('historicalCheck', () => {
  const benchmarks = [
    { year: 2023, stock: 0.2, bond: 0.05 },
    { year: 2024, stock: 0.1, bond: 0.0 },
  ];

  it('returns null when no entered year has a benchmark', () => {
    expect(historicalCheck([{ year: 1999, startValue: 1, netContributions: 0, endValue: 1 }], benchmarks, 1, 0)).toBeNull();
  });

  it('replays the same flows through the benchmark and annualizes both', () => {
    const result = historicalCheck(
      [
        { year: 2024, startValue: 120_000, netContributions: 0, endValue: 126_000 },
        { year: 2023, startValue: 100_000, netContributions: 0, endValue: 120_000 },
        { year: 2030, startValue: 1, netContributions: 0, endValue: 1 },
      ],
      benchmarks,
      1,
      0,
    );
    expect(result).not.toBeNull();
    expect(result?.missingYears).toEqual([2030]);
    expect(result?.rows.map((r) => r.year)).toEqual([2023, 2024]);
    expect(result?.benchmarkEndValue).toBeCloseTo(100_000 * 1.2 * 1.1);
    expect(result?.actualEndValue).toBe(126_000);
    expect(result?.yourAnnualized).toBeCloseTo(Math.sqrt(1.26) - 1);
    expect(result?.benchmarkAnnualized).toBeCloseTo(Math.sqrt(1.32) - 1);
  });
});

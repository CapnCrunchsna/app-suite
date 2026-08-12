/**
 * §5.2 and §5.3, over literal arrays of transactions.
 *
 * Every case here is one the section argues for explicitly. The three that matter
 * most are the ones the design session got wrong and §5.2 corrects: a
 * subscription that changed price must be **one** series, two genuinely
 * concurrent subscriptions must be **two**, and the confidence formula has to be
 * able to reach the Low band at all.
 */

import { DEFAULT_CONFIG, resolveConfig } from './config.js';
import { analyzeRecurrence } from './recurrence.js';
import { bandFor } from './finding.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

let nextId = 0;

function charge(
  effectiveDate: string,
  amountCents: number,
  overrides: Partial<SnapshotTransaction> = {},
): SnapshotTransaction {
  nextId += 1;
  return {
    id: `t${nextId}`,
    accountId: 'a1',
    effectiveDate,
    amountCents,
    descriptionNormalized: 'NETFLIX',
    merchantId: 'netflix',
    categoryId: null,
    isPending: false,
    isInternalTransfer: false,
    isExcluded: false,
    refundPairId: null,
    transferPairId: null,
    ...overrides,
  };
}

/** Monthly charges on a fixed day, starting at `startMonth` of `year`. */
function monthly(
  count: number,
  amountCents: number,
  startMonth: number,
  { day = 5, year = 2025 }: { day?: number; year?: number } = {},
) {
  return Array.from({ length: count }, (_, index) => {
    const month = startMonth + index;
    const shiftedYear = year + Math.floor((month - 1) / 12);
    const shiftedMonth = ((month - 1) % 12) + 1;
    return charge(
      `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      amountCents,
    );
  });
}

function snapshotOf(
  transactions: readonly SnapshotTransaction[],
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    accounts: [
      {
        id: 'a1',
        displayName: 'Northgate Checking',
        institution: 'Northgate Bank',
        accountType: 'checking',
        last4: '4821',
        currency: 'USD',
        isActive: true,
        // Coverage ends just after the twelve monthly charges the helpers build,
        // because §5.2 measures liveness against this and not the clock — a
        // default that ran a year past the data would lapse every series in
        // every test and quietly make the active-series cases vacuous.
        coverage: [{ start: '2025-01-01', end: '2025-12-31' }],
      },
    ],
    transactions,
    merchants: [
      {
        id: 'netflix',
        canonicalName: 'NETFLIX',
        displayName: 'Netflix',
        isKnownSubscription: true,
        isTransferKind: false,
        overlapGroup: 'video_streaming',
      },
    ],
    categories: [],
    ...overrides,
  };
}

beforeEach(() => {
  nextId = 0;
});

describe('analyzeRecurrence', () => {
  it('finds a clean monthly subscription and its cadence', () => {
    const { series } = analyzeRecurrence(snapshotOf(monthly(12, -1549, 1)), DEFAULT_CONFIG);

    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      merchantId: 'netflix',
      accountId: 'a1',
      cadenceLabel: 'monthly',
      cadencesPerYear: 12,
      occurrenceCount: 12,
      amountCentsCurrent: 1549,
      basis: 'fitted',
    });
  });

  it('carries cadences_per_year on the series rather than leaving it to be recomputed', () => {
    // §5.2: stored on the series so §5.5's `delta × cadences_per_year` and the
    // Subscriptions page's annual totals cannot disagree.
    const { series } = analyzeRecurrence(snapshotOf(monthly(6, -999, 1)), DEFAULT_CONFIG);

    expect(series[0].cadencesPerYear).toBe(12);
  });

  describe('a subscription that changed price (§5.2 pass 2)', () => {
    /**
     * The design session's failure, stated in §5.2: Netflix at $8.99 and later
     * $15.49 falls into two amount clusters, so one subscription presents as two
     * series for the same merchant — which §5.4 then reports as an error at 0.85
     * confidence.
     */
    it('is one series, not two', () => {
      const transactions = [...monthly(8, -899, 1), ...monthly(8, -1549, 9)];
      const { series } = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);

      expect(series).toHaveLength(1);
      expect(series[0].occurrenceCount).toBe(16);
    });

    it('reports the change as a price step, which is what §5.5 reads', () => {
      const transactions = [...monthly(8, -899, 1), ...monthly(8, -1549, 9)];
      const { series } = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);

      expect(series[0].priceSteps).toHaveLength(1);
      expect(series[0].priceSteps[0]).toMatchObject({
        fromCents: 899,
        toCents: 1549,
        deltaCents: 650,
        confirmed: true,
      });
      expect(series[0].amountCentsFirst).toBe(899);
      expect(series[0].amountCentsCurrent).toBe(1549);
    });

    it('marks a step still on its first charge as unconfirmed rather than hiding it', () => {
      const transactions = [...monthly(8, -899, 1), ...monthly(1, -1549, 9)];
      const { series } = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);

      expect(series[0].priceSteps.at(-1)).toMatchObject({
        occurrencesAtNewPrice: 1,
        confirmed: false,
      });
    });
  });

  describe('genuine concurrency (§5.2 pass 3)', () => {
    /**
     * Two plans billing in the same months for the whole window — a personal plan
     * still running after a family plan started. These must stay separate, and
     * only these count as concurrent for §5.4's same-merchant multiplicity rule.
     */
    it('keeps interleaved series separate and links them as concurrent', () => {
      const personal = monthly(10, -999, 1);
      const family = monthly(10, -1999, 1, { day: 20 });

      const { series } = analyzeRecurrence(snapshotOf([...personal, ...family]), DEFAULT_CONFIG);

      expect(series).toHaveLength(2);
      expect(series[0].concurrentSeriesIds).toContain(series[1].id);
      expect(series[1].concurrentSeriesIds).toContain(series[0].id);
    });

    it('does not call a price change concurrent', () => {
      const transactions = [...monthly(8, -899, 1), ...monthly(8, -1549, 9)];
      const { series } = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);

      expect(series[0].concurrentSeriesIds).toEqual([]);
    });
  });

  describe('confidence (§5.2)', () => {
    /**
     * The whole point of §5.2's four corrections: the original formula could not
     * produce a Low band, so the band and the suppression threshold were dead
     * code and the bands communicated nothing.
     */
    it('puts a ragged three-occurrence series in the Low band', () => {
      // Ragged in both inputs the formula reads: the gaps drift (30 then 34
      // days) and the amount wobbles within one price step. Amounts stay inside
      // the clustering tolerance on purpose — a spread wide enough to split the
      // cluster would be testing pass 1 rather than the confidence formula.
      const transactions = [
        charge('2025-01-05', -1000),
        charge('2025-02-04', -1035),
        charge('2025-03-10', -965),
      ];
      const snapshot = snapshotOf(transactions, {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'SOMETHING',
            displayName: 'Something',
            isKnownSubscription: false,
            isTransferKind: false,
            overlapGroup: null,
          },
        ],
      });
      const { series } = analyzeRecurrence(snapshot, DEFAULT_CONFIG);

      expect(series).toHaveLength(1);
      expect(bandFor(series[0].confidence, DEFAULT_CONFIG)).toBe('low');
    });

    it('puts a clean twelve-occurrence series in the High band', () => {
      const { series } = analyzeRecurrence(snapshotOf(monthly(12, -1549, 1)), DEFAULT_CONFIG);

      expect(bandFor(series[0].confidence, DEFAULT_CONFIG)).toBe('high');
    });

    it('caps a three-occurrence series below High however clean it is', () => {
      const { series } = analyzeRecurrence(snapshotOf(monthly(3, -1549, 1)), DEFAULT_CONFIG);

      expect(series[0].confidence).toBeLessThanOrEqual(
        DEFAULT_CONFIG.recurrence.threeOccurrenceConfidenceCap,
      );
      expect(bandFor(series[0].confidence, DEFAULT_CONFIG)).not.toBe('high');
    });
  });

  describe('the annual exceptions (§5.2)', () => {
    it('accepts two charges a year apart, without the known-subscription flag', () => {
      const snapshot = snapshotOf([charge('2025-03-04', -9900), charge('2026-03-02', -9900)], {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'SOME ANNUAL THING',
            displayName: 'Some Annual Thing',
            isKnownSubscription: false,
            isTransferKind: false,
            overlapGroup: null,
          },
        ],
      });
      const { series } = analyzeRecurrence(snapshot, DEFAULT_CONFIG);

      expect(series).toHaveLength(1);
      expect(series[0]).toMatchObject({ cadenceLabel: 'annual', basis: 'annual_pair' });
      // "emit at Medium" — three years of statements before an annual
      // subscription is noticed is exactly how the forgettable ones stay hidden.
      expect(bandFor(series[0].confidence, DEFAULT_CONFIG)).toBe('medium');
    });

    it('reports a lone charge at a known-subscription merchant at Low', () => {
      const { series } = analyzeRecurrence(
        snapshotOf([charge('2025-03-04', -9900)]),
        DEFAULT_CONFIG,
      );

      expect(series).toHaveLength(1);
      expect(series[0].basis).toBe('single_charge');
      expect(bandFor(series[0].confidence, DEFAULT_CONFIG)).toBe('low');
    });

    it('claims nothing from a lone charge at an ordinary merchant', () => {
      const snapshot = snapshotOf([charge('2025-03-04', -9900)], {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'ONE OFF',
            displayName: 'One Off',
            isKnownSubscription: false,
            isTransferKind: false,
            overlapGroup: null,
          },
        ],
      });

      expect(analyzeRecurrence(snapshot, DEFAULT_CONFIG).series).toEqual([]);
    });
  });

  describe('liveness (§5.2, §7.2)', () => {
    /**
     * Measured against the account's own coverage end. Wall-clock time would mark
     * every series lapsed the moment imports fall behind, and the dataset maximum
     * would lapse every card subscription whenever checking is imported further.
     */
    it('is active while the account has recent coverage', () => {
      const snapshot = snapshotOf(monthly(6, -1549, 1), {
        accounts: [
          {
            id: 'a1',
            displayName: 'Northgate Checking',
            institution: null,
            accountType: 'checking',
            last4: null,
            currency: 'USD',
            isActive: true,
            coverage: [{ start: '2025-01-01', end: '2025-06-30' }],
          },
        ],
      });

      expect(analyzeRecurrence(snapshot, DEFAULT_CONFIG).series[0].status).toBe('active');
    });

    it('lapses once coverage runs well past the last charge', () => {
      const snapshot = snapshotOf(monthly(6, -1549, 1), {
        accounts: [
          {
            id: 'a1',
            displayName: 'Northgate Checking',
            institution: null,
            accountType: 'checking',
            last4: null,
            currency: 'USD',
            isActive: true,
            coverage: [{ start: '2025-01-01', end: '2025-12-31' }],
          },
        ],
      });

      expect(analyzeRecurrence(snapshot, DEFAULT_CONFIG).series[0].status).toBe('lapsed');
    });

    it('does not lapse a series in an account with no statements at all', () => {
      const snapshot = snapshotOf(monthly(6, -1549, 1), {
        accounts: [
          {
            id: 'a1',
            displayName: 'Northgate Checking',
            institution: null,
            accountType: 'checking',
            last4: null,
            currency: 'USD',
            isActive: true,
            coverage: [],
          },
        ],
      });

      expect(analyzeRecurrence(snapshot, DEFAULT_CONFIG).series[0].status).toBe('active');
    });
  });

  describe('what never reaches a series (§5.2 inputs)', () => {
    it('ignores pending, excluded, transfer and refunded rows, and credits', () => {
      const transactions = [
        ...monthly(6, -1549, 1),
        charge('2025-07-05', -1549, { isPending: true }),
        charge('2025-08-05', -1549, { isExcluded: true }),
        charge('2025-09-05', -1549, { isInternalTransfer: true }),
        charge('2025-10-05', -1549, { refundPairId: 'r1' }),
        charge('2025-11-05', 1549),
      ];
      const { series } = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);

      expect(series).toHaveLength(1);
      expect(series[0].occurrenceCount).toBe(6);
    });

    it('leaves transfer-kind merchants alone however regular they look', () => {
      const snapshot = snapshotOf(monthly(12, -50000, 1), {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'ONLINE PMT CARDINAL CARD',
            displayName: 'Cardinal Card payment',
            isKnownSubscription: false,
            isTransferKind: true,
            overlapGroup: null,
          },
        ],
      });

      expect(analyzeRecurrence(snapshot, DEFAULT_CONFIG).series).toEqual([]);
    });
  });

  describe('the summary finding (§5.2 presentation)', () => {
    it('emits one visibility finding, not one per series', () => {
      const transactions = [
        ...monthly(12, -1549, 1),
        ...monthly(12, -999, 1).map((row) => ({
          ...row,
          merchantId: 'spotify',
          descriptionNormalized: 'SPOTIFY',
        })),
      ];
      const snapshot = snapshotOf(transactions, {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'NETFLIX',
            displayName: 'Netflix',
            isKnownSubscription: true,
            isTransferKind: false,
            overlapGroup: 'video_streaming',
          },
          {
            id: 'spotify',
            canonicalName: 'SPOTIFY',
            displayName: 'Spotify',
            isKnownSubscription: true,
            isTransferKind: false,
            overlapGroup: 'music_streaming',
          },
        ],
      });

      const { series, emission } = analyzeRecurrence(snapshot, DEFAULT_CONFIG);

      expect(series).toHaveLength(2);
      expect(emission.findings).toHaveLength(1);
      expect(emission.findings[0]).toMatchObject({
        ruleId: 'recurrence.v1',
        subjectType: 'portfolio',
        // §7.3: this money is already being spent knowingly, so it never sums
        // into the savings headline.
        impactKind: 'visibility',
      });
      expect(emission.findings[0].detail['annualCents']).toBe((1549 + 999) * 12);
    });

    it('says nothing when there are no active series', () => {
      expect(analyzeRecurrence(snapshotOf([]), DEFAULT_CONFIG).emission.findings).toEqual([]);
    });
  });

  it('takes its thresholds from the config rather than from constants (§7.4)', () => {
    // Widening the amount tolerance is enough to make two price tiers one cluster
    // from the start — proof the number is read, not compiled in.
    const transactions = [...monthly(6, -1000, 1), ...monthly(6, -1400, 7)];

    const tight = analyzeRecurrence(snapshotOf(transactions), DEFAULT_CONFIG);
    expect(tight.series[0].priceSteps).toHaveLength(1);

    const loose = analyzeRecurrence(
      snapshotOf(transactions),
      resolveConfig({ recurrence: { amountTolerancePercent: 0.9 } }),
    );
    expect(loose.series[0].priceSteps).toHaveLength(0);
  });
});

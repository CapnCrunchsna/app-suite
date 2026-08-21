/**
 * §5.4–§5.7 — the four rules that consume §5.2's series and re-derive nothing.
 *
 * Each of these sections lists the false positive it was corrected to prevent,
 * and those corrections are what most of these cases pin. A rule that fires on
 * every subscription that ever changed price is worse than a rule that does not
 * exist: §5.1's whole noise argument is that false-positive volume is the failure
 * mode that gets a tool like this abandoned.
 */

import { DEFAULT_CONFIG, resolveConfig } from './config.js';
import { analyze, totalSavingsAnnualCents, SnapshotTooLargeError } from './analyze.js';
import { analyzeRecurrence } from './recurrence.js';
import { analyzeDuplicates } from './duplicate.js';
import { analyzePriceCreep } from './price-creep.js';
import { analyzeTrials } from './trial.js';
import { analyzeLapsed } from './lapsed.js';
import { bandFor } from './finding.js';
import type { Finding } from './finding.js';
import type { Snapshot, SnapshotMerchant, SnapshotTransaction } from './snapshot.js';

let nextId = 0;
beforeEach(() => {
  nextId = 0;
});

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
    // Verbatim, and no §5 rule may group on it — it is on the projection for
    // §2.6's `last4` signal alone. See `snapshot.ts`.
    descriptionRaw: 'NETFLIX',
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

function monthly(
  count: number,
  amountCents: number,
  startMonth: number,
  overrides: Partial<SnapshotTransaction> & { day?: number; year?: number } = {},
) {
  const { day = 5, year = 2025, ...rest } = overrides;
  return Array.from({ length: count }, (_, index) => {
    const month = startMonth + index;
    const shiftedYear = year + Math.floor((month - 1) / 12);
    const shiftedMonth = ((month - 1) % 12) + 1;
    return charge(
      `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      amountCents,
      rest,
    );
  });
}

function merchant(overrides: Partial<SnapshotMerchant> = {}): SnapshotMerchant {
  return {
    id: 'netflix',
    canonicalName: 'NETFLIX',
    displayName: 'Netflix',
    isKnownSubscription: true,
    isTransferKind: false,
    overlapGroup: null,
    ...overrides,
  };
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
        institution: null,
        accountType: 'checking',
        last4: null,
        currency: 'USD',
        isActive: true,
        coverage: [{ start: '2025-01-01', end: '2025-12-31' }],
      },
    ],
    transactions,
    merchants: [merchant()],
    categories: [],
    ...overrides,
  };
}

const seriesOf = (snapshot: Snapshot, config = DEFAULT_CONFIG) =>
  analyzeRecurrence(snapshot, config).series;

// ------------------------------------------------------------------ §5.4 ---

describe('duplicate.v1 (§5.4)', () => {
  describe('same-merchant multiplicity', () => {
    it('flags two concurrent plans at one merchant, and claims the cheaper one', () => {
      const snapshot = snapshotOf([...monthly(10, -999, 1), ...monthly(10, -1999, 1, { day: 20 })]);
      const { findings } = analyzeDuplicates(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      const same = findings.filter((finding) => finding.detail['kind'] === 'same_merchant');
      expect(same).toHaveLength(1);
      // §5.4: impact is the cheaper series' annual cost. One of the two plans is
      // presumably wanted, so claiming the total would over-promise.
      expect(same[0].impactAnnualCents).toBe(999 * 12);
      expect(same[0].impactKind).toBe('savings');
      expect(bandFor(same[0].confidence, DEFAULT_CONFIG)).toBe('high');
    });

    /**
     * The false positive §5.2's concurrency requirement exists to prevent: a
     * subscription that got more expensive leaves two amount clusters for one
     * merchant, and without the requirement this rule accuses the user of a
     * double charge at 0.85 confidence.
     */
    it('does not fire on a subscription that merely changed price', () => {
      const snapshot = snapshotOf([...monthly(8, -899, 1), ...monthly(8, -1549, 9)]);
      const { findings } = analyzeDuplicates(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      expect(findings.filter((f) => f.detail['kind'] === 'same_merchant')).toEqual([]);
    });

    it('reports three concurrent plans as one finding, not three pairs', () => {
      const snapshot = snapshotOf([
        ...monthly(10, -999, 1),
        ...monthly(10, -1999, 1, { day: 15 }),
        ...monthly(10, -2999, 1, { day: 25 }),
      ]);
      const { findings } = analyzeDuplicates(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      const same = findings.filter((f) => f.detail['kind'] === 'same_merchant');
      expect(same).toHaveLength(1);
      expect(same[0].detail['seriesIds']).toHaveLength(3);
    });
  });

  describe('category overlap', () => {
    const streamingSnapshot = () =>
      snapshotOf(
        [
          ...monthly(12, -1549, 1),
          ...monthly(12, -999, 1, { merchantId: 'spotify', descriptionNormalized: 'SPOTIFY' }),
        ],
        {
          merchants: [
            merchant({ overlapGroup: 'video_streaming' }),
            merchant({
              id: 'spotify',
              canonicalName: 'SPOTIFY',
              displayName: 'Spotify',
              overlapGroup: 'video_streaming',
            }),
          ],
        },
      );

    it('totals the group rather than accusing anyone', () => {
      const snapshot = streamingSnapshot();
      const { findings } = analyzeDuplicates(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      const overlap = findings.filter((f) => f.detail['kind'] === 'category_overlap');
      expect(overlap).toHaveLength(1);
      expect(overlap[0].detail['annualCents']).toBe((1549 + 999) * 12);
      // Owning two streaming services is a legitimate choice — §7.3 keeps this
      // out of the savings headline.
      expect(overlap[0].impactKind).toBe('visibility');
      expect(bandFor(overlap[0].confidence, DEFAULT_CONFIG)).toBe('medium');
    });

    it('says nothing about a group of one', () => {
      const snapshot = snapshotOf(monthly(12, -1549, 1), {
        merchants: [merchant({ overlapGroup: 'video_streaming' })],
      });
      const { findings } = analyzeDuplicates(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      expect(findings).toEqual([]);
    });

    it('is separately toggleable from the accusation (§5.4)', () => {
      const snapshot = streamingSnapshot();
      const series = seriesOf(snapshot);

      const off = analyzeDuplicates(
        snapshot,
        series,
        resolveConfig({ duplicate: { categoryOverlapEnabled: false } }),
      );
      expect(off.findings).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ §5.5 ---

describe('price_creep.v1 (§5.5)', () => {
  const risen = () => snapshotOf([...monthly(8, -899, 1), ...monthly(8, -1549, 9)]);

  it('reports the cumulative change since the first charge, which is the number that lands', () => {
    const snapshot = risen();
    const { emission } = analyzePriceCreep(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

    expect(emission.findings).toHaveLength(1);
    const detail = emission.findings[0].detail;
    expect(detail['firstCents']).toBe(899);
    expect(detail['currentCents']).toBe(1549);
    expect(detail['cumulativeDeltaCents']).toBe(650);
    expect(detail['cumulativePercent']).toBeCloseTo(72.3, 1);
    // $6.50 × 12 — what the subscription costs more than when it started.
    expect(emission.findings[0].impactAnnualCents).toBe(650 * 12);
    expect(emission.findings[0].impactKind).toBe('savings');
  });

  it('caps confidence at the series it is reasoning about (§5.5)', () => {
    const snapshot = risen();
    const series = seriesOf(snapshot);
    const { emission } = analyzePriceCreep(snapshot, series, DEFAULT_CONFIG);

    // The arithmetic is certain; the doubt is whether this is really one
    // subscription, which is exactly what series.confidence measures.
    expect(emission.findings[0].confidence).toBeLessThanOrEqual(series[0].confidence);
    expect(emission.findings[0].confidence).toBeLessThanOrEqual(
      DEFAULT_CONFIG.priceCreep.confirmedConfidenceCap,
    );
  });

  describe('the noise floor, stated in cents rather than percent', () => {
    /**
     * The design session's "under 2% or $0.50" suppressed this exact case: a
     * $3.80 step on a $200/month subscription is 1.9% and $45.60 a year.
     */
    it('keeps a small-percentage step that annualizes to real money', () => {
      const snapshot = snapshotOf([...monthly(8, -20000, 1), ...monthly(8, -20380, 9)]);
      const { emission } = analyzePriceCreep(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      expect(emission.findings).toHaveLength(1);
      expect(emission.findings[0].impactAnnualCents).toBe(380 * 12);
    });

    it('drops a step that annualizes to almost nothing', () => {
      // 60 cents once a year. Above the $0.50 step floor, far below the $5 annual.
      const snapshot = snapshotOf([charge('2024-03-04', -9900), charge('2025-03-04', -9960)], {
        accounts: [
          {
            id: 'a1',
            displayName: 'Northgate Checking',
            institution: null,
            accountType: 'checking',
            last4: null,
            currency: 'USD',
            isActive: true,
            coverage: [{ start: '2024-01-01', end: '2025-06-30' }],
          },
        ],
      });
      const { emission } = analyzePriceCreep(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

      expect(emission.findings).toEqual([]);
    });
  });

  it('labels a step still on its first charge rather than withholding it', () => {
    const snapshot = snapshotOf([...monthly(8, -899, 1), ...monthly(1, -1549, 9)]);
    const { emission } = analyzePriceCreep(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

    const steps = emission.findings[0].detail['steps'] as { confirmed: boolean }[];
    expect(steps.at(-1)?.confirmed).toBe(false);
    expect(emission.findings[0].confidence).toBeLessThanOrEqual(
      DEFAULT_CONFIG.priceCreep.unconfirmedConfidenceCap,
    );
  });

  it('says nothing about a subscription whose price never moved', () => {
    const snapshot = snapshotOf(monthly(12, -1549, 1));
    const { emission } = analyzePriceCreep(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

    expect(emission.findings).toEqual([]);
  });
});

// ------------------------------------------------------------------ §5.6 ---

describe('trial.v1 (§5.6)', () => {
  const withAuthorization = () =>
    snapshotOf([
      charge('2024-12-06', 0, { descriptionNormalized: 'NETFLIX' }),
      ...monthly(8, -1549, 1),
    ]);

  const run = (snapshot: Snapshot, reported = new Set<string>()) =>
    analyzeTrials({
      snapshot,
      series: seriesOf(snapshot),
      reportedFirstTransitionSeriesIds: reported,
      config: DEFAULT_CONFIG,
    });

  it('scores the card-validation authorization and the trial length together', () => {
    const { findings } = run(withAuthorization());

    expect(findings).toHaveLength(1);
    // $0 authorization 30 days before the first charge: 2 points for the
    // authorization, 1 for the interval matching a 30-day trial.
    expect(findings[0].detail['points']).toBe(3);
    expect(findings[0].detail['signals']).toEqual(['authorization', 'trial_length']);
  });

  it('emits on an explicit trial descriptor alone, and on nothing else alone', () => {
    const marked = snapshotOf(
      monthly(8, -1549, 1, { descriptionNormalized: 'HULU FREE TRIAL 877-824-4858' }),
      { merchants: [merchant({ id: 'netflix', displayName: 'Hulu' })] },
    );
    expect(run(marked).findings).toHaveLength(1);

    // An intro rate on its own is one point — below the threshold — because
    // otherwise this rule fires on every subscription whose price ever rose.
    const introOnly = snapshotOf([...monthly(4, -499, 1), ...monthly(6, -1549, 5)]);
    expect(run(introOnly).findings).toEqual([]);
  });

  /**
   * §5.6's second correction. Normalization uppercases everything, so an
   * unanchored substring test for `FREE` matches a clothing retailer, a mortgage
   * servicer and a port.
   */
  it('does not match a trial marker inside an unrelated word', () => {
    for (const descriptor of ['FREE PEOPLE 0421', 'FREEDOM MORTGAGE', 'FREEPORT MCMORAN']) {
      const snapshot = snapshotOf(monthly(8, -1549, 1, { descriptionNormalized: descriptor }));
      expect(run(snapshot).findings).toEqual([]);
    }
  });

  it('is suppressed when price creep already reported that transition (§5.6)', () => {
    const snapshot = snapshotOf([
      charge('2024-12-06', 0),
      ...monthly(4, -499, 1),
      ...monthly(6, -1549, 5),
    ]);
    const series = seriesOf(snapshot);
    const creep = analyzePriceCreep(snapshot, series, DEFAULT_CONFIG);

    expect(creep.reportedFirstTransitionSeriesIds.size).toBe(1);
    expect(run(snapshot).findings.length).toBeGreaterThan(0);
    expect(run(snapshot, new Set(creep.reportedFirstTransitionSeriesIds)).findings).toEqual([]);
  });

  it('halves confidence and says so when the trial predates the imported window', () => {
    // The authorization is the earliest row, so the first charge lands well
    // inside §5.6's 45-day blind spot.
    const { findings } = run(withAuthorization());

    expect(findings[0].detail['earlyInWindow']).toBe(true);
    expect(findings[0].detail['limitation']).toContain('pre-existing subscription');
    // 0.30 + 3 × 0.15 = 0.75, halved.
    expect(findings[0].confidence).toBeCloseTo(0.375, 3);
  });

  it('keeps out of the savings headline (§7.3)', () => {
    expect(run(withAuthorization()).findings[0].impactKind).toBe('visibility');
  });
});

// ------------------------------------------------------------------ §5.7 ---

describe('lapsed.v1 (§5.7)', () => {
  const stopped = () =>
    snapshotOf(monthly(6, -1549, 1), {
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

  it('reports a series that stopped, with zero impact and the former cost in the detail', () => {
    const snapshot = stopped();
    const { findings } = analyzeLapsed(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('appears cancelled');
    // Not money being spent, so it inflates no total.
    expect(findings[0].impactAnnualCents).toBe(0);
    expect(findings[0].detail['formerAnnualCents']).toBe(1549 * 12);
    expect(findings[0].impactKind).toBe('visibility');
  });

  /** Zero impact means the $25 floor would suppress every one of these without
   *  §5.1's explicit opt-out for this rule. */
  it('survives the absolute impact floor that would otherwise suppress it', () => {
    const snapshot = stopped();
    const { findings } = analyzeLapsed(snapshot, seriesOf(snapshot), DEFAULT_CONFIG);

    expect(findings).toHaveLength(1);
    expect(DEFAULT_CONFIG.global.minAnnualImpactCents).toBeGreaterThan(0);
  });

  it('does not announce a merely late series as cancelled', () => {
    // Coverage ends 50 days after the last charge: past §5.2's 1.5 × cadence
    // (45.7 days), so the series is not active — but inside §5.7's 2 × (60.9),
    // so nothing is announced. That gap is the hysteresis.
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
          coverage: [{ start: '2025-01-01', end: '2025-07-25' }],
        },
      ],
    });
    const series = seriesOf(snapshot);

    expect(series[0].status).toBe('lapsed');
    expect(analyzeLapsed(snapshot, series, DEFAULT_CONFIG).findings).toEqual([]);
  });

  it('claims nothing for an account with no statements to measure against', () => {
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

    expect(analyzeLapsed(snapshot, seriesOf(snapshot), DEFAULT_CONFIG).findings).toEqual([]);
  });

  it('needs three occurrences before calling anything cancelled', () => {
    const snapshot = snapshotOf(monthly(2, -1549, 1));
    expect(analyzeLapsed(snapshot, seriesOf(snapshot), DEFAULT_CONFIG).findings).toEqual([]);
  });
});

// ------------------------------------------------------------- the run ---

describe('analyze (§2.2)', () => {
  it('runs every rule over one snapshot and reports what the run used', () => {
    const snapshot = snapshotOf([...monthly(8, -899, 1), ...monthly(8, -1549, 9)]);
    const result = analyze(snapshot, DEFAULT_CONFIG);

    expect(result.series).toHaveLength(1);
    expect(result.snapshotRows).toBe(16);
    expect(result.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(result.ruleVersions)).toContain('price_creep.v1');
    expect(result.warning).toBeNull();
  });

  it('refuses a snapshot over the ceiling rather than discovering it in production', () => {
    const config = resolveConfig({ global: { snapshotMaxRows: 5, snapshotWarnRows: 2 } });
    const snapshot = snapshotOf(monthly(6, -1549, 1));

    expect(() => analyze(snapshot, config)).toThrow(SnapshotTooLargeError);
    expect(() => analyze(snapshot, config)).toThrow(/date range/);
  });

  it('warns above the advisory limit but still completes', () => {
    const config = resolveConfig({ global: { snapshotWarnRows: 2 } });
    const result = analyze(snapshotOf(monthly(6, -1549, 1)), config);

    expect(result.warning).toContain('advisory limit');
    expect(result.series).toHaveLength(1);
  });

  /**
   * §7.3's invariant, as arithmetic. The subscription summary, the category
   * overlap and the lapsed notice all describe money — and none of them may join
   * the headline, or the same dollars get counted more than once.
   */
  it('sums only savings into the headline', () => {
    const snapshot = snapshotOf(
      [
        ...monthly(8, -899, 1),
        ...monthly(8, -1549, 9),
        ...monthly(12, -999, 1, { merchantId: 'spotify', descriptionNormalized: 'SPOTIFY' }),
      ],
      {
        merchants: [
          merchant({ overlapGroup: 'video_streaming' }),
          merchant({
            id: 'spotify',
            canonicalName: 'SPOTIFY',
            displayName: 'Spotify',
            overlapGroup: 'video_streaming',
          }),
        ],
      },
    );

    const result = analyze(snapshot, DEFAULT_CONFIG);
    const kinds = new Set(result.findings.map((finding: Finding) => finding.impactKind));

    expect(kinds.has('savings')).toBe(true);
    expect(kinds.has('visibility')).toBe(true);
    // Only the price-creep delta is a saving here.
    expect(totalSavingsAnnualCents(result.findings)).toBe(650 * 12);
  });
});

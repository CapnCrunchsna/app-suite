/**
 * §5.8–§5.11, over literal transaction arrays.
 *
 * The four rules that read *transactions* rather than the series §5.2 produces,
 * which makes them the first in §5 that can be tested without building a
 * subscription first. What is asserted below is mostly the negative space: each
 * of these rules is one bad threshold away from burying the Findings page, and
 * §5.8, §5.9 and §5.10 each name the specific false positive they were rewritten
 * to prevent. Those named cases are tests here — the $9.80 latte at z = 4.6, the
 * $7 transit fare against a $2 median, the thousand rent payments above the 95th
 * percentile, the twenty-five spurious climbs a random walk produces.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig } from './config.js';
import { FEES_RULE_ID, analyzeFees } from './fees.js';
import { MICRO_RULE_ID, analyzeMicroSpend } from './micro.js';
import { OUTLIER_RULE_ID, analyzeOutliers } from './outlier.js';
import { TREND_RULE_ID, analyzeTrends } from './trend.js';
import type { RecurringSeries } from './recurrence.js';
import type {
  Snapshot,
  SnapshotAccount,
  SnapshotCategory,
  SnapshotMerchant,
  SnapshotTransaction,
} from './snapshot.js';

// ------------------------------------------------------------------ fixtures ---

let nextId = 0;

/** A debit. Amounts are passed as positive magnitudes and stored negative, which
 *  is how every one of these rules reads them. */
function tx(
  effectiveDate: string,
  cents: number,
  overrides: Partial<SnapshotTransaction> = {},
): SnapshotTransaction {
  nextId += 1;
  const base = {
    id: `t${nextId}`,
    accountId: 'a1',
    effectiveDate,
    amountCents: -cents,
    descriptionNormalized: 'MERCHANT',
    merchantId: null,
    categoryId: null,
    isPending: false,
    isInternalTransfer: false,
    isExcluded: false,
    refundPairId: null,
    transferPairId: null,
    ...overrides,
  };
  return { ...base, descriptionRaw: overrides.descriptionRaw ?? base.descriptionNormalized };
}

/** A credit, for §5.8's reversal netting. */
const credit = (
  effectiveDate: string,
  cents: number,
  overrides: Partial<SnapshotTransaction> = {},
): SnapshotTransaction => tx(effectiveDate, -cents, overrides);

/** An account covered for a whole span of months, so §7.2's `fullyCoveredMonths`
 *  admits them. A period has to *span* a month for it to count. */
function account(
  id: string,
  months: readonly string[] = [],
  overrides: Partial<SnapshotAccount> = {},
): SnapshotAccount {
  return {
    id,
    displayName: id,
    institution: null,
    accountType: 'checking',
    last4: null,
    currency: 'USD',
    isActive: true,
    coverage: months.map((month) => ({ start: `${month}-01`, end: lastDay(month) })),
    ...overrides,
  };
}

function lastDay(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** `2026-01` … for `count` months from `start`. */
function monthRange(start: string, count: number): string[] {
  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

const merchant = (id: string, name = id): SnapshotMerchant => ({
  id,
  canonicalName: name.toUpperCase(),
  displayName: name,
  isKnownSubscription: false,
  isTransferKind: false,
  overlapGroup: null,
});

const category = (
  id: string,
  kind: SnapshotCategory['kind'] = 'spend',
  name = id,
): SnapshotCategory => ({ id, name, parentId: null, kind, overlapGroup: null });

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    accounts: [account('a1')],
    transactions: [],
    merchants: [],
    categories: [],
    ...overrides,
  };
}

const titles = (emission: { findings: readonly { title: string }[] }): string[] =>
  emission.findings.map((finding) => finding.title);

// ================================================================ §5.8 fees ===

describe('fees.v1 (§5.8)', () => {
  const feeSnapshot = (transactions: readonly SnapshotTransaction[], extra: Partial<Snapshot> = {}) =>
    snapshot({
      transactions,
      accounts: [account('a1', monthRange('2026-01', 12))],
      categories: [category('fees', 'fee', 'Fees'), category('dining', 'spend', 'Dining')],
      ...extra,
    });

  it('matches §5.8’s keywords on a whole token', () => {
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 3500, { descriptionNormalized: 'NSF FEE' }),
        tx('2026-02-05', 3500, { descriptionNormalized: 'LATE FEE' }),
      ]),
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].detail['feeCount']).toBe(2);
  });

  it('does not let NSF match inside TRANSFERS', () => {
    // The reason §5.8 says "whole-token": a substring test turns every transfer
    // into a fee.
    const emission = analyzeFees(
      feeSnapshot([tx('2026-01-05', 50_000, { descriptionNormalized: 'TRANSFERS TO SAVINGS' })]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('takes a fee-kind category with no recognisable keyword', () => {
    // §5.8: "a fee whose category was never assigned is still a fee" — and the
    // converse holds too.
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 1200, { descriptionNormalized: 'SERVICE CHG', categoryId: 'fees' }),
      ]),
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(1);
    // §5.8: "0.75 on a category-only hit."
    expect(emission.findings[0].confidence).toBe(0.75);
  });

  it('scores a keyword hit higher than a category-only one', () => {
    const emission = analyzeFees(
      feeSnapshot([tx('2026-01-05', 3500, { descriptionNormalized: 'LATE FEE' })]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings[0].confidence).toBe(0.95);
  });

  it('counts debits only, so INTEREST on a savings account is not a fee', () => {
    // §5.8's first qualification: "On a savings account `INTEREST` is income, not
    // a fee; on a credit card it is a charge. Sign disambiguates them and nothing
    // else does."
    const emission = analyzeFees(
      feeSnapshot([credit('2026-01-20', 342, { descriptionNormalized: 'INTEREST CHARGE' })]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('excludes account descriptors that merely contain a keyword', () => {
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 500, { descriptionNormalized: 'INTEREST CHECKING MAINTENANCE' }),
        tx('2026-02-05', 500, { descriptionNormalized: 'INTEREST EARNED ADJUSTMENT' }),
      ]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('disqualifies a reversal by its own wording', () => {
    // `LATE FEE REVERSAL` is the opposite of a late fee.
    const emission = analyzeFees(
      feeSnapshot([tx('2026-01-05', 3500, { descriptionNormalized: 'LATE FEE REVERSAL' })]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('nets out a fee credited back inside the window', () => {
    // §5.8: "A refunded fee that still shows in an annual total is the kind of
    // error that costs the whole tool its credibility."
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 3500, { descriptionNormalized: 'NSF FEE' }),
        credit('2026-02-10', 3500, { descriptionNormalized: 'NSF FEE REFUND' }),
      ]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('does not net a credit that lands outside the 60-day window', () => {
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 3500, { descriptionNormalized: 'NSF FEE' }),
        credit('2026-04-10', 3500, { descriptionNormalized: 'NSF FEE REFUND' }),
      ]),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].detail['feeCount']).toBe(1);
  });

  it('nets one-to-one, so one credit cannot cancel two fees', () => {
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-05', 3500, { descriptionNormalized: 'NSF FEE' }),
        tx('2026-01-06', 3500, { descriptionNormalized: 'NSF FEE' }),
        credit('2026-01-20', 3500, { descriptionNormalized: 'NSF FEE REFUND' }),
      ]),
      DEFAULT_CONFIG,
    );

    expect(emission.findings[0].detail['feeCount']).toBe(1);
    expect(emission.findings[0].detail['reversedCount']).toBe(1);
  });

  it('emits one rollup per account, never one per transaction', () => {
    // §5.8: "a per-transaction finding for every $3 ATM fee is noise." At $3 a
    // time §5.1's $25 floor would suppress the rollup as well, which is correct
    // and is not what this test is about — $6 twice a month clears it.
    const rows = monthRange('2026-01', 12).flatMap((month, index) =>
      [5, 19].map((day) =>
        tx(`${month}-${String(day).padStart(2, '0')}`, 600, {
          descriptionNormalized: 'ATM FEE',
          accountId: index % 2 ? 'a2' : 'a1',
        }),
      ),
    );

    const emission = analyzeFees(
      snapshot({
        transactions: rows,
        accounts: [
          account('a1', monthRange('2026-01', 12)),
          account('a2', monthRange('2026-01', 12)),
        ],
      }),
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(2);
    expect(emission.findings.every((finding) => finding.subjectType === 'account')).toBe(true);
  });

  it('carries recurring maintenance as the savings half and the total in the detail (§9g)', () => {
    const maintenance = monthRange('2026-01', 12).map((month) =>
      tx(`${month}-01`, 1200, { descriptionNormalized: 'MONTHLY MAINTENANCE FEE' }),
    );
    const oneOff = [tx('2026-03-14', 3500, { descriptionNormalized: 'NSF FEE' })];

    const emission = analyzeFees(feeSnapshot([...maintenance, ...oneOff]), DEFAULT_CONFIG);
    const [finding] = emission.findings;

    // $144 of maintenance is what a waiver could have prevented; the $35 NSF is
    // not, so only the maintenance reaches the impact — and §7.3's headline.
    expect(finding.impactKind).toBe('savings');
    expect(finding.impactAnnualCents).toBe(14_400);
    expect(finding.detail['totalAnnualCents']).toBe(17_900);
    expect(finding.detail['avoidableKeywords']).toEqual(['MONTHLY MAINTENANCE']);
  });

  it('reports an account with nothing avoidable as visibility, not a $0 saving', () => {
    // Without this branch §5.1's $25 floor would suppress a real fee total for
    // having no avoidable part.
    const emission = analyzeFees(
      feeSnapshot(
        monthRange('2026-01', 12).map((month) =>
          tx(`${month}-05`, 3500, { descriptionNormalized: 'FOREIGN TRANSACTION FEE' }),
        ),
      ),
      DEFAULT_CONFIG,
    );

    const [finding] = emission.findings;
    expect(finding.impactKind).toBe('visibility');
    expect(finding.impactAnnualCents).toBe(42_000);
  });

  it('does not call a single maintenance charge recurring', () => {
    const emission = analyzeFees(
      feeSnapshot([
        tx('2026-01-01', 1200, { descriptionNormalized: 'MONTHLY MAINTENANCE FEE' }),
        tx('2026-02-05', 3500, { descriptionNormalized: 'NSF FEE' }),
      ]),
      DEFAULT_CONFIG,
    );

    // One month's dip below a minimum balance is not a standing waiver condition,
    // so nothing is claimed as recoverable.
    expect(emission.findings[0].impactKind).toBe('visibility');
  });

  it('annualizes over the fee span, not over the whole statement history', () => {
    // Two years of statements and one $35 fee in the first month must not report
    // $420/yr.
    const emission = analyzeFees(
      snapshot({
        transactions: [
          tx('2026-01-05', 3500, { descriptionNormalized: 'NSF FEE' }),
          tx('2026-02-05', 3500, { descriptionNormalized: 'NSF FEE' }),
        ],
        accounts: [account('a1', monthRange('2026-01', 24))],
      }),
      DEFAULT_CONFIG,
    );

    // Two fees across a two-month span: $35/mo, $420/yr.
    expect(emission.findings[0].detail['monthsObserved']).toBe(2);
    expect(emission.findings[0].impactAnnualCents).toBe(42_000);
  });

  it('takes every threshold from the config (§7.4)', () => {
    const lenient = resolveConfig({ fees: { keywords: ['CUSTOM CHARGE'] } });
    const emission = analyzeFees(
      feeSnapshot([tx('2026-01-05', 9900, { descriptionNormalized: 'CUSTOM CHARGE' })]),
      lenient,
    );
    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].ruleId).toBe(FEES_RULE_ID);
  });
});

// ============================================================ §5.9 outliers ===

describe('outlier.v1 (§5.9)', () => {
  const withMerchant = (
    amounts: readonly number[],
    merchantId = 'm1',
  ): SnapshotTransaction[] =>
    amounts.map((cents, index) =>
      tx(`2026-01-${String(index + 1).padStart(2, '0')}`, cents, { merchantId }),
    );

  it('flags a charge unlike its merchant’s distribution', () => {
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([2300, 2400, 2200, 2350, 2450, 41_200]),
        merchants: [merchant('m1', 'Merchant')],
      }),
      [],
      DEFAULT_CONFIG,
    );

    expect(titles(emission)).toEqual(['$412 at Merchant — typical is $24']);
    expect(emission.findings[0].impactKind).toBe('visibility');
  });

  it('does not flag the $9.80 latte §5.9 names', () => {
    // "a coffee shop with a $6.40 median and a $0.50 MAD flags a $9.80 latte at
    // z = 4.6" — statistically extreme, three dollars, not a finding.
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([640, 640, 590, 690, 640, 980]),
        merchants: [merchant('m1', 'Coffee')],
      }),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('does not flag the $7 transit fare §5.9 names', () => {
    // The MAD = 0 fallback: a perfectly steady $2 fare makes $7 more than three
    // times the median, and the $25 floor is the only thing between that and a
    // card.
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([200, 200, 200, 200, 200, 700]),
        merchants: [merchant('m1', 'Transit')],
      }),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('uses the 3 × median fallback when there is no dispersion to measure', () => {
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([5000, 5000, 5000, 5000, 5000, 20_000]),
        merchants: [merchant('m1', 'Steady')],
      }),
      [],
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].detail['basis']).toBe('steady_median');
  });

  it('needs a distribution before it will call anything unlike it', () => {
    // Four charges is below §5.9's merchant minimum of five.
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([2300, 2400, 2200, 41_200]),
        merchants: [merchant('m1')],
      }),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('reports the excess as the impact, so §5.1’s floor and §5.9’s are one test', () => {
    const emission = analyzeOutliers(
      snapshot({
        transactions: withMerchant([2300, 2400, 2200, 2350, 2450, 41_200]),
        merchants: [merchant('m1', 'Merchant')],
      }),
      [],
      DEFAULT_CONFIG,
    );

    const [finding] = emission.findings;
    expect(finding.impactAnnualCents).toBe(41_200 - 2375);
    // A one-off charge has no monthly rate, and inventing one would claim it
    // repeats.
    expect(finding.impactMonthlyCents).toBe(0);
  });

  it('emits one rollup for the largest charges in a year, not ten cards', () => {
    // §5.9 rewrote this branch because "any debit above the 95th percentile and
    // $200" is 5% of everything — "about a thousand findings over ten years".
    const ordinary = Array.from({ length: 200 }, (_, index) =>
      tx(`2026-${String((index % 12) + 1).padStart(2, '0')}-05`, 2000 + index),
    );
    const large = [
      tx('2026-03-01', 180_000),
      tx('2026-06-01', 150_000),
      tx('2026-09-01', 140_000),
    ];

    const emission = analyzeOutliers(
      snapshot({ transactions: [...ordinary, ...large] }),
      [],
      DEFAULT_CONFIG,
    );

    const rollups = emission.findings.filter((finding) => finding.subjectType === 'window');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].subjectId).toBe('2026');
    expect(rollups[0].evidenceTransactionIds.length).toBeLessThanOrEqual(
      DEFAULT_CONFIG.outlier.globalTopN,
    );
  });

  it('keeps the rent out of the largest-charges list', () => {
    // §5.9: "for most households the top of that distribution is rent, mortgage,
    // tuition and insurance — expected payments, every one of them."
    const rent = monthRange('2026-01', 12).map((month) => tx(`${month}-01`, 220_000));
    const ordinary = Array.from({ length: 120 }, (_, index) => tx('2026-05-05', 2000 + index));
    const oneOff = tx('2026-07-04', 190_000);

    const series: RecurringSeries[] = [
      {
        id: 's1',
        merchantId: 'landlord',
        accountId: 'a1',
        cadenceLabel: 'monthly',
        cadenceDays: 30.44,
        cadencesPerYear: 12,
        status: 'active',
        confidence: 0.9,
        basis: 'fitted',
        charges: rent.map((row) => ({
          transactionId: row.id,
          effectiveDate: row.effectiveDate,
          amountCents: row.amountCents,
        })),
        priceSteps: [],
        amountCentsCurrent: 220_000,
        amountCentsFirst: 220_000,
        firstSeen: '2026-01-01',
        lastSeen: '2026-12-01',
        nextExpected: '2027-01-01',
        occurrenceCount: 12,
        regularity: 1,
        isKnownSubscription: false,
        concurrentSeriesIds: [],
      },
    ];

    const emission = analyzeOutliers(
      snapshot({ transactions: [...rent, ...ordinary, oneOff] }),
      series,
      DEFAULT_CONFIG,
    );

    const rollup = emission.findings.find((finding) => finding.subjectType === 'window');
    expect(rollup?.evidenceTransactionIds).toEqual([oneOff.id]);
  });

  it('reports a charge once when its merchant and its category both flag it (§9g)', () => {
    // A category containing one dominant merchant makes both branches agree, and
    // §5.9 does not say what happens then. Two cards for one charge is the
    // volume §5.1 says gets the tool abandoned.
    const rows = [
      ...Array.from({ length: 20 }, (_, index) =>
        tx(`2026-01-${String((index % 28) + 1).padStart(2, '0')}`, 7000 + index * 10, {
          merchantId: 'm1',
          categoryId: 'groceries',
        }),
      ),
      tx('2026-02-14', 41_200, { merchantId: 'm1', categoryId: 'groceries' }),
    ];

    const emission = analyzeOutliers(
      snapshot({
        transactions: rows,
        merchants: [merchant('m1', 'Trader Joes')],
        categories: [category('groceries', 'spend', 'Groceries')],
      }),
      [],
      DEFAULT_CONFIG,
    );

    const perCharge = emission.findings.filter((finding) => finding.subjectType !== 'window');
    expect(perCharge).toHaveLength(1);
    // The merchant survives: the more specific comparison is the better sentence.
    expect(perCharge[0].subjectType).toBe('merchant');
    expect(perCharge[0].title).toContain('Trader Joes');
  });

  it('leaves internal transfers and pending rows out', () => {
    const emission = analyzeOutliers(
      snapshot({
        transactions: [
          ...withMerchant([2300, 2400, 2200, 2350, 2450]),
          tx('2026-01-20', 41_200, { merchantId: 'm1', isInternalTransfer: true }),
          tx('2026-01-21', 41_200, { merchantId: 'm1', isPending: true }),
        ],
        merchants: [merchant('m1')],
      }),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('keys a window on the calendar year, so the key survives a new import (§9g)', () => {
    const first = analyzeOutliers(
      snapshot({
        transactions: [
          ...Array.from({ length: 120 }, () => tx('2026-05-05', 2000)),
          tx('2026-07-04', 190_000),
        ],
      }),
      [],
      DEFAULT_CONFIG,
    );

    const extended = analyzeOutliers(
      snapshot({
        transactions: [
          ...Array.from({ length: 120 }, () => tx('2026-05-05', 2000)),
          tx('2026-07-04', 190_000),
          tx('2026-11-11', 3000),
        ],
      }),
      [],
      DEFAULT_CONFIG,
    );

    const key = (e: typeof first) =>
      e.findings.find((finding) => finding.subjectType === 'window')?.naturalKey;
    expect(key(first)).toBe(`${OUTLIER_RULE_ID}|window|2026`);
    expect(key(extended)).toBe(key(first));
  });
});

// =============================================================== §5.10 trend ===

describe('trend.v1 (§5.10)', () => {
  /** `cents` per month, spread over four charges so a month has a shape. */
  const monthly = (months: readonly string[], perMonth: readonly number[], categoryId = 'dining') =>
    months.flatMap((month, index) =>
      Array.from({ length: 4 }, (_, part) =>
        tx(`${month}-${String(part * 5 + 3).padStart(2, '0')}`, Math.round(perMonth[index] / 4), {
          categoryId,
        }),
      ),
    );

  const trendSnapshot = (transactions: readonly SnapshotTransaction[], months: readonly string[]) =>
    snapshot({
      transactions,
      accounts: [account('a1', months)],
      categories: [category('dining', 'spend', 'Dining')],
    });

  it('computes nothing when no month is fully covered (§7.2)', () => {
    // §5.10's opening sentence, and the failure it prevents: an import gap read
    // as spending behaviour.
    const months = monthRange('2026-01', 6);
    const emission = analyzeTrends(
      snapshot({
        transactions: monthly(months, [20_000, 20_000, 20_000, 20_000, 20_000, 90_000]),
        accounts: [account('a1', [])],
        categories: [category('dining')],
      }),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('flags a month that clears both the percentage and the dollar test', () => {
    const months = monthRange('2026-01', 5);
    const emission = analyzeTrends(
      trendSnapshot(monthly(months, [20_000, 20_000, 20_000, 20_000, 90_000]), months),
      [],
      DEFAULT_CONFIG,
    );

    const spike = emission.findings.find((finding) => finding.detail['kind'] === 'spike');
    expect(spike?.detail['month']).toBe('2026-05');
    expect(spike?.detail['excessCents']).toBe(70_000);
    expect(spike?.impactMonthlyCents).toBe(0);
  });

  it('does not flag a $12 category on percentage alone', () => {
    // §5.10: "a percentage alone flags a $12 category".
    const months = monthRange('2026-01', 5);
    const emission = analyzeTrends(
      trendSnapshot(monthly(months, [1200, 1200, 1200, 1200, 6000]), months),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings.filter((f) => f.detail['kind'] === 'spike')).toEqual([]);
  });

  it('does not flag a large category on dollars alone', () => {
    // §5.10: "a dollar amount alone flags every large category every month."
    // $2,000 → $2,100 is $100 of excess but only 5%.
    const months = monthRange('2026-01', 5);
    const emission = analyzeTrends(
      trendSnapshot(monthly(months, [200_000, 200_000, 200_000, 200_000, 210_000]), months),
      [],
      DEFAULT_CONFIG,
    );
    expect(emission.findings.filter((f) => f.detail['kind'] === 'spike')).toEqual([]);
  });

  it('needs three non-zero trailing months before it will call anything a spike', () => {
    const months = monthRange('2026-01', 5);
    const emission = analyzeTrends(
      trendSnapshot(monthly(months, [0, 0, 0, 20_000, 90_000]), months),
      [],
      DEFAULT_CONFIG,
    );
    // The April→May comparison has a zero in its trailing window, so a category
    // that simply started does not read as a spike.
    expect(emission.findings.filter((f) => f.detail['kind'] === 'spike')).toEqual([]);
  });

  it('suppresses a spike in a month-of-year that already spiked', () => {
    // §5.10: "December, insurance renewal months and tuition months otherwise
    // fire every single year."
    const months = monthRange('2026-01', 24);
    const perMonth = months.map((month) => (month.endsWith('-12') ? 90_000 : 20_000));
    const emission = analyzeTrends(trendSnapshot(monthly(months, perMonth), months), [], DEFAULT_CONFIG);

    const spikes = emission.findings.filter((finding) => finding.detail['kind'] === 'spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0].detail['month']).toBe('2026-12');
  });

  it('reports three consecutive rises as an ongoing level, not a one-off', () => {
    const months = monthRange('2026-01', 6);
    const emission = analyzeTrends(
      trendSnapshot(monthly(months, [20_000, 20_000, 20_000, 30_000, 42_000, 56_000]), months),
      [],
      DEFAULT_CONFIG,
    );

    const climb = emission.findings.find((finding) => finding.detail['kind'] === 'climb');
    expect(climb).toBeDefined();
    expect(climb?.title).toBe('Dining has risen 3 months running');
    // A climb is a level: the category costs this much more every month, so ×12
    // is a forward figure rather than an annualized one-off.
    expect(climb?.impactAnnualCents).toBe((climb?.impactMonthlyCents ?? 0) * 12);
  });

  it('reports one sustained climb once, measured end to end (§9g)', () => {
    // Seven months of rises satisfy §5.10's three-month test in five overlapping
    // windows. They are one run and one story.
    const months = monthRange('2026-01', 10);
    const perMonth = [
      20_000, 20_000, 20_000, 30_000, 42_000, 56_000, 72_000, 90_000, 110_000, 132_000,
    ];
    const emission = analyzeTrends(trendSnapshot(monthly(months, perMonth), months), [], DEFAULT_CONFIG);

    const climbs = emission.findings.filter((finding) => finding.detail['kind'] === 'climb');
    expect(climbs).toHaveLength(1);
    // The whole run, not the last three months of it — in the figures and in
    // the sentence.
    expect(climbs[0].detail['fromMonth']).toBe('2026-03');
    expect(climbs[0].detail['toMonth']).toBe('2026-10');
    expect(climbs[0].detail['riseCents']).toBe(112_000);
    expect(climbs[0].title).toBe('Dining has risen 7 months running');
  });

  it('keeps two climbs that do not overlap', () => {
    const months = monthRange('2026-01', 12);
    const perMonth = [
      20_000, 30_000, 42_000, 58_000, 20_000, 20_000, 20_000, 30_000, 42_000, 58_000, 20_000,
      20_000,
    ];
    const emission = analyzeTrends(trendSnapshot(monthly(months, perMonth), months), [], DEFAULT_CONFIG);

    const climbs = emission.findings.filter((finding) => finding.detail['kind'] === 'climb');
    expect(climbs).toHaveLength(2);
    expect(climbs.map((finding) => finding.detail['toMonth']).sort()).toEqual([
      '2026-04',
      '2026-10',
    ]);
  });

  it('does not call an ordinary random walk a climb', () => {
    // §5.10: without the volatility test, "roughly twenty-five spurious climbs
    // per run". This category swings by hundreds routinely, so three rises of
    // the same size say nothing.
    const months = monthRange('2026-01', 12);
    const perMonth = [
      100_000, 40_000, 120_000, 30_000, 110_000, 35_000, 105_000, 45_000, 50_000, 60_000, 72_000,
      86_000,
    ];
    const emission = analyzeTrends(trendSnapshot(monthly(months, perMonth), months), [], DEFAULT_CONFIG);

    expect(emission.findings.filter((f) => f.detail['kind'] === 'climb')).toEqual([]);
  });

  it('skips a category one subscription dominates', () => {
    // §5.10: those are §5.2's and §5.5's, "which already cover better".
    const months = monthRange('2026-01', 5);
    const rows = months.map((month, index) =>
      tx(`${month}-05`, index === 4 ? 90_000 : 20_000, { categoryId: 'dining', merchantId: 'm1' }),
    );

    const series: RecurringSeries[] = [
      {
        id: 's1',
        merchantId: 'm1',
        accountId: 'a1',
        cadenceLabel: 'monthly',
        cadenceDays: 30.44,
        cadencesPerYear: 12,
        status: 'active',
        confidence: 0.9,
        basis: 'fitted',
        charges: rows.map((row) => ({
          transactionId: row.id,
          effectiveDate: row.effectiveDate,
          amountCents: row.amountCents,
        })),
        priceSteps: [],
        amountCentsCurrent: 20_000,
        amountCentsFirst: 20_000,
        firstSeen: rows[0].effectiveDate,
        lastSeen: rows[rows.length - 1].effectiveDate,
        nextExpected: '2026-06-05',
        occurrenceCount: 5,
        regularity: 1,
        isKnownSubscription: false,
        concurrentSeriesIds: [],
      },
    ];

    const emission = analyzeTrends(trendSnapshot(rows, months), series, DEFAULT_CONFIG);
    expect(emission.findings).toEqual([]);
  });

  it('caps at five spikes and five climbs (§5.10)', () => {
    const months = monthRange('2026-01', 12);
    const categories = Array.from({ length: 12 }, (_, index) => category(`c${index}`));
    const rows = categories.flatMap((entry) =>
      monthly(months, months.map((month) => (month.endsWith('-12') ? 900_000 : 20_000)), entry.id),
    );

    const emission = analyzeTrends(
      snapshot({ transactions: rows, accounts: [account('a1', months)], categories }),
      [],
      DEFAULT_CONFIG,
    );

    const spikes = emission.findings.filter((finding) => finding.detail['kind'] === 'spike');
    expect(spikes.length).toBeLessThanOrEqual(DEFAULT_CONFIG.trend.maxSpikes);
    expect(emission.findings.every((finding) => finding.ruleId === TREND_RULE_ID)).toBe(true);
  });

  it('keys a spike on its month, so two spikes do not overwrite each other', () => {
    const months = monthRange('2026-01', 11);
    const perMonth = months.map((month) =>
      month === '2026-05' || month === '2026-09' ? 90_000 : 20_000,
    );
    const emission = analyzeTrends(trendSnapshot(monthly(months, perMonth), months), [], DEFAULT_CONFIG);

    const spikes = emission.findings.filter((finding) => finding.detail['kind'] === 'spike');
    expect(new Set(spikes.map((finding) => finding.naturalKey)).size).toBe(spikes.length);
  });
});

// =============================================================== §5.11 micro ===

describe('micro.v1 (§5.11)', () => {
  /** `count` charges a month at `cents`, over `months`. */
  const often = (
    months: readonly string[],
    count: number,
    cents: number,
    overrides: Partial<SnapshotTransaction> = {},
  ): SnapshotTransaction[] =>
    months.flatMap((month) =>
      Array.from({ length: count }, (_, index) =>
        tx(`${month}-${String((index % 28) + 1).padStart(2, '0')}`, cents, overrides),
      ),
    );

  it('produces §5.11’s own example: the number nobody has seen', () => {
    const months = monthRange('2026-01', 12);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 19, 640, { merchantId: 'coffee' }),
        accounts: [account('a1', months)],
        merchants: [merchant('coffee', 'Coffee')],
      }),
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(1);
    const [finding] = emission.findings;
    expect(finding.title).toBe('Coffee: 19 charges/mo, $1,459/yr');
    expect(finding.impactMonthlyCents).toBe(12_160);
    expect(finding.impactAnnualCents).toBe(145_920);
    // §5.11: "this money is already being spent knowingly."
    expect(finding.impactKind).toBe('visibility');
  });

  it('needs the charges to be frequent', () => {
    const months = monthRange('2026-01', 12);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 7, 640, { merchantId: 'coffee' }),
        accounts: [account('a1', months)],
        merchants: [merchant('coffee')],
      }),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('needs them to be small', () => {
    const months = monthRange('2026-01', 12);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 19, 4000, { merchantId: 'lunch' }),
        accounts: [account('a1', months)],
        merchants: [merchant('lunch')],
      }),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('averages over fully-covered months only (§7.2)', () => {
    // Twelve months of charges but only six months anybody can vouch for. The
    // rate is measured over the six, not over twelve.
    const all = monthRange('2026-01', 12);
    const covered = all.slice(0, 6);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(all, 19, 640, { merchantId: 'coffee' }),
        accounts: [account('a1', covered)],
        merchants: [merchant('coffee', 'Coffee')],
      }),
      DEFAULT_CONFIG,
    );

    expect(emission.findings[0].detail['monthsObserved']).toBe(6);
    expect(emission.findings[0].detail['perMonth']).toBe(19);
  });

  it('reports a category built of many small merchants', () => {
    const months = monthRange('2026-01', 12);
    const rows = months.flatMap((month) =>
      Array.from({ length: 12 }, (_, index) =>
        tx(`${month}-${String(index + 1).padStart(2, '0')}`, 800, {
          categoryId: 'sundries',
          merchantId: `m${index}`,
        }),
      ),
    );

    const emission = analyzeMicroSpend(
      snapshot({
        transactions: rows,
        accounts: [account('a1', months)],
        categories: [category('sundries', 'spend', 'Sundries')],
        merchants: Array.from({ length: 12 }, (_, index) => merchant(`m${index}`)),
      }),
      DEFAULT_CONFIG,
    );

    // No single merchant is frequent enough on its own, which is exactly the
    // case §5.11's category half exists for.
    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].subjectType).toBe('category');
  });

  it('does not restate one qualifying merchant as its category too (§9g)', () => {
    const months = monthRange('2026-01', 12);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 19, 640, { merchantId: 'coffee', categoryId: 'dining' }),
        accounts: [account('a1', months)],
        merchants: [merchant('coffee', 'Coffee')],
        categories: [category('dining', 'spend', 'Dining')],
      }),
      DEFAULT_CONFIG,
    );

    expect(emission.findings).toHaveLength(1);
    expect(emission.findings[0].subjectType).toBe('merchant');
  });

  it('says nothing at all until there are months to average over', () => {
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(['2026-01'], 19, 640, { merchantId: 'coffee' }),
        accounts: [account('a1', ['2026-01'])],
        merchants: [merchant('coffee')],
      }),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('leaves transfers, pending and refunded rows out', () => {
    const months = monthRange('2026-01', 12);
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 19, 640, {
          merchantId: 'coffee',
          isInternalTransfer: true,
        }),
        accounts: [account('a1', months)],
        merchants: [merchant('coffee')],
      }),
      DEFAULT_CONFIG,
    );
    expect(emission.findings).toEqual([]);
  });

  it('takes its thresholds from the config (§7.4)', () => {
    const months = monthRange('2026-01', 12);
    const strict = resolveConfig({ micro: { minPerMonth: 25 } });
    const emission = analyzeMicroSpend(
      snapshot({
        transactions: often(months, 19, 640, { merchantId: 'coffee' }),
        accounts: [account('a1', months)],
        merchants: [merchant('coffee')],
      }),
      strict,
    );

    expect(emission.findings).toEqual([]);
    expect(MICRO_RULE_ID).toBe('micro.v1');
  });
});

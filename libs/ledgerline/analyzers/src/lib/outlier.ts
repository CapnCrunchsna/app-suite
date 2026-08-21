/**
 * `outlier.v1` — §5.9.
 *
 * "Robust statistics, not mean and standard deviation — a single $2,000 charge
 * inflates the mean enough to hide itself."
 *
 * ## The $25 floor is on every branch, and it is why the rule is usable
 *
 * §5.9 states it before it states the branches: "**Every branch below is
 * additionally subject to an absolute floor: the charge must exceed the
 * comparison median by at least $25**". Without it the rule fires constantly on
 * trivia, and §5.9 names both failures — "a coffee shop with a $6.40 median and a
 * $0.50 MAD flags a $9.80 latte at z = 4.6", and "the MAD=0 fallback flags a $7
 * transit fare against a $2 median". A statistically extreme charge that is three
 * dollars is not an outlier anybody wants a card about.
 *
 * ## Four branches, because the fourth catches what the first three cannot
 *
 * Per-merchant and per-category need a distribution, and the `MAD = 0` fallback
 * needs at least a median. **A one-off large charge at a merchant with no history
 * has none of those** — no sample, no dispersion, nothing to be unlike. That is
 * the charge most worth seeing, and §5.9's global branch exists for it alone.
 *
 * It is also the branch most able to bury the page, which is why §5.9 rewrites
 * the design session's version of it: "any debit above the 95th percentile of all
 * debits and $200" is, by definition, 5% of every transaction — "about a thousand
 * findings over ten years of data, and for most households the top of that
 * distribution is rent, mortgage, tuition and insurance — expected payments,
 * every one of them." So the global branch is the **ten largest** in a window,
 * above the 99th percentile and $200, excluding recurring series and internal
 * transfers, emitted as **one rollup**, not ten cards.
 *
 * ## Windows are calendar years, not a trailing twelve months
 *
 * §5.9 says "rolling twelve-month window". A window measured back from coverage
 * end moves every time a statement extends it, and §5.1 keys a finding on
 * `rule_id + subject_type + subject_id` — so a moving window would mint a new
 * finding on every import and orphan the dismissal on the old one. §5.1 makes
 * exactly this trade for §5.2's portfolio summary, "because the natural key has
 * to be stable across runs". Calendar years are the stable twelve-month window.
 * Recorded in §9g.
 *
 * ## Impact is the excess, and it is `visibility` throughout
 *
 * §5.9: "Presented as comparison, not judgment: '$412 at Merchant — typical is
 * $23.' `impact_kind = visibility` throughout; an outlier is information, not a
 * saving." The impact is therefore the amount by which the charge exceeded its
 * comparison median — the outlier-ness in dollars — which also makes §5.1's $25
 * floor and §5.9's own $25 floor the same test. `impactMonthlyCents` is zero: a
 * one-off charge has no monthly rate, and inventing one would put a recurring
 * number on a thing that happened once.
 */

import type { AnalyzerConfig, OutlierConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import type { RecurringSeries } from './recurrence.js';
import { clamp, median, modifiedZScore, percentile } from './statistics.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

export const OUTLIER_RULE_ID = 'outlier.v1';

interface Charge {
  readonly row: SnapshotTransaction;
  /** Magnitude, always positive — §5.9 compares sizes, not signed amounts. */
  readonly cents: number;
}

export function analyzeOutliers(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): RuleEmission {
  const settings = config.outlier;

  const charges: Charge[] = snapshot.transactions
    .filter(eligible)
    .map((row) => ({ row, cents: -row.amountCents }))
    .sort((a, b) => (a.row.effectiveDate < b.row.effectiveDate ? -1 : a.row.effectiveDate > b.row.effectiveDate ? 1 : a.row.id < b.row.id ? -1 : 1));

  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const categories = new Map(snapshot.categories.map((category) => [category.id, category]));
  const inSeries = new Set(
    series.flatMap((entry) => entry.charges.map((charge) => charge.transactionId)),
  );

  const byMerchant = againstGroup({
    charges,
    key: (charge) => charge.row.merchantId,
    subjectType: 'merchant',
    minSamples: settings.merchantMinSamples,
    label: (id) => merchants.get(id)?.displayName ?? 'this merchant',
    config,
  });

  /**
   * A charge its merchant already flagged is not flagged again by its category.
   *
   * §5.9 lists the two branches without saying what happens when they agree, and
   * on real data they agree constantly: a category containing one dominant
   * merchant produces the same charge twice, once as "$164 at Trader Joe's" and
   * once as "$164 at Groceries". §5.1 names that volume as "the failure mode that
   * gets a tool like this abandoned", so the pair collapses — and it collapses
   * onto the **merchant**, which is the more specific comparison and the more
   * useful sentence. Recorded in §9g.
   */
  const flaggedByMerchant = new Set(byMerchant.map((finding) => finding.subjectId));

  const drafts: DraftFinding[] = [
    ...byMerchant,
    ...againstGroup({
      charges,
      key: (charge) => charge.row.categoryId,
      subjectType: 'category',
      minSamples: settings.categoryMinSamples,
      label: (id) => categories.get(id)?.name ?? 'this category',
      config,
    }).filter((finding) => !flaggedByMerchant.has(finding.subjectId)),
    ...largestInEachYear(charges, inSeries, config),
  ];

  return applyEmissionPolicy(OUTLIER_RULE_ID, drafts, config);
}

/**
 * §2.5 and §5.9's eligibility.
 *
 * Debits only — a large *credit* is a refund or a paycheque, not an outlying
 * charge. Pending rows are out of "every analyzer and every total" (§2.5), a
 * refunded charge "is not spend, not an outlier, and not a series occurrence"
 * (§3.3), and an internal transfer is money moving rather than money spent
 * (§2.6) — §5.9 names that last exclusion itself for the global branch, and it is
 * as true of the other three.
 */
function eligible(row: SnapshotTransaction): boolean {
  return (
    row.amountCents < 0 &&
    !row.isPending &&
    !row.isExcluded &&
    !row.isInternalTransfer &&
    row.refundPairId === null
  );
}

// ------------------------------------------------- branches 1, 2 and 3 ---

interface GroupInput {
  readonly charges: readonly Charge[];
  readonly key: (charge: Charge) => string | null;
  readonly subjectType: 'merchant' | 'category';
  readonly minSamples: number;
  readonly label: (id: string) => string;
  readonly config: AnalyzerConfig;
}

/**
 * §5.9's first three branches, which differ only in what they group by and how
 * many members they need first.
 *
 * A charge is compared against **the other members of its group**, its own value
 * included in the median — which is the conservative direction: leaving it out
 * would lower the median it is measured against and make it look more extreme
 * than it is.
 */
function againstGroup(input: GroupInput): DraftFinding[] {
  const settings = input.config.outlier;
  const groups = new Map<string, Charge[]>();

  for (const charge of input.charges) {
    const id = input.key(charge);
    if (id === null) continue;
    const existing = groups.get(id);
    if (existing) existing.push(charge);
    else groups.set(id, [charge]);
  }

  const drafts: DraftFinding[] = [];

  for (const [id, members] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (members.length < input.minSamples) continue;

    const sample = members.map((charge) => charge.cents);
    const centre = median(sample);

    for (const charge of members) {
      const excess = charge.cents - centre;
      // §5.9's floor, on every branch and checked before the statistics: a charge
      // that is $3 above typical is not worth a card however extreme its z-score.
      if (excess < settings.minExcessCents) continue;

      const z = modifiedZScore(charge.cents, sample);
      const verdict = z === null ? steady(charge, centre, settings) : byZScore(z, settings);
      if (!verdict) continue;

      drafts.push({
        ruleId: OUTLIER_RULE_ID,
        ruleVersion: OUTLIER_RULE_ID,
        subjectType: input.subjectType,
        // The transaction, not the group: §5.9 flags *this charge*, and a group
        // with two outliers is two findings rather than one that overwrites the
        // other under §5.1's natural key.
        subjectId: charge.row.id,
        title: `${formatShort(charge.cents)} at ${input.label(id)} — typical is ${formatShort(centre)}`,
        detail: {
          basis: verdict.basis,
          transactionId: charge.row.id,
          accountId: charge.row.accountId,
          merchantId: charge.row.merchantId,
          categoryId: charge.row.categoryId,
          groupType: input.subjectType,
          groupId: id,
          at: charge.row.effectiveDate,
          descriptor: charge.row.descriptionNormalized,
          amountCents: charge.cents,
          medianCents: Math.round(centre),
          excessCents: Math.round(excess),
          multipleOfMedian: centre === 0 ? null : Number((charge.cents / centre).toFixed(2)),
          zScore: z === null ? null : Number(z.toFixed(2)),
          sampleSize: members.length,
        },
        evidenceTransactionIds: [charge.row.id],
        confidence: verdict.confidence,
        impactKind: 'visibility',
        impactMonthlyCents: 0,
        impactAnnualCents: Math.round(excess),
        llmDependent: false,
        evidenceHash: evidenceHash({
          ruleId: OUTLIER_RULE_ID,
          subjectId: charge.row.id,
          amountCents: charge.cents,
          cadenceLabel: null,
          seriesStatus: null,
        }),
      });
    }
  }

  return drafts;
}

interface Verdict {
  readonly basis: 'z_score' | 'steady_median';
  readonly confidence: number;
}

function byZScore(z: number, config: OutlierConfig): Verdict | null {
  if (Math.abs(z) <= config.zThreshold) return null;
  return {
    basis: 'z_score',
    confidence: clamp(
      config.zConfidenceBase + (Math.abs(z) - config.zThreshold) * config.zConfidencePerPoint,
      0,
      config.zConfidenceMax,
    ),
  };
}

/**
 * §5.9's `MAD = 0` branch: "a perfectly steady charge [...] fall back to flagging
 * anything above `3 × median`, still subject to the $25 floor."
 *
 * There is no dispersion to measure against, so the multiple stands in for the
 * z-score — and the floor is doing more work here than anywhere else, because a
 * perfectly steady $2 fare makes every $7 one three times the median.
 */
function steady(charge: Charge, centre: number, config: OutlierConfig): Verdict | null {
  if (centre <= 0 || charge.cents <= centre * config.steadyMultiple) return null;
  return { basis: 'steady_median', confidence: config.steadyConfidence };
}

// --------------------------------------------------------- branch 4 ---

/**
 * §5.9's global branch: the ten largest debits in each window, above the 99th
 * percentile and $200, excluding recurring series and internal transfers —
 * **one rollup finding per window, not ten cards**.
 *
 * The exclusions are what make the list interesting rather than a list of rent
 * payments. A recurring series is already §5.2's, and its members are the
 * *expected* large charges; an internal transfer is not spending at all.
 */
function largestInEachYear(
  charges: readonly Charge[],
  inSeries: ReadonlySet<string>,
  config: AnalyzerConfig,
): DraftFinding[] {
  const settings = config.outlier;

  const byYear = new Map<string, Charge[]>();
  for (const charge of charges) {
    // Filtered *before* the percentile, not after. §5.9's conditions all describe
    // the debits being ranked, and the order matters more than it looks: a
    // household's twelve rent payments occupy the whole top of the distribution,
    // so a percentile taken over them sets the bar above every one-off charge —
    // and the one-off charge at a merchant with no history is the only thing this
    // branch exists to find.
    if (inSeries.has(charge.row.id)) continue;

    const year = charge.row.effectiveDate.slice(0, 4);
    const existing = byYear.get(year);
    if (existing) existing.push(charge);
    else byYear.set(year, [charge]);
  }

  const drafts: DraftFinding[] = [];

  for (const [year, window] of [...byYear.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // A 99th percentile over six debits is the largest of them by construction.
    // §5.9 sets a minimum sample for its other two branches and not for this one;
    // without a floor the rule would announce "the largest charges of 2026" to
    // anyone who bought a laptop. See §9g.
    if (window.length < settings.globalMinSamples) continue;

    const cut = percentile(
      window.map((charge) => charge.cents),
      settings.globalPercentile,
    );

    const flagged = window
      .filter((charge) => charge.cents >= settings.globalMinCents && charge.cents >= cut)
      .sort((a, b) => b.cents - a.cents || (a.row.id < b.row.id ? -1 : 1))
      .slice(0, settings.globalTopN);

    if (flagged.length === 0) continue;

    const totalCents = flagged.reduce((total, charge) => total + charge.cents, 0);

    drafts.push({
      ruleId: OUTLIER_RULE_ID,
      ruleVersion: OUTLIER_RULE_ID,
      subjectType: 'window',
      subjectId: year,
      title: `${flagged.length} unusually large ${flagged.length === 1 ? 'charge' : 'charges'} in ${year}`,
      detail: {
        kind: 'largest_in_window',
        window: year,
        thresholdCents: Math.round(cut),
        floorCents: settings.globalMinCents,
        totalCents,
        charges: flagged.map((charge) => ({
          transactionId: charge.row.id,
          accountId: charge.row.accountId,
          at: charge.row.effectiveDate,
          descriptor: charge.row.descriptionNormalized,
          amountCents: charge.cents,
        })),
      },
      evidenceTransactionIds: flagged.map((charge) => charge.row.id),
      confidence: settings.globalConfidence,
      impactKind: 'visibility',
      impactMonthlyCents: 0,
      // No comparison median exists on this branch — nothing here is being
      // measured against a distribution — so the figure is what the flagged
      // charges came to. `visibility`, so it never joins a headline (§7.3).
      impactAnnualCents: totalCents,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: OUTLIER_RULE_ID,
        subjectId: year,
        amountCents: totalCents,
        cadenceLabel: null,
        seriesStatus: null,
      }),
    });
  }

  return drafts;
}

/** `$412` — whole dollars, for a title. The cents live in the detail, where
 *  `formatCents` renders them (§7.3). */
function formatShort(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

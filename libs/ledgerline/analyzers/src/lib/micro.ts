/**
 * `micro.v1` — §5.11.
 *
 * "Merchants or categories averaging ≥8 transactions per month across
 * fully-covered months, at a median ≤$15. No judgment attached — the finding
 * *is* the annualized arithmetic: 'coffee: 19 transactions/month averaging $6.40
 * = $122/mo, **$1,459/yr**.' Most people have never seen that number, and seeing
 * it is the entire value."
 *
 * ## The rule that does the least, deliberately
 *
 * There is no threshold to tune here beyond "often" and "small", no confidence to
 * derive and nothing inferred. §5.11 is a *sum*, presented. The one thing it must
 * not do is imply a verdict: this is money the user is already choosing to spend,
 * which is why §5.11 pins `impact_kind = visibility` and says why — "adding it to
 * a 'savings' headline that also counts the same transactions in a category trend
 * would make the headline fiction." §7.3 is the rule that makes it fiction, and
 * this rule is one of the two it was written about.
 *
 * ## Fully-covered months, and why the average would otherwise lie
 *
 * The figure is a *rate* — transactions per month — so it inherits §7.2 exactly
 * as §5.10 does. A month where one of three accounts had been imported contains a
 * fraction of that month's coffees, and dividing by it understates the rate;
 * a month with no statement at all and no rows would understate it further.
 * Averaging over months the data can vouch for is what makes "19 a month" a
 * number rather than an artefact of when statements arrived.
 *
 * ## Both subjects, minus the one that is the other restated
 *
 * §5.11 says "Merchants **or** categories" and both are worth seeing: the
 * merchant answers "how much at this one place", the category answers "how much
 * on this kind of thing". They are both `visibility`, so §7.3 is safe either way.
 * A category that is a single qualifying merchant wearing a different hat is
 * suppressed — the same dominance test §5.10 uses and for the same reason, since
 * two cards saying one thing is the noise §5.1 cares most about. Recorded in §9g.
 */

import type { AnalyzerConfig, MicroConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import { median } from './statistics.js';
import { fullyCoveredMonths, llmAttributedIds, monthOf } from './snapshot.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

export const MICRO_RULE_ID = 'micro.v1';

interface Group {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly SnapshotTransaction[];
}

interface Qualified {
  readonly group: Group;
  readonly perMonth: number;
  readonly medianCents: number;
  readonly monthlyCents: number;
  readonly annualCents: number;
  readonly totalCents: number;
}

export function analyzeMicroSpend(snapshot: Snapshot, config: AnalyzerConfig): RuleEmission {
  const settings = config.micro;

  const covered = fullyCoveredMonths(snapshot.accounts);
  if (covered.size < settings.minMonths) {
    return applyEmissionPolicy(MICRO_RULE_ID, [], config);
  }

  const rows = snapshot.transactions.filter(
    (row) => eligible(row) && covered.has(monthOf(row.effectiveDate)),
  );

  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const categories = new Map(snapshot.categories.map((category) => [category.id, category]));

  const byMerchant = qualify(
    group(rows, (row) => row.merchantId, (id) => merchants.get(id)?.displayName ?? id),
    covered.size,
    settings,
  );
  const byCategory = qualify(
    group(rows, (row) => row.categoryId, (id) => categories.get(id)?.name ?? id),
    covered.size,
    settings,
  );

  const drafts: DraftFinding[] = [
    ...byMerchant.map((entry) => draft(entry, 'merchant', covered.size, settings)),
    ...byCategory
      .filter((entry) => !dominatedByOneMerchant(entry, byMerchant, settings))
      .map((entry) => draft(entry, 'category', covered.size, settings)),
  ];

  return applyEmissionPolicy(MICRO_RULE_ID, drafts, config, {
    llmAttributed: llmAttributedIds(snapshot),
  });
}

const eligible = (row: SnapshotTransaction): boolean =>
  row.amountCents < 0 &&
  !row.isPending &&
  !row.isExcluded &&
  !row.isInternalTransfer &&
  row.refundPairId === null;

function group(
  rows: readonly SnapshotTransaction[],
  key: (row: SnapshotTransaction) => string | null,
  label: (id: string) => string,
): Group[] {
  const groups = new Map<string, SnapshotTransaction[]>();
  for (const row of rows) {
    const id = key(row);
    if (id === null) continue;
    const existing = groups.get(id);
    if (existing) existing.push(row);
    else groups.set(id, [row]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, members]) => ({ id, label: label(id), rows: members }));
}

/** §5.11's two tests: **often** (≥8 a month) and **small** (median ≤$15). */
function qualify(
  groups: readonly Group[],
  months: number,
  config: MicroConfig,
): Qualified[] {
  const qualified: Qualified[] = [];

  for (const entry of groups) {
    const perMonth = entry.rows.length / months;
    if (perMonth < config.minPerMonth) continue;

    const amounts = entry.rows.map((row) => -row.amountCents);
    const medianCents = median(amounts);
    if (!Number.isFinite(medianCents) || medianCents > config.maxMedianCents) continue;

    const totalCents = amounts.reduce((sum, cents) => sum + cents, 0);
    // Over the covered months, then ×12 — not `median × count`, which would
    // quietly replace the real spend with an idealised one.
    const monthlyCents = Math.round(totalCents / months);

    qualified.push({
      group: entry,
      perMonth,
      medianCents,
      monthlyCents,
      annualCents: monthlyCents * 12,
      totalCents,
    });
  }

  return qualified;
}

/**
 * §5.10's dominance test, borrowed: a category more than `fraction` of which is
 * one already-reported merchant is that merchant restated.
 *
 * Only *qualifying* merchants count. A category made of thirty small merchants,
 * none of which is frequent enough on its own, is exactly the finding §5.11 is
 * for — "this kind of thing costs you $1,459/yr" — and must survive.
 */
function dominatedByOneMerchant(
  category: Qualified,
  merchants: readonly Qualified[],
  config: MicroConfig,
): boolean {
  const ids = new Set(category.group.rows.map((row) => row.id));

  return merchants.some((merchant) => {
    const shared = merchant.group.rows
      .filter((row) => ids.has(row.id))
      .reduce((sum, row) => sum + -row.amountCents, 0);
    return category.totalCents > 0 && shared / category.totalCents > config.merchantDominanceFraction;
  });
}

function draft(
  entry: Qualified,
  subjectType: 'merchant' | 'category',
  months: number,
  config: MicroConfig,
): DraftFinding {
  const perMonth = Math.round(entry.perMonth);

  return {
    ruleId: MICRO_RULE_ID,
    ruleVersion: MICRO_RULE_ID,
    subjectType,
    subjectId: entry.group.id,
    // §5.11's own sentence shape: the count, the size, and the number nobody has
    // seen. No adjective — the arithmetic is the finding.
    title: `${entry.group.label}: ${perMonth} ${perMonth === 1 ? 'charge' : 'charges'}/mo, ${dollars(entry.annualCents)}/yr`,
    detail: {
      subjectType,
      [subjectType === 'merchant' ? 'merchantId' : 'categoryId']: entry.group.id,
      label: entry.group.label,
      transactionCount: entry.group.rows.length,
      monthsObserved: months,
      perMonth: Number(entry.perMonth.toFixed(1)),
      medianCents: Math.round(entry.medianCents),
      monthlyCents: entry.monthlyCents,
      annualCents: entry.annualCents,
      observedTotalCents: entry.totalCents,
    },
    evidenceTransactionIds: entry.group.rows.map((row) => row.id),
    confidence: config.confidence,
    // §5.11, by name: "this money is already being spent knowingly".
    impactKind: 'visibility',
    impactMonthlyCents: entry.monthlyCents,
    impactAnnualCents: entry.annualCents,
    llmDependent: false,
    evidenceHash: evidenceHash({
      ruleId: MICRO_RULE_ID,
      subjectId: entry.group.id,
      amountCents: entry.annualCents,
      cadenceLabel: null,
      seriesStatus: null,
    }),
  };
}

const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

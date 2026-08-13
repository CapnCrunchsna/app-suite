/**
 * `duplicate.v1` — §5.4.
 *
 * Two rules under one id, "deliberately weighted differently, and **separately
 * toggleable in Settings** — one claims an error, the other claims nothing."
 *
 * **Same-merchant multiplicity** is the accusation: two or more *concurrent*
 * series for one canonical merchant, which is usually a double-charged account
 * or a personal plan still billing after a family plan started. It carries the
 * higher confidence and it is the only one of the two that claims `savings`.
 *
 * **Category overlap** is not an accusation. Owning both Netflix and Disney+ is a
 * legitimate choice; the app's job is to make the total visible, not to nag. So
 * the wording is a total rather than a verdict, and `impact_kind = visibility`
 * keeps it out of the savings headline entirely (§7.3).
 *
 * ## Concurrency is the whole guard, and it is not re-derived here
 *
 * §5.2 pass 3 already decided which series interleave — both charging in the
 * same period for at least two consecutive cycles — and recorded it as
 * `concurrentSeriesIds`. §5.3 forbids re-deriving it, and the reason is specific
 * rather than stylistic: without the concurrency requirement this rule fires on
 * **every subscription that ever changed price**, because a price change leaves
 * two amount clusters for one merchant. That false positive would arrive at 0.85
 * confidence with an accusatory title, which is the worst combination available.
 */

import type { AnalyzerConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import type { RecurringSeries } from './recurrence.js';
import type { Snapshot } from './snapshot.js';

export const DUPLICATE_RULE_ID = 'duplicate.v1';

export function analyzeDuplicates(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): RuleEmission {
  const drafts: DraftFinding[] = [
    ...(config.duplicate.sameMerchantEnabled ? sameMerchant(snapshot, series, config) : []),
    ...(config.duplicate.categoryOverlapEnabled ? categoryOverlap(snapshot, series, config) : []),
  ];

  return applyEmissionPolicy(DUPLICATE_RULE_ID, drafts, config);
}

// ------------------------------------------------ same-merchant multiplicity ---

/**
 * Impact is **the cheaper series' annual cost** (§5.4), not the sum and not the
 * dearer one. That is the number that would stop leaving if the duplicate were
 * cancelled: whatever else happens, one of the two plans is presumably wanted.
 * Claiming the total would double-count a subscription the user intends to keep.
 */
function sameMerchant(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): DraftFinding[] {
  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const drafts: DraftFinding[] = [];

  for (const group of concurrentGroups(series, byId)) {
    const merchant = merchants.get(group[0].merchantId);
    const annualCosts = group.map(annualCentsOf);
    const cheapest = Math.min(...annualCosts);

    // Anchored on the earliest series so the natural key is stable as later ones
    // come and go — §5.1's lifecycle is an upsert, and a key that moved would
    // orphan the user's dismissal every time the group changed shape.
    const anchor = [...group].sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1))[0];

    drafts.push({
      ruleId: DUPLICATE_RULE_ID,
      ruleVersion: DUPLICATE_RULE_ID,
      subjectType: 'series',
      subjectId: anchor.id,
      title: `${group.length} concurrent ${merchant?.displayName ?? 'merchant'} subscriptions`,
      detail: {
        kind: 'same_merchant',
        merchantId: anchor.merchantId,
        seriesIds: group.map((entry) => entry.id),
        annualCentsEach: annualCosts,
        cheapestAnnualCents: cheapest,
        accountIds: [...new Set(group.map((entry) => entry.accountId))],
      },
      evidenceTransactionIds: group.flatMap((entry) =>
        entry.charges.map((charge) => charge.transactionId),
      ),
      confidence: config.duplicate.sameMerchantConfidence,
      impactKind: 'savings',
      impactMonthlyCents: Math.round(cheapest / 12),
      impactAnnualCents: cheapest,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: DUPLICATE_RULE_ID,
        subjectId: anchor.id,
        amountCents: cheapest,
        cadenceLabel: anchor.cadenceLabel,
        seriesStatus: group.map((entry) => entry.status).join(','),
      }),
    });
  }

  return drafts;
}

/** Connected components over §5.2's concurrency links, so three plans billing at
 *  once are one finding rather than three pairs. */
function concurrentGroups(
  series: readonly RecurringSeries[],
  byId: ReadonlyMap<string, RecurringSeries>,
): RecurringSeries[][] {
  const seen = new Set<string>();
  const groups: RecurringSeries[][] = [];

  for (const entry of series) {
    if (seen.has(entry.id) || entry.concurrentSeriesIds.length === 0) continue;

    const group: RecurringSeries[] = [];
    const queue = [entry.id];

    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);

      const member = byId.get(id);
      if (!member) continue;
      group.push(member);
      queue.push(...member.concurrentSeriesIds);
    }

    if (group.length >= 2) groups.push(group);
  }

  return groups;
}

// ------------------------------------------------------- category overlap ---

/**
 * §5.4 calls the overlap group "a curated subset of **categories** where
 * redundancy is meaningful (video streaming, music streaming, cloud storage,
 * VPN, password manager, meal kit, news)", and §3.1 puts an `overlap_group`
 * column on both `merchant_canonical` and `category`.
 *
 * A series has a merchant but no single category — its charges may be
 * categorized inconsistently — so the merchant's group is read first and the
 * charges' categories are the fallback. Today that fallback is dead: §9a records
 * that `SEED_CATEGORIES` leaves `overlap_group` unset on every row, because
 * guessing which services overlap before this rule existed would have been
 * inventing the answer to its hardest question. It is written anyway because the
 * column is in the schema and the day it is populated should not need this file
 * to change.
 */
function categoryOverlap(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): DraftFinding[] {
  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const categories = new Map(snapshot.categories.map((category) => [category.id, category]));
  const categoryOf = new Map(
    snapshot.transactions.map((transaction) => [transaction.id, transaction.categoryId]),
  );

  const groups = new Map<string, RecurringSeries[]>();

  for (const entry of series) {
    if (entry.status !== 'active') continue;

    const group =
      merchants.get(entry.merchantId)?.overlapGroup ??
      modalCategoryOverlapGroup(entry, categoryOf, categories);
    if (!group) continue;

    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }

  const drafts: DraftFinding[] = [];

  for (const [group, members] of groups) {
    if (members.length < 2) continue;

    const annualCents = members.reduce((total, entry) => total + annualCentsOf(entry), 0);
    const monthlyCents = Math.round(annualCents / 12);

    drafts.push({
      ruleId: DUPLICATE_RULE_ID,
      ruleVersion: DUPLICATE_RULE_ID,
      subjectType: 'category',
      subjectId: group,
      title: `${members.length} ${group.replace(/_/g, ' ')} subscriptions`,
      detail: {
        kind: 'category_overlap',
        overlapGroup: group,
        seriesIds: members.map((entry) => entry.id),
        merchantIds: members.map((entry) => entry.merchantId),
        monthlyCents,
        annualCents,
      },
      evidenceTransactionIds: members.flatMap((entry) =>
        entry.charges.map((charge) => charge.transactionId),
      ),
      confidence: config.duplicate.categoryOverlapConfidence,
      // §7.3: this money is being spent knowingly. Summing it into the savings
      // headline alongside a price-creep delta on one of these very series would
      // claim the same dollars twice.
      impactKind: 'visibility',
      impactMonthlyCents: monthlyCents,
      impactAnnualCents: annualCents,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: DUPLICATE_RULE_ID,
        subjectId: group,
        amountCents: annualCents,
        cadenceLabel: null,
        seriesStatus: `${members.length}`,
      }),
    });
  }

  return drafts;
}

function modalCategoryOverlapGroup(
  entry: RecurringSeries,
  categoryOf: ReadonlyMap<string, string | null>,
  categories: ReadonlyMap<string, { readonly overlapGroup: string | null }>,
): string | null {
  const counts = new Map<string, number>();

  for (const charge of entry.charges) {
    const categoryId = categoryOf.get(charge.transactionId);
    if (!categoryId) continue;
    const group = categories.get(categoryId)?.overlapGroup;
    if (!group) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [group, count] of counts) {
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }

  return best;
}

/** §5.3: `cadences_per_year` is stored on the series precisely so this
 *  multiplication cannot disagree between rules. */
export function annualCentsOf(entry: RecurringSeries): number {
  return Math.round(entry.amountCentsCurrent * entry.cadencesPerYear);
}

/**
 * `fees.v1` — §5.8.
 *
 * "Whole-token keyword match on normalized descriptors **or**
 * `category.kind = 'fee'` — either qualifies, because a fee whose category was
 * never assigned is still a fee."
 *
 * ## The three qualifications are the rule
 *
 * §5.8 calls them "three qualifications the design session omitted, each of which
 * produces wrong numbers without them", and each one is a different way of being
 * wrong:
 *
 * - **Debits only.** On a savings account `INTEREST` is income; on a credit card it is a charge. Sign disambiguates them and nothing else does — the same descriptor, the same keyword, opposite meanings.
 * - **Exclusions.** `INTEREST CHECKING` and `INTEREST EARNED` are account *descriptors*, and `LATE FEE REVERSAL` is the opposite of a late fee. Both would otherwise match on the strength of a substring.
 * - **Reversals net to zero.** "A refunded fee that still shows in an annual total is the kind of error that costs the whole tool its credibility."
 *
 * ## One rollup per account, and where the savings half went
 *
 * §5.8 asks for "**one rollup finding per account**, not one per transaction — a
 * per-transaction finding for every $3 ATM fee is noise", and in the same breath
 * for the recurring maintenance fees to be "the part that carries
 * `impact_kind = savings`; the rest is `visibility`". A `Finding` carries one
 * `impact_kind`, so those two sentences cannot both be satisfied literally.
 *
 * They are reconciled by putting **only the avoidable subset in the impact**: a
 * card with fees a waiver could have prevented is a `savings` finding whose
 * impact is exactly that subset, and the full total travels in the detail where
 * §7.3's headline cannot reach it. An account with no avoidable fees emits the
 * same one card as `visibility` with the total as its impact — otherwise §5.1's
 * $25 floor would suppress a real $340/yr fee total for having nothing avoidable
 * in it. Recorded in §9g.
 */

import { addDaysIso } from '@metrum/ledgerline-domain';

import type { AnalyzerConfig, FeesConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import { monthOf } from './snapshot.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

export const FEES_RULE_ID = 'fees.v1';

/** How a row qualified. §5.8 prices the two differently: 0.95 on a keyword hit,
 *  0.75 when only the category vouched for it. */
type FeeBasis = 'keyword' | 'category';

interface FeeCharge {
  readonly transaction: SnapshotTransaction;
  readonly basis: FeeBasis;
  /** The keyword that matched, for the breakdown and for the avoidable test. */
  readonly keyword: string | null;
  /** Magnitude, always positive. */
  readonly amountCents: number;
}

export function analyzeFees(snapshot: Snapshot, config: AnalyzerConfig): RuleEmission {
  const settings = config.fees;
  const feeCategories = new Set(
    snapshot.categories.filter((category) => category.kind === 'fee').map((category) => category.id),
  );
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));

  const byAccount = new Map<string, FeeCharge[]>();

  for (const row of snapshot.transactions) {
    if (!eligible(row)) continue;

    const match = classify(row, feeCategories, settings);
    if (!match) continue;

    const existing = byAccount.get(row.accountId);
    if (existing) existing.push(match);
    else byAccount.set(row.accountId, [match]);
  }

  const drafts: DraftFinding[] = [];

  for (const [accountId, charges] of [...byAccount.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const kept = netOutReversals(charges, snapshot.transactions, settings);
    if (kept.length === 0) continue;

    const totalCents = kept.reduce((total, charge) => total + charge.amountCents, 0);
    const months = observedMonths(kept);
    const annualise = (cents: number): number => Math.round((cents * 12) / months);

    const avoidable = avoidableSubset(kept, settings);
    const avoidableCents = avoidable.reduce((total, charge) => total + charge.amountCents, 0);

    const byKeyword = breakdown(kept);
    const account = accounts.get(accountId);

    // The impact is the avoidable subset where there is one, and the whole total
    // where there is not. See the header — this is what lets one card satisfy
    // both of §5.8's sentences.
    const impactCents = avoidableCents > 0 ? avoidableCents : totalCents;
    const impactKind = avoidableCents > 0 ? 'savings' : 'visibility';

    drafts.push({
      ruleId: FEES_RULE_ID,
      ruleVersion: FEES_RULE_ID,
      subjectType: 'account',
      subjectId: accountId,
      title: `${account?.displayName ?? 'Account'} paid ${describe(kept.length)} in fees`,
      detail: {
        accountId,
        // Both figures, always, so the card can say "$340 in fees, $144 of it
        // avoidable" without the reader having to work out which one the impact
        // above is.
        totalCents,
        totalMonthlyCents: Math.round(annualise(totalCents) / 12),
        totalAnnualCents: annualise(totalCents),
        avoidableCents,
        avoidableAnnualCents: annualise(avoidableCents),
        avoidableKeywords: [...new Set(avoidable.map((charge) => charge.keyword))].filter(
          (keyword): keyword is string => keyword !== null,
        ),
        feeCount: kept.length,
        reversedCount: charges.length - kept.length,
        monthsObserved: months,
        firstAt: kept[0].transaction.effectiveDate,
        lastAt: kept[kept.length - 1].transaction.effectiveDate,
        byKeyword,
      },
      evidenceTransactionIds: kept.map((charge) => charge.transaction.id),
      confidence: kept.some((charge) => charge.basis === 'keyword')
        ? settings.keywordConfidence
        : settings.categoryOnlyConfidence,
      impactKind,
      impactMonthlyCents: Math.round(annualise(impactCents) / 12),
      impactAnnualCents: annualise(impactCents),
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: FEES_RULE_ID,
        subjectId: accountId,
        amountCents: totalCents,
        cadenceLabel: null,
        seriesStatus: null,
      }),
    });
  }

  return applyEmissionPolicy(FEES_RULE_ID, drafts, config);
}

// ------------------------------------------------------------------ matching ---

/**
 * §5.8's first qualification, plus the eligibility every rule shares.
 *
 * **Debits only** is the load-bearing half: `INTEREST` on a savings statement is
 * money arriving and on a card statement is money leaving, and the sign is the
 * only thing that tells them apart.
 */
function eligible(row: SnapshotTransaction): boolean {
  return (
    row.amountCents < 0 && !row.isPending && !row.isExcluded && !row.isInternalTransfer &&
    row.refundPairId === null
  );
}

function classify(
  row: SnapshotTransaction,
  feeCategories: ReadonlySet<string>,
  config: FeesConfig,
): FeeCharge | null {
  const descriptor = row.descriptionNormalized;

  // §5.8's exclusion list, checked before anything can match: these are account
  // descriptors and reversals, and a keyword inside one is not a fee.
  if (config.excludedPhrases.some((phrase) => descriptor.includes(phrase))) return null;
  if (config.disqualifyingTokens.some((token) => hasToken(descriptor, token))) return null;

  const keyword = config.keywords.find((candidate) => hasPhrase(descriptor, candidate)) ?? null;
  if (keyword !== null) {
    return { transaction: row, basis: 'keyword', keyword, amountCents: -row.amountCents };
  }

  // §5.8: "a fee whose category was never assigned is still a fee" — and the
  // converse, a fee-kind category with no recognisable keyword, is still a fee.
  if (row.categoryId !== null && feeCategories.has(row.categoryId)) {
    return { transaction: row, basis: 'category', keyword: null, amountCents: -row.amountCents };
  }

  return null;
}

/**
 * Whole-token matching, which §5.8 asks for by name.
 *
 * A substring test would make `NSF` match `TRANSFERS` and `ATM FEE` match inside
 * a longer word. The phrase has to sit on token boundaries in the descriptor.
 */
function hasPhrase(descriptor: string, phrase: string): boolean {
  const at = descriptor.indexOf(phrase);
  if (at === -1) return false;
  const before = at === 0 ? ' ' : descriptor[at - 1];
  const afterIndex = at + phrase.length;
  const after = afterIndex >= descriptor.length ? ' ' : descriptor[afterIndex];
  return !isWordChar(before) && !isWordChar(after);
}

const hasToken = (descriptor: string, token: string): boolean => hasPhrase(descriptor, token);

const isWordChar = (character: string): boolean => /[A-Z0-9]/.test(character);

// ----------------------------------------------------------------- reversals ---

/**
 * §5.8's third qualification: "A fee credited back within 60 days at the same
 * account and amount is netted to zero."
 *
 * One-to-one and nearest-first, so two $35 fees followed by one $35 credit net
 * one of them rather than both. The predicate is §5.8's, verbatim — same account,
 * same amount, inside the window — and it is deliberately not narrowed to credits
 * that *look* like reversals. That can over-net: an unrelated $35 deposit inside
 * the window will cancel a real fee. The direction of that error is the one §5.8
 * chose, and says why: a refunded fee left in an annual total is what "costs the
 * whole tool its credibility", and under-reporting a fee costs it a line item.
 */
function netOutReversals(
  charges: readonly FeeCharge[],
  transactions: readonly SnapshotTransaction[],
  config: FeesConfig,
): FeeCharge[] {
  const ordered = [...charges].sort(byDateThenId);
  const spent = new Set<string>();
  const kept: FeeCharge[] = [];

  for (const charge of ordered) {
    const from = charge.transaction.effectiveDate;
    const to = addDaysIso(from, config.reversalWindowDays);

    const credit = transactions
      .filter(
        (row) =>
          row.accountId === charge.transaction.accountId &&
          row.amountCents === charge.amountCents &&
          !row.isPending &&
          !row.isExcluded &&
          row.effectiveDate >= from &&
          row.effectiveDate <= to &&
          !spent.has(row.id),
      )
      .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : a.id < b.id ? -1 : 1))[0];

    if (credit) spent.add(credit.id);
    else kept.push(charge);
  }

  return kept;
}

// ----------------------------------------------------------------- the parts ---

/**
 * §5.8's avoidable subset: recurring maintenance fees, "they usually have a
 * fee-waiver condition".
 *
 * Recurring is what makes a waiver worth chasing — a single monthly-maintenance
 * charge on a month the balance dipped is not a standing condition, and calling
 * it a saving would put a number on the headline that acting could not recover.
 */
function avoidableSubset(charges: readonly FeeCharge[], config: FeesConfig): FeeCharge[] {
  const counts = new Map<string, number>();
  for (const charge of charges) {
    if (charge.keyword === null) continue;
    counts.set(charge.keyword, (counts.get(charge.keyword) ?? 0) + 1);
  }

  return charges.filter(
    (charge) =>
      charge.keyword !== null &&
      config.avoidableKeywords.includes(charge.keyword) &&
      (counts.get(charge.keyword) ?? 0) >= config.avoidableMinOccurrences,
  );
}

/** The per-keyword breakdown §5.8 asks the rollup to carry. `uncategorized` is
 *  the category-only bucket: those rows have no keyword to name. */
function breakdown(charges: readonly FeeCharge[]): Record<string, { count: number; cents: number }> {
  const totals: Record<string, { count: number; cents: number }> = {};
  for (const charge of charges) {
    const key = charge.keyword ?? 'fee category';
    const bucket = (totals[key] ??= { count: 0, cents: 0 });
    bucket.count += 1;
    bucket.cents += charge.amountCents;
  }
  return totals;
}

/**
 * The span the annual figure is extrapolated from, in months.
 *
 * Measured over the fees themselves rather than the account's coverage, and the
 * difference matters in one direction: a card with two years of statements and
 * one $35 fee in the first month should not report `$35 × 12 = $420/yr`. The
 * span between the first and last fee is the honest denominator, floored at one
 * so a single fee annualizes as itself rather than dividing by zero.
 */
function observedMonths(charges: readonly FeeCharge[]): number {
  const first = charges[0].transaction.effectiveDate;
  const last = charges[charges.length - 1].transaction.effectiveDate;
  const months =
    (Number(monthOf(last).slice(0, 4)) - Number(monthOf(first).slice(0, 4))) * 12 +
    (Number(monthOf(last).slice(5, 7)) - Number(monthOf(first).slice(5, 7))) +
    1;
  return Math.max(months, 1);
}

const describe = (count: number): string => `${count} ${count === 1 ? 'charge' : 'charges'}`;

const byDateThenId = (a: FeeCharge, b: FeeCharge): number =>
  a.transaction.effectiveDate < b.transaction.effectiveDate
    ? -1
    : a.transaction.effectiveDate > b.transaction.effectiveDate
      ? 1
      : a.transaction.id < b.transaction.id
        ? -1
        : 1;

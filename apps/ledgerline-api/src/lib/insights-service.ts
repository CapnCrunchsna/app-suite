/**
 * §6.6's five views, and §7.2's coverage rule applied to all of them.
 *
 * "Category spend by month as stacked bars with a date-range selector, a
 * month-over-month movers table (biggest risers and fallers), the fees and interest
 * rollup per account, the outliers list, and the small-spend aggregate table with
 * annualized columns. Months that are not fully covered are rendered hatched rather
 * than omitted, so a gap reads as a gap and not as a drop in spending."
 *
 * ## Two sources, and the split is not arbitrary
 *
 * Three of these are **sums** — categories, movers, fees — and they are computed here
 * from transactions. Two of them are **judgements** — which charges are outliers
 * (§5.9), what counts as high-frequency small spend (§5.11) — and those are read from
 * the findings the owning rule produced.
 *
 * Re-deriving a judgement here would be a second implementation of a §5 rule, with
 * its own copy of the thresholds §7.4 says live in one config object, drifting from
 * the first the moment either moved. §5.9's z-score and §5.11's floor are that rule's
 * business, and Insights is a place to *see* their answers rather than a second
 * opinion about them.
 *
 * The cost is that the two judgement views are empty until an analysis has run, and
 * they say so rather than rendering a plausible zero.
 *
 * ## §7.2, which is the one thing §6.6 is emphatic about
 *
 * "Any analyzer that computes a per-month aggregate — §5.10, §5.11, the Insights page
 * — restricts itself to months covered for **every** account in scope, and reports
 * the window it used."
 *
 * So the *totals* come from covered months only. But §6.6 also requires the uncovered
 * ones to be **shown**, hatched, because a missing statement rendered as a missing bar
 * is indistinguishable from a month you spent nothing — and that is the single most
 * misleading thing this page could do. Every month in the span is therefore returned
 * with its coverage state, and the caller renders rather than filters.
 */

import { classifyFeeCharge } from '@metrum/ledgerline-analyzers';
import type { DateRange } from '@metrum/ledgerline-domain';

import { resolveAnalyzerConfig } from './analysis-service.js';

import type { LedgerlineContext } from './context.js';

/** §6.6's stacked bars: one month, its coverage, and what was spent per category. */
export interface CategoryMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /** §7.2's answer for *every* account in scope, not any one of them. */
  readonly covered: boolean;
  readonly totalCents: number;
  readonly slices: readonly { readonly category: string; readonly amountCents: number }[];
}

export interface CategoryInsight {
  readonly months: readonly CategoryMonth[];
  /** Every category appearing anywhere in the window, so a stacked chart can assign
   *  one colour per series rather than re-keying per month. */
  readonly categories: readonly string[];
  /** §7.2: "reports the window it used". */
  readonly window: CoverageWindow;
}

/**
 * What the numbers were computed over, said out loud.
 *
 * §7.2 requires it and §6.6's hatching depends on it: a reader looking at eleven
 * solid bars and one hatched one needs to know the totals exclude the hatched one,
 * or the chart is telling them something false about a month they can see.
 */
export interface CoverageWindow {
  readonly from: string;
  readonly to: string;
  readonly coveredMonths: number;
  readonly uncoveredMonths: readonly string[];
}

export interface Mover {
  readonly category: string;
  readonly fromCents: number;
  readonly toCents: number;
  readonly deltaCents: number;
  /** Null where the earlier month was zero: a rise from nothing has no percentage,
   *  and rendering it as ∞ or 100% would put a number on the page that means
   *  neither. */
  readonly percent: number | null;
}

export interface MoversInsight {
  readonly fromMonth: string | null;
  readonly toMonth: string | null;
  readonly risers: readonly Mover[];
  readonly fallers: readonly Mover[];
  readonly window: CoverageWindow;
}

export interface FeeAccount {
  readonly accountId: string;
  readonly displayName: string;
  readonly totalCents: number;
  readonly count: number;
  readonly byMerchant: readonly { readonly label: string; readonly amountCents: number; readonly count: number }[];
}

export interface FeesInsight {
  readonly accounts: readonly FeeAccount[];
  readonly totalCents: number;
  readonly window: CoverageWindow;
}

/** §5.9's and §5.11's answers, as §6.6 lists them. */
export interface RuleBackedRow {
  readonly findingId: string;
  readonly title: string;
  readonly subjectId: string;
  readonly band: string;
  readonly impactAnnualCents: number;
  readonly impactMonthlyCents: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface RuleBackedInsight {
  readonly rows: readonly RuleBackedRow[];
  /** Set when no analysis has ever completed, so the page can say "run one" rather
   *  than "there are none" — two very different statements about an empty list. */
  readonly unavailableReason: string | null;
}

const MOVERS_PER_SIDE = 5;

// --------------------------------------------------------------- coverage ---

const monthOf = (iso: string): string => iso.slice(0, 7);

function addMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12
    ? `${year + 1}-01`
    : `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** Every month from `from` to `to` inclusive, so a gap is a cell rather than an
 *  absence — §6.6's whole point about hatching. */
function monthsIn(range: DateRange): string[] {
  const months: string[] = [];
  let month = monthOf(range.from);
  const last = monthOf(range.to);
  // Guarded rather than `while (true)`: a reversed range would otherwise spin, and
  // the route validates but this function is also called internally.
  for (let i = 0; i < 1200 && month <= last; i += 1) {
    months.push(month);
    month = addMonth(month);
  }
  return months;
}

/**
 * §7.2's intersection: months covered for **every** account in scope.
 *
 * The intersection rather than the union, and §7.2 is explicit about it. A month
 * where one account has a statement and another does not is a month whose *total*
 * is missing a card's worth of spending — showing it beside eleven complete months
 * is the drop-that-is-not-a-drop §6.6 exists to prevent.
 */
function coveredMonthSet(context: LedgerlineContext, accountIds: readonly string[]): Set<string> {
  const accounts = accountIds.length > 0 ? accountIds : context.store.accounts.list().map((a) => a.id);
  if (accounts.length === 0) return new Set();

  let shared: Set<string> | null = null;

  for (const accountId of accounts) {
    const covered = new Set(
      context.store.accounts
        .coverage(accountId)
        .months.filter((month) => month.covered)
        .map((month) => month.month),
    );
    if (shared === null) {
      shared = covered;
      continue;
    }
    const intersection = new Set<string>();
    for (const month of shared) if (covered.has(month)) intersection.add(month);
    shared = intersection;
  }

  return shared ?? new Set();
}

function windowOf(range: DateRange, months: readonly string[], covered: ReadonlySet<string>): CoverageWindow {
  return {
    from: range.from,
    to: range.to,
    coveredMonths: months.filter((month) => covered.has(month)).length,
    uncoveredMonths: months.filter((month) => !covered.has(month)),
  };
}

// ------------------------------------------------------------- categories ---

export function categorySpend(
  context: LedgerlineContext,
  range: DateRange,
  accountIds: readonly string[] = [],
): CategoryInsight {
  const covered = coveredMonthSet(context, accountIds);
  const months = monthsIn(range);

  const byMonth = new Map<string, Map<string, number>>();
  const categories = new Set<string>();

  for (const row of context.store.transactions.monthlyCategoryTotals(range)) {
    const label = row.categoryName ?? 'Uncategorized';
    categories.add(label);
    const slice = byMonth.get(row.month) ?? new Map<string, number>();
    slice.set(label, (slice.get(label) ?? 0) + row.totalCents);
    byMonth.set(row.month, slice);
  }

  return {
    // Every month in the span, covered or not. §6.6: "rendered hatched rather than
    // omitted, so a gap reads as a gap and not as a drop in spending."
    months: months.map((month) => {
      const slice = byMonth.get(month) ?? new Map<string, number>();
      return {
        month,
        covered: covered.has(month),
        totalCents: [...slice.values()].reduce((total, cents) => total + cents, 0),
        slices: [...slice.entries()]
          .map(([category, amountCents]) => ({ category, amountCents }))
          .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)),
      };
    }),
    categories: [...categories].sort(),
    window: windowOf(range, months, covered),
  };
}

// ----------------------------------------------------------------- movers ---

/**
 * §6.6's "biggest risers and fallers", between the last two **covered** months.
 *
 * Covered, not merely the last two: comparing a complete month against a half-imported
 * one produces a table of enormous fallers that are all the same artefact, which is
 * §7.2's whole reason for existing. With fewer than two covered months there is
 * nothing to compare and the answer is an empty table rather than a comparison
 * against a month that is not there.
 */
export function movers(
  context: LedgerlineContext,
  range: DateRange,
  accountIds: readonly string[] = [],
): MoversInsight {
  const covered = coveredMonthSet(context, accountIds);
  const months = monthsIn(range);
  const usable = months.filter((month) => covered.has(month));

  const empty = {
    fromMonth: null,
    toMonth: null,
    risers: [],
    fallers: [],
    window: windowOf(range, months, covered),
  } satisfies MoversInsight;

  if (usable.length < 2) return empty;

  const fromMonth = usable[usable.length - 2];
  const toMonth = usable[usable.length - 1];

  const totals = new Map<string, { from: number; to: number }>();
  for (const row of context.store.transactions.monthlyCategoryTotals(range)) {
    if (row.month !== fromMonth && row.month !== toMonth) continue;
    const label = row.categoryName ?? 'Uncategorized';
    const entry = totals.get(label) ?? { from: 0, to: 0 };
    if (row.month === fromMonth) entry.from += row.totalCents;
    else entry.to += row.totalCents;
    totals.set(label, entry);
  }

  const all: Mover[] = [...totals.entries()].map(([category, entry]) => ({
    category,
    fromCents: entry.from,
    toCents: entry.to,
    // Magnitudes, because §7.3's amounts are signed: "spending rose" is a bigger
    // magnitude, and a raw delta would sort a rise and a fall into one another.
    deltaCents: Math.abs(entry.to) - Math.abs(entry.from),
    percent:
      entry.from === 0
        ? null
        : ((Math.abs(entry.to) - Math.abs(entry.from)) / Math.abs(entry.from)) * 100,
  }));

  return {
    fromMonth,
    toMonth,
    risers: all
      .filter((mover) => mover.deltaCents > 0)
      .sort((a, b) => b.deltaCents - a.deltaCents)
      .slice(0, MOVERS_PER_SIDE),
    fallers: all
      .filter((mover) => mover.deltaCents < 0)
      .sort((a, b) => a.deltaCents - b.deltaCents)
      .slice(0, MOVERS_PER_SIDE),
    window: windowOf(range, months, covered),
  };
}

// ------------------------------------------------------------------- fees ---

/**
 * §6.6's "fees and interest rollup per account".
 *
 * ## The same predicate as §5.8, without §5.8's judgement
 *
 * The first version of this filtered on `category.kind = 'fee'` and was empty on any
 * fresh ledger, which the spec for it caught. §2.5 assigns a category from the
 * *merchant's* default, and a maintenance fee normalizes to a provisional merchant
 * that has no default — so the rows that most obviously are fees are exactly the ones
 * carrying no category.
 *
 * §5.8 already solved this, and says so in its own words: "a fee whose category was
 * never assigned is still a fee — and the converse, a fee-kind category with no
 * recognisable keyword, is still a fee." So `classifyFeeCharge` is exported from that
 * rule and called here. What stays behind in §5.8 is the *judgement*: which fees clear
 * §5.1's floor and are worth a card. A rollup is a sum and applies neither.
 *
 * That keeps one definition of "is a fee" in the codebase, which matters more than it
 * looks: the keyword list is §7.4 configuration a user can tune, so a second copy here
 * would drift the first afternoon anybody used the Settings page.
 */
export function fees(
  context: LedgerlineContext,
  range: DateRange,
  accountIds: readonly string[] = [],
): FeesInsight {
  const covered = coveredMonthSet(context, accountIds);
  const months = monthsIn(range);

  const config = resolveAnalyzerConfig(context);
  const feeCategoryIds = new Set(
    context.store.merchants
      .listCategories()
      .filter((category) => category.kind === 'fee')
      .map((category) => category.id),
  );

  const accounts = context.store.accounts
    .list()
    .filter((account) => accountIds.length === 0 || accountIds.includes(account.id));

  const rollup: FeeAccount[] = [];
  let totalCents = 0;

  for (const account of accounts) {
    const page = context.store.transactions.search({
      accountIds: [account.id],
      dateRange: range,
      limit: 500,
    });

    const byMerchant = new Map<string, { amountCents: number; count: number }>();
    let accountTotal = 0;
    let count = 0;

    for (const row of page.rows) {
      const charge = classifyFeeCharge(
        {
          id: row.transaction.id,
          accountId: row.transaction.accountId,
          effectiveDate: row.transaction.effectiveDate,
          amountCents: row.transaction.amountCents,
          descriptionNormalized: row.transaction.descriptionNormalized,
          descriptionRaw: row.transaction.descriptionRaw,
          merchantId: row.transaction.merchantId,
          categoryId: row.transaction.categoryId,
          isPending: row.transaction.isPending,
          isInternalTransfer: row.transaction.isInternalTransfer,
          isExcluded: row.transaction.isExcluded,
          refundPairId: row.transaction.refundPairId,
          transferPairId: row.transaction.transferPairId,
        },
        feeCategoryIds,
        config.fees,
      );
      if (!charge) continue;

      const label = row.transaction.descriptionNormalized;
      const entry = byMerchant.get(label) ?? { amountCents: 0, count: 0 };
      // §5.8 returns the magnitude (`-row.amountCents`); the rollup keeps the
      // ledger's sign so it reads the same way as every other total on the page.
      entry.amountCents += row.transaction.amountCents;
      entry.count += 1;
      byMerchant.set(label, entry);
      accountTotal += row.transaction.amountCents;
      count += 1;
    }

    if (count === 0) continue;

    totalCents += accountTotal;
    rollup.push({
      accountId: account.id,
      displayName: account.displayName,
      totalCents: accountTotal,
      count,
      byMerchant: [...byMerchant.entries()]
        .map(([label, entry]) => ({ label, ...entry }))
        .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)),
    });
  }

  return {
    accounts: rollup.sort((a, b) => Math.abs(b.totalCents) - Math.abs(a.totalCents)),
    totalCents,
    window: windowOf(range, months, covered),
  };
}

// -------------------------------------------------- the two rule-backed views ---

/**
 * §5.9's outliers and §5.11's small spend, read from the rule that owns each.
 *
 * `visibility: 'all'` deliberately: §6.6 is a page about *what your money did*, not a
 * queue of things to act on, and a dismissed outlier is still an outlier. §6.4 is
 * where a dismissal means "stop showing me this"; hiding the same row here would make
 * the Insights totals disagree with the ledger for a reason nobody could see.
 */
function ruleBacked(context: LedgerlineContext, ruleId: string, what: string): RuleBackedInsight {
  const lastRun = context.store.analysis.latestFinished();
  if (!lastRun) {
    return {
      rows: [],
      unavailableReason:
        `No analysis has finished yet, so there is nothing to list. ${what} are worked out ` +
        'by a rule rather than summed from the ledger — run an analysis from Findings.',
    };
  }

  const page = context.store.findings.search({
    ruleIds: [ruleId],
    statuses: ['active'],
    visibility: 'all',
    limit: 200,
  });

  return {
    rows: page.rows.map((row) => ({
      findingId: row.finding.id,
      title: row.finding.title,
      subjectId: row.finding.subjectId,
      band: row.finding.band,
      impactAnnualCents: row.finding.impactAnnualCents,
      impactMonthlyCents: row.finding.impactMonthlyCents,
      detail: JSON.parse(row.finding.detailJson) as Record<string, unknown>,
    })),
    unavailableReason: null,
  };
}

export const outliers = (context: LedgerlineContext): RuleBackedInsight =>
  ruleBacked(context, 'outlier.v1', 'Outliers');

export const smallSpend = (context: LedgerlineContext): RuleBackedInsight =>
  ruleBacked(context, 'micro.v1', 'Small-spend groups');

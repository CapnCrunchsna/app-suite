/**
 * `trend.v1` — §5.10.
 *
 * "Monthly sums and counts per category, computed **only over fully-covered
 * months** (§7.2)."
 *
 * ## The coverage rule is the first line for a reason
 *
 * §5.10: "A month in which one of three accounts was imported has artificially
 * low spend, which makes the next complete month look like a spike; the coverage
 * rule is what stops the trend analyzer from reporting import gaps as spending
 * behaviour." This rule would otherwise turn the normal condition of the app —
 * statements arriving late, one account at a time — into a finding about the
 * user's habits. `fullyCoveredMonths` is the intersection across every account in
 * scope, not the union, for exactly that reason.
 *
 * ## Both conditions on a spike, both on a climb
 *
 * §5.10 is explicit that each trigger needs a percentage **and** a dollar
 * amount: "a percentage alone flags a $12 category and a dollar amount alone
 * flags every large category every month". The climb adds a third test that is
 * pure noise control — the three-month rise has to exceed twice the MAD of that
 * category's own historical monthly deltas, because otherwise "a category
 * performing an ordinary random walk produces three consecutive increases about
 * one window in eight; across thirty categories and a year of windows that is
 * roughly twenty-five spurious climbs per run."
 *
 * ## A spike is an event; a climb is a level
 *
 * They are annualized differently and it is not a detail. A spike happened once,
 * so its impact is the excess and its **monthly** figure is zero — annualizing it
 * would claim December repeats every month. A climb is a category that now costs
 * more per month than it did, so the rise *is* a monthly rate and ×12 is a real
 * forward-looking number. Both are `visibility` (§5.10), so neither reaches
 * §7.3's headline either way.
 */

import type { AnalyzerConfig, TrendConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import type { RecurringSeries } from './recurrence.js';
import { medianAbsoluteDeviation } from './statistics.js';
import { fullyCoveredMonths, monthOf } from './snapshot.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

export const TREND_RULE_ID = 'trend.v1';

interface MonthTotal {
  readonly month: string;
  readonly cents: number;
  readonly count: number;
  readonly transactionIds: readonly string[];
}

export function analyzeTrends(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): RuleEmission {
  const settings = config.trend;

  // §7.2, and §5.10's opening sentence. An empty set means nothing has been
  // proven complete, and this rule computes nothing rather than computing over
  // months it cannot vouch for.
  const covered = fullyCoveredMonths(snapshot.accounts);
  if (covered.size === 0) return applyEmissionPolicy(TREND_RULE_ID, [], config);

  const categories = new Map(snapshot.categories.map((category) => [category.id, category]));
  const dominated = seriesDominatedCategories(snapshot, series, settings);

  const byCategory = new Map<string, Map<string, { cents: number; ids: string[] }>>();

  for (const row of snapshot.transactions) {
    if (!eligible(row) || row.categoryId === null) continue;
    if (!covered.has(monthOf(row.effectiveDate))) continue;
    if (categories.get(row.categoryId)?.kind !== 'spend') continue;
    if (dominated.has(row.categoryId)) continue;

    const months = byCategory.get(row.categoryId) ?? new Map();
    byCategory.set(row.categoryId, months);

    const month = monthOf(row.effectiveDate);
    const bucket = months.get(month) ?? { cents: 0, ids: [] };
    bucket.cents += -row.amountCents;
    bucket.ids.push(row.id);
    months.set(month, bucket);
  }

  const spikes: DraftFinding[] = [];
  const climbs: DraftFinding[] = [];
  const orderedMonths = [...covered].sort();

  for (const [categoryId, months] of [...byCategory.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    // Every covered month, including the ones this category spent nothing in —
    // a zero is a real observation and dropping it would make a category that
    // skipped two months look like it rose in the third.
    const totals: MonthTotal[] = orderedMonths.map((month) => ({
      month,
      cents: months.get(month)?.cents ?? 0,
      count: months.get(month)?.ids.length ?? 0,
      transactionIds: months.get(month)?.ids ?? [],
    }));

    const name = categories.get(categoryId)?.name ?? 'Uncategorized';
    spikes.push(...findSpikes(categoryId, name, totals, settings));
    climbs.push(...findClimbs(categoryId, name, totals, settings));
  }

  // §5.10's own caps, applied per kind before §5.1's shared budget sees the set:
  // "Emission is capped at the top five spikes and top five climbs per run."
  const drafts = [
    ...topBy(spikes, settings.maxSpikes),
    ...topBy(climbs, settings.maxClimbs),
  ];

  return applyEmissionPolicy(TREND_RULE_ID, drafts, config);
}

const eligible = (row: SnapshotTransaction): boolean =>
  row.amountCents < 0 &&
  !row.isPending &&
  !row.isExcluded &&
  !row.isInternalTransfer &&
  row.refundPairId === null;

const topBy = (drafts: readonly DraftFinding[], limit: number): DraftFinding[] =>
  [...drafts]
    .sort((a, b) => Math.abs(b.impactAnnualCents) - Math.abs(a.impactAnnualCents))
    .slice(0, limit);

// ---------------------------------------------------------------- spikes ---

/**
 * §5.10's spike: "a month exceeds its trailing three-month average by **both**
 * >40% *and* >$75 **of excess** (not of total), with all three trailing months
 * present and non-zero."
 *
 * "All three present and non-zero" is what stops a category's first real month
 * from reading as a spike against two months of nothing.
 */
function findSpikes(
  categoryId: string,
  name: string,
  totals: readonly MonthTotal[],
  config: TrendConfig,
): DraftFinding[] {
  const drafts: DraftFinding[] = [];
  const spikedMonthsOfYear = new Set<string>();

  for (let index = config.trailingMonths; index < totals.length; index += 1) {
    const trailing = totals.slice(index - config.trailingMonths, index);
    if (trailing.some((month) => month.cents <= 0)) continue;

    const average = trailing.reduce((sum, month) => sum + month.cents, 0) / trailing.length;
    const current = totals[index];
    const excess = current.cents - average;

    if (excess <= config.spikeExcessCents) continue;
    if (excess <= average * config.spikePercent) continue;

    // §5.10's seasonality suppression: "a spike in a month-of-year that already
    // spiked in a prior year for the same category is suppressed to a note rather
    // than a finding. December, insurance renewal months and tuition months
    // otherwise fire every single year."
    const monthOfYear = current.month.slice(5, 7);
    if (spikedMonthsOfYear.has(monthOfYear)) continue;
    spikedMonthsOfYear.add(monthOfYear);

    drafts.push({
      ruleId: TREND_RULE_ID,
      ruleVersion: TREND_RULE_ID,
      subjectType: 'category',
      // The month is in the key because a category can spike in more than one,
      // and §5.1 upserts on the natural key — a bare category id would let
      // March overwrite January. The month never moves, so the key is stable.
      subjectId: `${categoryId}:spike:${current.month}`,
      title: `${name} spiked in ${current.month}`,
      detail: {
        kind: 'spike',
        categoryId,
        categoryName: name,
        month: current.month,
        monthCents: current.cents,
        transactionCount: current.count,
        trailingMonths: trailing.map((month) => ({ month: month.month, cents: month.cents })),
        trailingAverageCents: Math.round(average),
        excessCents: Math.round(excess),
        excessPercent: average === 0 ? null : Number(((excess / average) * 100).toFixed(1)),
      },
      evidenceTransactionIds: current.transactionIds,
      confidence: config.spikeConfidence,
      impactKind: 'visibility',
      // A spike happened once. See the header: a monthly rate here would claim
      // it repeats.
      impactMonthlyCents: 0,
      impactAnnualCents: Math.round(excess),
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: TREND_RULE_ID,
        subjectId: `${categoryId}:spike:${current.month}`,
        amountCents: Math.round(excess),
        cadenceLabel: null,
        seriesStatus: null,
      }),
    });
  }

  return drafts;
}

// ---------------------------------------------------------------- climbs ---

/**
 * §5.10's climb: "three consecutive monthly increases totalling >25% **and**
 * >$50/month, where the three-month rise also exceeds twice the MAD of that
 * category's own historical monthly deltas."
 *
 * The MAD is taken over the category's whole delta history rather than the window
 * being tested, which is the point of the test: it asks whether *this* rise is
 * large for *this* category, and a category that swings by $200 a month routinely
 * has not done anything when it swings by $200 three times in a row.
 *
 * ## Maximal runs, not sliding windows
 *
 * A category that rises for eight months straight satisfies "three consecutive
 * increases" in six overlapping windows, and reporting each would be six cards
 * saying one thing — the volume §5.1 names as what gets a tool like this
 * abandoned. So the unit is the **run**: each maximal stretch of consecutive
 * increases is found once and measured end to end, which also makes the reported
 * rise the whole rise rather than an arbitrary three months of it. Two separate
 * climbs in a year remain two runs and two findings. Recorded in §9g.
 */
function findClimbs(
  categoryId: string,
  name: string,
  totals: readonly MonthTotal[],
  config: TrendConfig,
): DraftFinding[] {
  if (totals.length < config.climbMonths + 1) return [];

  const deltas = totals.slice(1).map((month, index) => month.cents - totals[index].cents);
  const volatility = medianAbsoluteDeviation(deltas);
  const drafts: DraftFinding[] = [];

  for (const steps of maximalRuns(totals, config.climbMonths)) {
    const from = steps[0].cents;
    const to = steps[steps.length - 1].cents;
    const rise = to - from;

    if (from <= 0) continue;
    if (rise <= config.climbRiseCents) continue;
    if (rise <= from * config.climbPercent) continue;
    // The volatility test. `NaN` when there is no delta history to speak of, in
    // which case there is nothing to claim this rise is unusual against.
    if (!Number.isFinite(volatility) || rise <= volatility * config.climbMadMultiple) continue;

    drafts.push({
      ruleId: TREND_RULE_ID,
      ruleVersion: TREND_RULE_ID,
      subjectType: 'category',
      subjectId: `${categoryId}:climb:${steps[steps.length - 1].month}`,
      // The run's own length, not the threshold that admitted it — a card
      // reading "3 months running" over an eight-month climb understates the
      // one thing the finding is about.
      title: `${name} has risen ${steps.length - 1} months running`,
      detail: {
        kind: 'climb',
        categoryId,
        categoryName: name,
        fromMonth: steps[0].month,
        toMonth: steps[steps.length - 1].month,
        months: steps.map((month) => ({ month: month.month, cents: month.cents })),
        fromCents: from,
        toCents: to,
        riseCents: rise,
        risePercent: Number(((rise / from) * 100).toFixed(1)),
        volatilityMadCents: Math.round(volatility),
      },
      evidenceTransactionIds: steps.flatMap((month) => month.transactionIds),
      confidence: config.climbConfidence,
      impactKind: 'visibility',
      // A climb is a level, not an event: the category now costs this much more
      // every month, so ×12 is a real forward figure rather than an annualized
      // one-off.
      impactMonthlyCents: rise,
      impactAnnualCents: rise * 12,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: TREND_RULE_ID,
        subjectId: `${categoryId}:climb:${steps[steps.length - 1].month}`,
        amountCents: rise,
        cadenceLabel: null,
        seriesStatus: null,
      }),
    });
  }

  return drafts;
}

/**
 * Every maximal stretch of strictly increasing months, at least `minRises` long.
 *
 * "Consecutive increases" means no flat month and no dip: a run ends the moment
 * a month fails to beat the one before it. Returned as the whole run, so a
 * six-month climb is measured over six months rather than over the last three.
 */
function maximalRuns(totals: readonly MonthTotal[], minRises: number): MonthTotal[][] {
  const runs: MonthTotal[][] = [];
  let start = 0;

  for (let index = 1; index <= totals.length; index += 1) {
    const broken = index === totals.length || totals[index].cents <= totals[index - 1].cents;
    if (!broken) continue;

    if (index - start > minRises) runs.push(totals.slice(start, index));
    start = index;
  }

  return runs;
}

// ------------------------------------------------------------- dominance ---

/**
 * §5.10: "Both triggers exclude categories whose spend is dominated (>80%) by a
 * single recurring series, which §5.2 and §5.5 already cover better."
 *
 * A category that is one subscription is not a spending trend — a price rise in
 * it is §5.5's price creep, told properly, with the step history. Reporting it
 * here as well would be the same dollars twice under two names.
 */
function seriesDominatedCategories(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: TrendConfig,
): Set<string> {
  const categoryTotals = new Map<string, number>();
  const byId = new Map(snapshot.transactions.map((row) => [row.id, row]));

  for (const row of snapshot.transactions) {
    if (!eligible(row) || row.categoryId === null) continue;
    categoryTotals.set(row.categoryId, (categoryTotals.get(row.categoryId) ?? 0) + -row.amountCents);
  }

  // A series has no category of its own; its charges do. Summed per
  // (series, category), because one series can in principle straddle two.
  const seriesTotals = new Map<string, number>();
  for (const entry of series) {
    for (const charge of entry.charges) {
      const row = byId.get(charge.transactionId);
      if (!row || row.categoryId === null) continue;
      const key = `${entry.id}|${row.categoryId}`;
      seriesTotals.set(key, (seriesTotals.get(key) ?? 0) + Math.abs(charge.amountCents));
    }
  }

  const dominated = new Set<string>();
  for (const [key, cents] of seriesTotals) {
    const categoryId = key.slice(key.indexOf('|') + 1);
    const total = categoryTotals.get(categoryId) ?? 0;
    if (total > 0 && cents / total > config.seriesDominanceFraction) dominated.add(categoryId);
  }

  return dominated;
}

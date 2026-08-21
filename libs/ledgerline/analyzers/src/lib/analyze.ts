/**
 * One run: one snapshot, every rule, one set of findings.
 *
 * ## Why the run is a function rather than a loop the caller writes
 *
 * §2.2 makes it a condition of the whole design that there is **one snapshot per
 * run, not one per analyzer** — "nine independent loads would be nine times the
 * query cost and nine times the peak memory". A caller assembling the rules
 * itself is a caller that can load twice, so the composition lives here and the
 * app calls one function.
 *
 * It also puts the one ordering constraint in a single place. `trial.v1` is
 * suppressed for any series where `price_creep.v1` already reported a step at the
 * same first-to-second transition (§5.6), so price creep runs first and hands the
 * set forward. Everything else is independent.
 *
 * ## The row guard is §2.2's, verbatim
 *
 * "`analysis_run` records the snapshot row count. Above 250,000 rows the run logs
 * a warning; above 1,000,000 it refuses and points at date-range scoping. The
 * design is allowed to have a ceiling — it is not allowed to have an undiscovered
 * one." The refusal is an exception rather than a returned value because there is
 * no partial answer to give: every rule reads the whole snapshot, so a run that
 * cannot hold it has nothing to report.
 */

import type { AnalyzerConfig } from './config.js';
import { configHash } from './config.js';
import type { Finding, FindingRollup, RuleEmission } from './finding.js';
import { DUPLICATE_RULE_ID, analyzeDuplicates } from './duplicate.js';
import { FEES_RULE_ID, analyzeFees } from './fees.js';
import { LAPSED_RULE_ID, analyzeLapsed } from './lapsed.js';
import { MICRO_RULE_ID, analyzeMicroSpend } from './micro.js';
import { OUTLIER_RULE_ID, analyzeOutliers } from './outlier.js';
import { PRICE_CREEP_RULE_ID, analyzePriceCreep } from './price-creep.js';
import { RECURRENCE_RULE_ID, analyzeRecurrence } from './recurrence.js';
import type { RecurringSeries } from './recurrence.js';
import { TREND_RULE_ID, analyzeTrends } from './trend.js';
import { TRIAL_RULE_ID, analyzeTrials } from './trial.js';
import type { Snapshot } from './snapshot.js';

/** Thrown rather than returned: see the note above. */
export class SnapshotTooLargeError extends Error {
  constructor(
    readonly rows: number,
    readonly limit: number,
  ) {
    super(
      `snapshot holds ${rows} transactions, over the ${limit} row ceiling. ` +
        'Scope the run to a date range and re-run.',
    );
    this.name = 'SnapshotTooLargeError';
  }
}

export interface AnalysisResult {
  /** §5.3's series, for the Subscriptions page and for persistence into
   *  `recurring_series` (§3.1) — not only an intermediate value. */
  readonly series: readonly RecurringSeries[];
  readonly findings: readonly Finding[];
  readonly rollups: readonly FindingRollup[];
  /** For `analysis_run` (§3.1). */
  readonly configHash: string;
  readonly ruleVersions: Readonly<Record<string, string>>;
  readonly snapshotRows: number;
  /** §2.2's soft ceiling. A value here means the run completed and should be
   *  reported as slow rather than silently accepted. */
  readonly warning: string | null;
}

export function analyze(snapshot: Snapshot, config: AnalyzerConfig): AnalysisResult {
  const snapshotRows = snapshot.transactions.length;
  if (snapshotRows > config.global.snapshotMaxRows) {
    throw new SnapshotTooLargeError(snapshotRows, config.global.snapshotMaxRows);
  }

  const recurrence = analyzeRecurrence(snapshot, config);
  const series = recurrence.series;

  const priceCreep = analyzePriceCreep(snapshot, series, config);
  const duplicates = analyzeDuplicates(snapshot, series, config);
  const trials = analyzeTrials({
    snapshot,
    series,
    reportedFirstTransitionSeriesIds: priceCreep.reportedFirstTransitionSeriesIds,
    config,
  });
  const lapsed = analyzeLapsed(snapshot, series, config);

  // §5.8–§5.11 read transactions rather than series, so they are independent of
  // the ordering constraint above. `outlier.v1` and `trend.v1` take the series
  // anyway — not to build on them, but to *exclude* them: §5.9 leaves recurring
  // charges out of its "largest in the window" list because the expected large
  // payments are exactly what would fill it, and §5.10 skips categories one
  // subscription dominates because §5.2 and §5.5 cover those better.
  const fees = analyzeFees(snapshot, config);
  const outliers = analyzeOutliers(snapshot, series, config);
  const trends = analyzeTrends(snapshot, series, config);
  const micro = analyzeMicroSpend(snapshot, config);

  const emissions: readonly RuleEmission[] = [
    recurrence.emission,
    priceCreep.emission,
    duplicates,
    trials,
    lapsed,
    fees,
    outliers,
    trends,
    micro,
  ];

  return {
    series,
    findings: emissions.flatMap((emission) => emission.findings),
    rollups: emissions
      .map((emission) => emission.rollup)
      .filter((rollup): rollup is FindingRollup => rollup !== null),
    configHash: configHash(config),
    ruleVersions: {
      [RECURRENCE_RULE_ID]: RECURRENCE_RULE_ID,
      [PRICE_CREEP_RULE_ID]: PRICE_CREEP_RULE_ID,
      [DUPLICATE_RULE_ID]: DUPLICATE_RULE_ID,
      [TRIAL_RULE_ID]: TRIAL_RULE_ID,
      [LAPSED_RULE_ID]: LAPSED_RULE_ID,
      [FEES_RULE_ID]: FEES_RULE_ID,
      [OUTLIER_RULE_ID]: OUTLIER_RULE_ID,
      [TREND_RULE_ID]: TREND_RULE_ID,
      [MICRO_RULE_ID]: MICRO_RULE_ID,
    },
    snapshotRows,
    warning:
      snapshotRows > config.global.snapshotWarnRows
        ? `snapshot holds ${snapshotRows} transactions, over the ${config.global.snapshotWarnRows} row advisory limit`
        : null,
  };
}

/**
 * §5.1 and §7.3's headline: only `savings` sums.
 *
 * Here rather than in the API so there is exactly one implementation of the rule
 * that keeps the number honest. A caller that wanted the total of everything
 * would be adding a subscription total, a category-overlap total and a
 * price-creep delta that all describe the same transactions.
 */
export function totalSavingsAnnualCents(findings: readonly Finding[]): number {
  return findings
    .filter((finding) => finding.impactKind === 'savings')
    .reduce((total, finding) => total + finding.impactAnnualCents, 0);
}

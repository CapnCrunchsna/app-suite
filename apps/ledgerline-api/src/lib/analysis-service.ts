/**
 * One analysis run, wired: load the snapshot, call §5's rules, persist what they
 * produced.
 *
 * This is the composition root doing the one thing §2.1 reserves for it — "libs
 * compute; the app persists". `analyzers` is a pure function of
 * `(snapshot, config)` and cannot reach a database; `data` holds the tables and
 * cannot reach a rule. The two shapes meet here and nowhere else, which is what
 * `@nx/enforce-module-boundaries` is checking when it forbids
 * `type:analyzers → type:data-access`.
 *
 * ## The three things this file decides that neither lib can
 *
 * **Which config the run used.** §7.4: "Every threshold in §5 is a default in a
 * config object; Settings overrides it; `analysis_run` records `config_hash`."
 * The override lives in `settings`, the defaults live in `analyzers`, and
 * `resolveConfig` merges them here.
 *
 * **Which findings a standing `dismissal_rule` suppresses.** §5.1's second and
 * third dismissal scopes are "this merchant + this rule" and "this rule", applied
 * at emit time. Matching the first needs to know which merchant a finding is
 * *about* — and a `series` finding's subject is a series id, which only the run
 * that just produced the series can resolve. `data` is handed the verdict, not
 * the question.
 *
 * **What "evidence" means on the wire.** A rule emits transaction ids; §3.1's
 * `finding_evidence` wants an account too. That lookup is `data`'s, which is why
 * `FindingInput` carries bare ids.
 */

import { analyze, configHash, resolveConfig } from '@metrum/ledgerline-analyzers';
import type { AnalyzerConfig, ConfigOverride, Finding } from '@metrum/ledgerline-analyzers';
import type {
  AnalysisRunRecord,
  DismissalRuleRecord,
  FindingInput,
  SeriesInput,
} from '@metrum/ledgerline-data';

import type { LedgerlineContext } from './context.js';
import { runTransferLinking } from './transfer-service.js';
import type { TransferLinkSummary } from './transfer-service.js';

/** Where Settings writes §7.4's override. One key, because the override is one
 *  object: a per-threshold key would let two of them disagree about which
 *  `config_hash` the last run recorded. */
export const ANALYZER_CONFIG_SETTING = 'analyzer.config';

export interface AnalysisRunSummary {
  readonly runId: string;
  readonly configHash: string;
  readonly snapshotRows: number;
  readonly findingsEmitted: number;
  readonly findingsSuppressed: number;
  readonly findingsResolved: number;
  readonly seriesCount: number;
  /** §2.6's link pass, which runs first — see `runAnalysis`. */
  readonly transfers: TransferLinkSummary;
  /** §2.2's soft ceiling, or a rule-level note. Null on an unremarkable run. */
  readonly warning: string | null;
}

export function resolveAnalyzerConfig(context: LedgerlineContext): AnalyzerConfig {
  const override = context.store.settings.get<ConfigOverride>(ANALYZER_CONFIG_SETTING);
  return resolveConfig(override ?? {});
}

/** The hash of the config a run *would* use, without running one. What
 *  `GET /api/findings/summary` quotes so the page can say which thresholds the
 *  findings on screen were computed under. */
export function currentConfigHash(context: LedgerlineContext): string {
  return configHash(resolveAnalyzerConfig(context));
}

/**
 * Run §2.6's link pass and then every rule, and write both results.
 *
 * `report` is §2.7's progress channel; the phases are coarse on purpose. The two
 * that take real time are the snapshot load and the rules themselves, and
 * inventing a percentage inside `analyze()` would mean either threading a
 * callback through five pure functions or guessing.
 *
 * **Linking runs first, and the snapshot is loaded after it.** §2.5's pipeline
 * puts `link` before `analyze` and this is why the order is load-bearing rather
 * than tidy: an auto-link sets `is_internal_transfer`, every rule in §5 filters on
 * that column, and §6.4's headline is a sum over what they emit. Running the rules
 * first would price a $500 credit-card payment as spending, publish the number,
 * and correct it only on the next run.
 */
export function runAnalysis(
  context: LedgerlineContext,
  report: (progress: number, message: string) => void = () => undefined,
): AnalysisRunSummary {
  const config = resolveAnalyzerConfig(context);

  report(5, 'linking internal transfers');
  const transfers = runTransferLinking(context);

  report(15, 'loading the snapshot');
  const snapshot = context.store.buildSnapshot();

  report(25, `analyzing ${snapshot.transactions.length} transactions`);
  // §2.2's hard ceiling throws rather than returning: every rule reads the whole
  // snapshot, so a run that cannot hold it has no partial answer to give. The
  // job runner turns it into a failed job carrying this message, which names the
  // fix (scope the run to a date range).
  const result = analyze(snapshot, config);

  report(70, 'persisting findings');

  // Opened before the findings are written, because `finding.last_run_id` is a
  // real foreign key under RESTRICT (§3.2) and completed after, because
  // `snapshot_rows` and `config_hash` are not known until `analyze` returns.
  const run = context.store.analysis.start();

  const dismissalRules = context.store.findings.listDismissalRules();
  const merchantBySeriesId = new Map(result.series.map((entry) => [entry.id, entry.merchantId]));

  const findings = result.findings.map((finding) =>
    toFindingInput(finding, result.configHash, dismissalRules, merchantBySeriesId),
  );

  const applied = context.store.findings.applyRun({ runId: run.id, findings });
  const series = context.store.analysis.replaceSeries(result.series.map(toSeriesInput));

  const finished = finishRun(context, run, result, applied, series, transfers);

  report(100, summaryMessage(applied.inserted + applied.updated, applied.resolved, transfers));

  return {
    runId: finished.id,
    configHash: result.configHash,
    snapshotRows: result.snapshotRows,
    findingsEmitted: findings.filter((finding) => finding.status === 'active').length,
    findingsSuppressed: applied.suppressed,
    findingsResolved: applied.resolved,
    seriesCount: result.series.length,
    transfers,
    warning: result.warning,
  };
}

/**
 * What the job's `message` says when it lands.
 *
 * The proposals get a clause of their own because they are the one outcome that
 * needs a human: §2.6 leaves a proposed pair counted as spend until confirmed, so
 * a run that produced four of them has told the user their totals are knowably too
 * high and where to go about it.
 */
function summaryMessage(
  upserted: number,
  resolved: number,
  transfers: TransferLinkSummary,
): string {
  const parts = [`${upserted} finding${upserted === 1 ? '' : 's'}`];
  if (resolved > 0) parts.push(`${resolved} resolved`);
  if (transfers.autoLinked > 0) parts.push(`${transfers.autoLinked} transfers linked`);
  if (transfers.proposed > 0) {
    parts.push(
      `${transfers.proposed} possible transfer${transfers.proposed === 1 ? '' : 's'} to review`,
    );
  }
  return parts.join(', ');
}

function finishRun(
  context: LedgerlineContext,
  run: AnalysisRunRecord,
  result: ReturnType<typeof analyze>,
  applied: { inserted: number; updated: number; resolved: number; suppressed: number },
  series: { inserted: number; updated: number; removed: number },
  transfers: TransferLinkSummary,
): AnalysisRunRecord {
  return context.store.analysis.finish(run.id, {
    ruleVersions: result.ruleVersions,
    configHash: result.configHash,
    snapshotRows: result.snapshotRows,
    counts: {
      findings: applied,
      series,
      // §5.1's rollups: "31 more below $40/yr". Recorded on the run rather than
      // as findings, because a rollup is a statement about what was *not*
      // emitted and has no natural key to upsert on.
      rollups: result.rollups,
      transfers,
      warning: result.warning,
    },
  });
}

/**
 * §5.1's standing dismissals, applied at emit time.
 *
 * `rule` scope needs nothing but the rule id. `merchant_rule` needs the finding's
 * merchant, and only two subject types have one: `merchant` is the merchant, and
 * `series` resolves through the series this run just produced. A `portfolio`,
 * `category`, `window` or `account` finding is not about a merchant, so only a
 * rule-scoped dismissal can reach it — which is the honest reading of "this
 * merchant + this rule" rather than a gap.
 */
function toFindingInput(
  finding: Finding,
  runConfigHash: string,
  dismissalRules: readonly DismissalRuleRecord[],
  merchantBySeriesId: ReadonlyMap<string, string>,
): FindingInput {
  const merchantId =
    finding.subjectType === 'merchant'
      ? finding.subjectId
      : finding.subjectType === 'series'
        ? (merchantBySeriesId.get(finding.subjectId) ?? null)
        : null;

  const suppressed = dismissalRules.some(
    (rule) =>
      rule.ruleId === finding.ruleId &&
      (rule.scope === 'rule' || (merchantId !== null && rule.merchantId === merchantId)),
  );

  return {
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    // The run's hash, on every finding it produced. §5.1 wants a threshold change
    // to resurface a dismissal "grouped separately as re-evaluated with an
    // improved rule", and that comparison is against what the *user's dismissal*
    // recorded — so the current value has to be on the row to compare with.
    configHash: runConfigHash,
    naturalKey: finding.naturalKey,
    subjectType: finding.subjectType,
    subjectId: finding.subjectId,
    title: finding.title,
    detailJson: JSON.stringify(finding.detail),
    confidence: finding.confidence,
    band: finding.band,
    impactKind: finding.impactKind,
    impactMonthlyCents: finding.impactMonthlyCents,
    impactAnnualCents: finding.impactAnnualCents,
    llmDependent: finding.llmDependent,
    evidenceHash: finding.evidenceHash,
    evidenceTransactionIds: finding.evidenceTransactionIds,
    status: suppressed ? 'suppressed' : 'active',
  };
}

/**
 * §5.3's series into §3.1's row.
 *
 * `amount_cents_*` are magnitudes, which is what §5.2 computes and what the
 * Subscriptions page shows: a subscription costs $15.49, it does not cost
 * −$15.49. The sign convention (§3.1: negative is money leaving) lives on
 * `transaction`, where the direction is a fact about the row rather than about a
 * price.
 *
 * `charges`, `priceSteps` and `concurrentSeriesIds` are not persisted. §3.1's
 * table has no column for them and they are exactly recomputable from the
 * transactions the next run reads — storing them would be a second copy of the
 * ledger that could disagree with the first.
 */
function toSeriesInput(series: ReturnType<typeof analyze>['series'][number]): SeriesInput {
  return {
    id: series.id,
    merchantId: series.merchantId,
    accountId: series.accountId,
    cadenceDays: series.cadenceDays,
    cadenceLabel: series.cadenceLabel,
    cadencesPerYear: series.cadencesPerYear,
    amountCentsCurrent: series.amountCentsCurrent,
    amountCentsFirst: series.amountCentsFirst,
    firstSeen: series.firstSeen,
    lastSeen: series.lastSeen,
    nextExpected: series.nextExpected,
    occurrenceCount: series.occurrenceCount,
    status: series.status,
    regularity: series.regularity,
    confidence: series.confidence,
  };
}

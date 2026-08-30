/**
 * §7.6's scorecard: what the hand-labelled corpus says about the rules (§9ab).
 *
 * "Every threshold is re-derived against it before the numbers in this document are
 * treated as settled." This is the reading half of that sentence — the corpus is
 * collected by `transaction_label` and `finding_label`, and this turns the two into
 * the numbers a person would actually tune against.
 *
 * ## Precision and recall come from different tables, and neither substitutes
 *
 * §9z's `finding_label` answers "of what fired, how much was right" — precision, and
 * it can only ever see findings that exist. §9ab's `transaction_label` answers "of
 * what should have fired, how much did" — recall, and it works precisely because a
 * labelled row needs no finding to be compared against. A rule with high precision and
 * low recall is quietly useless; a rule with the reverse is noisy. Tuning needs both,
 * and the two are reported side by side for that reason.
 *
 * ## Nothing here is a percentage
 *
 * For §9z's reason, restated because it applies twice as hard once recall is in the
 * mix: eleven judgements do not support "82% accurate", and two figures shaped like
 * rates invite being divided into each other. Counts throughout.
 */

import type { TransactionLabelRecord } from '@metrum/ledgerline-data';

import type { LedgerlineContext } from './context.js';

/** One rule, as §7.6 would judge it. */
export interface RuleCalibration {
  readonly ruleId: string;
  /** From §9z's finding labels: of the findings this rule emitted and someone
   *  judged, how many were right. */
  readonly judgedCorrect: number;
  readonly judgedIncorrect: number;
  /**
   * From §9ab's transaction labels: rows asserted to be the thing this rule looks
   * for, and whether the rule agreed.
   *
   * `expected` counts only rows where somebody *asserted* — a NULL flag is not
   * evidence either way, which is the distinction that makes this a recall figure
   * rather than a count of unexamined rows.
   */
  readonly expected: number;
  readonly found: number;
  readonly missed: number;
  /** Rows the rule flagged that the labeller said were not the thing. Only
   *  computable where a row was explicitly asserted false. */
  readonly falsePositives: number;
}

export interface NormalizationCalibration {
  /** Rows where the labeller named a merchant and the chain had one too. */
  readonly compared: number;
  readonly agreed: number;
  readonly disagreed: number;
  /** Split by where the judgement came from, because the two are different
   *  evidence: corrections are by definition the rows the chain got wrong, and
   *  mixing them into the total makes normalization look far worse than it is. */
  readonly fromReview: { readonly compared: number; readonly agreed: number };
  readonly fromCorrection: { readonly compared: number; readonly agreed: number };
}

export interface Calibration {
  readonly progress: {
    readonly labelled: number;
    readonly fromReview: number;
    readonly fromCorrection: number;
    readonly total: number;
  };
  readonly normalization: NormalizationCalibration;
  readonly rules: readonly RuleCalibration[];
  /**
   * The judgements themselves, so the pass can show what it has already said
   * without a second request per row.
   *
   * On the scorecard rather than its own endpoint because the two are always read
   * together: a pass shows the verdicts and the progress side by side, and two
   * requests would let them disagree by one keystroke.
   */
  readonly labels: readonly TransactionLabelRecord[];
  /**
   * Set when no analysis has finished. Every recall figure below compares a label
   * against what the rules concluded, and without a run there is nothing to compare
   * to — reporting "everything was missed" would be a lie about the rules rather
   * than a fact about the corpus.
   */
  readonly unavailableReason: string | null;
}

/** The rules a single labelled row can speak to, and the flag that speaks to each. */
const ROW_LEVEL_RULES = [
  { ruleId: 'recurrence.v1', flag: 'isRecurring' },
  { ruleId: 'fees.v1', flag: 'isFee' },
  { ruleId: 'outlier.v1', flag: 'isOutlier' },
] as const;

export function calibration(context: LedgerlineContext): Calibration {
  const progress = context.store.transactionLabels.progress();
  const labels = context.store.transactionLabels.list();
  const lastRun = context.store.analysis.latestFinished();

  const normalization = normalizationOf(labels);

  if (!lastRun) {
    return {
      progress,
      normalization,
      rules: [],
      labels,
      unavailableReason:
        'No analysis has finished, so there is nothing to compare the labels against. ' +
        'Normalization accuracy above does not need one — it compares your answer to the ' +
        'chain’s, which runs at import.',
    };
  }

  // Which merchants the rules actually concluded something about. §5.2's series are
  // per merchant, so a row "is recurring" is found when its merchant has one.
  const seriesMerchants = new Set(
    context.store.analysis.listSeries().map((series) => series.merchantId),
  );

  // Everything §5 cited, by transaction, so a row-level assertion can be checked
  // against the rule that would have flagged it.
  const citedByRule = new Map<string, Set<string>>();
  for (const rule of ROW_LEVEL_RULES) {
    const page = context.store.findings.search({
      ruleIds: [rule.ruleId],
      statuses: ['active'],
      visibility: 'all',
      limit: 500,
    });
    const cited = new Set<string>();
    for (const row of page.rows) {
      for (const id of context.store.findings.listEvidence(row.finding.id)) cited.add(id);
    }
    citedByRule.set(rule.ruleId, cited);
  }

  const findingAccuracy = context.store.findingLabels.accuracyByRule();

  const rules = ROW_LEVEL_RULES.map((rule): RuleCalibration => {
    const cited = citedByRule.get(rule.ruleId) ?? new Set<string>();
    const judged = findingAccuracy.get(rule.ruleId);

    let expected = 0;
    let found = 0;
    let missed = 0;
    let falsePositives = 0;

    for (const label of labels) {
      const asserted = label[rule.flag];
      if (asserted === null) continue;

      // §5.2 is per merchant rather than per row: a subscription is a property of
      // the merchant, and the charge is evidence of it.
      const ruleAgrees =
        rule.ruleId === 'recurrence.v1'
          ? label.expectedMerchantId !== null
            ? seriesMerchants.has(label.expectedMerchantId)
            : label.chainMerchantId !== null && seriesMerchants.has(label.chainMerchantId)
          : cited.has(label.transactionId);

      if (asserted) {
        expected += 1;
        if (ruleAgrees) found += 1;
        else missed += 1;
      } else if (ruleAgrees) {
        // Asserted *not* the thing, and the rule flagged it anyway. Only countable
        // because a false assertion is stored rather than left NULL.
        falsePositives += 1;
      }
    }

    return {
      ruleId: rule.ruleId,
      judgedCorrect: judged?.correct ?? 0,
      judgedIncorrect: judged?.incorrect ?? 0,
      expected,
      found,
      missed,
      falsePositives,
    };
  });

  return { progress, normalization, rules, labels, unavailableReason: null };
}

/**
 * §4's accuracy, from the two merchant ids every label carries.
 *
 * The comparison only means something where the labeller named a merchant *and* the
 * chain had reached one — a row the chain left unresolved is a different failure and
 * belongs in §4.1 step 7's queue rather than in an accuracy figure.
 */
function normalizationOf(
  labels: readonly {
    expectedMerchantId: string | null;
    chainMerchantId: string | null;
    origin: 'review' | 'correction';
  }[],
): NormalizationCalibration {
  const tally = {
    compared: 0,
    agreed: 0,
    disagreed: 0,
    fromReview: { compared: 0, agreed: 0 },
    fromCorrection: { compared: 0, agreed: 0 },
  };

  for (const label of labels) {
    if (label.expectedMerchantId === null || label.chainMerchantId === null) continue;

    const agreed = label.expectedMerchantId === label.chainMerchantId;
    tally.compared += 1;
    if (agreed) tally.agreed += 1;
    else tally.disagreed += 1;

    const bucket = label.origin === 'review' ? tally.fromReview : tally.fromCorrection;
    bucket.compared += 1;
    if (agreed) bucket.agreed += 1;
  }

  return tally;
}

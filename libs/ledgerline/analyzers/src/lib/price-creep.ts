/**
 * `price_creep.v1` — §5.5.
 *
 * The steps themselves come with the series: `recurrence.ts` walks the charges in
 * date order, and `PriceStep.confirmed` has already applied §5.5's "holds for
 * `max(1, min(2, ceil(60 ÷ cadence_days)))` occurrences" rule. §5.3 forbids
 * re-deriving them here. What this rule owns is the **noise floor**, the
 * **confidence**, and the number that actually lands.
 *
 * ## The noise floor is stated in the unit the app sorts by
 *
 * The design session ignored changes "under 2% or $0.50", which suppresses a
 * $3.80 step on a $200/month subscription — 1.9%, but **$45.60 a year**, which is
 * material — while admitting a $0.60 step on an annual plan, which is sixty cents
 * a year. §5.5 replaces it with two conditions in cents: the step must be at
 * least $0.50 **and** annualize to at least $5. Percentage survives as a
 * presentation field, because "+72%" is how a person feels a price rise, but it
 * decides nothing.
 *
 * ## One finding per series, and the cumulative delta is its impact
 *
 * §5.5 asks for "every step with old price, new price, delta, percent, effective
 * date, and annualized impact, plus the cumulative change since the first
 * observed charge" — one card describing a series' whole price history, not one
 * card per step. The headline number is the cumulative one, because that is the
 * sentence that lands: "$8.99 → $15.49 since 2023, +72%, $78/yr more than when
 * you signed up."
 *
 * `impact_kind = savings`, and the impact is the **delta** rather than the
 * subscription's cost. §7.3 forbids two findings claiming the same dollars as
 * savings, and the cost itself belongs to §5.4 when it belongs to anyone.
 */

import type { AnalyzerConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import type { PriceStep, RecurringSeries } from './recurrence.js';
import type { Snapshot } from './snapshot.js';

export const PRICE_CREEP_RULE_ID = 'price_creep.v1';

export interface PriceCreepResult {
  readonly emission: RuleEmission;
  /**
   * Series whose first-to-second price transition passed the noise floor.
   * §5.6 suppresses its trial finding for exactly these — an intro rate that
   * this rule has already reported as a price step must not be reported a second
   * time as a converted trial.
   */
  readonly reportedFirstTransitionSeriesIds: ReadonlySet<string>;
}

export function analyzePriceCreep(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): PriceCreepResult {
  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const drafts: DraftFinding[] = [];
  const reportedFirstTransition = new Set<string>();

  for (const entry of series) {
    const material = entry.priceSteps.filter((step) => isMaterial(step, entry, config));
    if (material.length === 0) continue;

    if (entry.priceSteps.length > 0 && material.includes(entry.priceSteps[0])) {
      reportedFirstTransition.add(entry.id);
    }

    const cumulativeDeltaCents = entry.amountCentsCurrent - entry.amountCentsFirst;
    const annualisedCents = Math.round(cumulativeDeltaCents * entry.cadencesPerYear);
    const anyUnconfirmed = material.some((step) => !step.confirmed);

    const cap = anyUnconfirmed
      ? config.priceCreep.unconfirmedConfidenceCap
      : config.priceCreep.confirmedConfidenceCap;

    drafts.push({
      ruleId: PRICE_CREEP_RULE_ID,
      ruleVersion: PRICE_CREEP_RULE_ID,
      subjectType: 'series',
      subjectId: entry.id,
      title: `${merchants.get(entry.merchantId)?.displayName ?? 'Subscription'} price rose`,
      detail: {
        merchantId: entry.merchantId,
        accountId: entry.accountId,
        cadenceLabel: entry.cadenceLabel,
        cadencesPerYear: entry.cadencesPerYear,
        firstCents: entry.amountCentsFirst,
        currentCents: entry.amountCentsCurrent,
        cumulativeDeltaCents,
        cumulativePercent: percentOf(entry.amountCentsFirst, cumulativeDeltaCents),
        since: entry.firstSeen,
        // Unconfirmed steps are reported and labelled, not withheld — §5.5 asks
        // for "unconfirmed — one charge at the new price".
        steps: material.map((step) => ({
          at: step.at,
          fromCents: step.fromCents,
          toCents: step.toCents,
          deltaCents: step.deltaCents,
          percent: percentOf(step.fromCents, step.deltaCents),
          annualisedCents: Math.round(step.deltaCents * entry.cadencesPerYear),
          confirmed: step.confirmed,
        })),
      },
      evidenceTransactionIds: entry.charges.map((charge) => charge.transactionId),
      confidence: Math.min(cap, entry.confidence),
      impactKind: 'savings',
      impactMonthlyCents: Math.round(annualisedCents / 12),
      impactAnnualCents: annualisedCents,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: PRICE_CREEP_RULE_ID,
        subjectId: entry.id,
        // The current price, so a further rise resurfaces a dismissed finding —
        // which is §5.1's stated intent for "the price changed since you
        // dismissed this".
        amountCents: entry.amountCentsCurrent,
        cadenceLabel: entry.cadenceLabel,
        seriesStatus: entry.status,
      }),
    });
  }

  return {
    emission: applyEmissionPolicy(PRICE_CREEP_RULE_ID, drafts, config),
    reportedFirstTransitionSeriesIds: reportedFirstTransition,
  };
}

/** Both conditions, in cents. A step that fails either one is noise. */
function isMaterial(step: PriceStep, entry: RecurringSeries, config: AnalyzerConfig): boolean {
  const delta = Math.abs(step.deltaCents);
  return (
    delta >= config.priceCreep.minStepDeltaCents &&
    delta * entry.cadencesPerYear >= config.priceCreep.minAnnualisedDeltaCents
  );
}

/** Presentation only (§5.5). Returned rounded to one decimal because "+72.3%" is
 *  as much precision as a median-derived price supports. */
function percentOf(baseCents: number, deltaCents: number): number | null {
  if (baseCents === 0) return null;
  return Math.round((deltaCents / baseCents) * 1000) / 10;
}

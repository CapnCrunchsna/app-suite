/**
 * `lapsed.v1` — §5.7.
 *
 * "A series with ≥3 occurrences whose last charge is older than
 * `2 × cadence_days` relative to **its own account's coverage end** is marked
 * 'appears cancelled'. Low priority, informational, `impact_kind = visibility`,
 * and exempt from the $25 impact floor because its value is confirmation rather
 * than money."
 *
 * ## Useful in both directions, which is why it is worth a card at all
 *
 * It confirms a cancellation actually took effect — and its **absence** after you
 * cancelled something is the signal that they are still billing you. That second
 * reading is the one that earns the rule its place, and it only works if the rule
 * is reliable about the first.
 *
 * ## Two thresholds, deliberately different
 *
 * §5.2 stops calling a series active at `1.5 × cadence_days`; this rule does not
 * announce it as cancelled until `2 ×`. The gap is hysteresis, not an
 * inconsistency: a subscription that is merely late — a failed card, a statement
 * not yet imported — leaves the active set without being declared dead. Reading
 * `status === 'lapsed'` instead of measuring again would collapse the two and
 * announce every late charge.
 *
 * ## The impact is zero, and that is the point
 *
 * A lapsed series is not money being spent, so claiming its former cost as impact
 * would inflate every total on the Findings page with subscriptions that already
 * stopped. The former cost travels in the detail, where the UI can show it as
 * "was $9.99/mo" without any headline adding it up. Zero impact is also why the
 * floor exemption is load-bearing rather than a nicety: without it §5.1's $25
 * minimum would suppress every finding this rule emits.
 */

import { daysBetweenIso } from '@metrum/ledgerline-domain';

import type { AnalyzerConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import { annualCentsOf } from './duplicate.js';
import type { RecurringSeries } from './recurrence.js';
import { coverageEnd } from './snapshot.js';
import type { Snapshot } from './snapshot.js';

export const LAPSED_RULE_ID = 'lapsed.v1';

export function analyzeLapsed(
  snapshot: Snapshot,
  series: readonly RecurringSeries[],
  config: AnalyzerConfig,
): RuleEmission {
  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const coverageEnds = new Map(
    snapshot.accounts.map((account) => [account.id, coverageEnd(account)]),
  );

  const drafts: DraftFinding[] = [];

  for (const entry of series) {
    if (entry.occurrenceCount < config.lapsed.minOccurrences) continue;

    const end = coverageEnds.get(entry.accountId) ?? null;
    // No statements for the account means nothing to measure against. §7.2 is
    // explicit that missing coverage is the normal condition of this app, and
    // "we stopped importing" is not evidence that a subscription stopped.
    if (end === null) continue;

    const silentDays = daysBetweenIso(entry.lastSeen, end);
    if (silentDays <= entry.cadenceDays * config.lapsed.cadenceMultiple) continue;

    const formerAnnualCents = annualCentsOf(entry);

    drafts.push({
      ruleId: LAPSED_RULE_ID,
      ruleVersion: LAPSED_RULE_ID,
      subjectType: 'series',
      subjectId: entry.id,
      title: `${merchants.get(entry.merchantId)?.displayName ?? 'Subscription'} appears cancelled`,
      detail: {
        merchantId: entry.merchantId,
        accountId: entry.accountId,
        lastChargeAt: entry.lastSeen,
        coverageEnd: end,
        silentDays,
        cadenceLabel: entry.cadenceLabel,
        expectedEvery: Math.round(entry.cadenceDays),
        formerMonthlyCents: Math.round(formerAnnualCents / 12),
        formerAnnualCents,
        occurrenceCount: entry.occurrenceCount,
      },
      evidenceTransactionIds: entry.charges.map((charge) => charge.transactionId),
      confidence: entry.confidence,
      impactKind: 'visibility',
      impactMonthlyCents: 0,
      impactAnnualCents: 0,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: LAPSED_RULE_ID,
        subjectId: entry.id,
        amountCents: entry.amountCentsCurrent,
        cadenceLabel: entry.cadenceLabel,
        // §5.1 puts `series_status` in the hash for exactly this rule: when a
        // dormant series resumes, the status flips, the hash moves, and a
        // dismissed "appears cancelled" comes back flagged as changed.
        seriesStatus: entry.status,
      }),
    });
  }

  return applyEmissionPolicy(LAPSED_RULE_ID, drafts, config, { exemptFromImpactFloor: true });
}

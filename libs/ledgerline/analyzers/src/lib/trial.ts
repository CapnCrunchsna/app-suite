/**
 * `trial.v1` — §5.6.
 *
 * "Signals combine; **no single signal is sufficient on its own** except an
 * explicit trial descriptor." Four signals, `0.30 + 0.15 × points` capped at
 * 0.85, emitted at two points or more.
 *
 * ## The three corrections, each of which was a guaranteed false positive
 *
 * **Signals one and two were the same signal.** The design session scored "first
 * real charge falls 7/14/30/90 days after the merchant's first-ever appearance"
 * separately from "a small authorization before the first charge" — but the
 * first can only fire when an earlier non-charge row exists, which *is* the
 * second. For a merchant whose first row is its first charge the delta is zero
 * and nothing matches. Scoring them independently double-counted one
 * observation, so the interval here is measured **from the authorization**.
 *
 * **Bare `FREE` as a substring** matches `FREE PEOPLE`, `FREEDOM MORTGAGE`,
 * `FREEPORT`, `FREESTYLE`. Normalization uppercases everything, so an unanchored
 * substring test over every descriptor in the database is a guaranteed noise
 * generator. Matching is whole-token and `FREE` alone is gone.
 *
 * **"Any one signal makes a candidate" plus the intro-rate signal** fires on
 * every subscription whose price ever went up — the entire subscription base. The
 * intro-rate signal is worth one point, cannot emit alone, and the finding is
 * suppressed outright when `price_creep.v1` already reported a step at the same
 * first-to-second transition.
 *
 * ## Two things this file deliberately does not invent
 *
 * §5.6's fourth signal is "the first charge is materially below the subsequent
 * steady-state amount", and "materially" is not quantified. Rather than pick a
 * number, it reads the series: the first charge is materially below when the
 * series' **first price step is an increase**, which is true exactly when the
 * amounts differed enough to be separate price levels *and* the higher one held.
 * That is the same transition §5.6's suppression rule refers to, so the signal
 * and the suppression agree by construction rather than by inspection.
 *
 * §5.6 also does not state an `impact_kind`. See the note on `impactKindFor`.
 */

import { daysBetweenIso } from '@metrum/ledgerline-domain';

import type { AnalyzerConfig } from './config.js';
import { applyEmissionPolicy, evidenceHash } from './finding.js';
import type { DraftFinding, RuleEmission } from './finding.js';
import { annualCentsOf } from './duplicate.js';
import type { RecurringSeries } from './recurrence.js';
import { llmAttributedIds } from './snapshot.js';
import type { Snapshot, SnapshotTransaction } from './snapshot.js';

export const TRIAL_RULE_ID = 'trial.v1';

export interface TrialInput {
  readonly snapshot: Snapshot;
  readonly series: readonly RecurringSeries[];
  /** From `price_creep.v1`. §5.6: the finding is suppressed entirely when that
   *  rule has already reported a step at the same first-to-second transition. */
  readonly reportedFirstTransitionSeriesIds: ReadonlySet<string>;
  readonly config: AnalyzerConfig;
}

export function analyzeTrials(input: TrialInput): RuleEmission {
  const { snapshot, series, config } = input;
  const merchants = new Map(snapshot.merchants.map((merchant) => [merchant.id, merchant]));
  const windowStart = earliestDate(snapshot.transactions);
  const drafts: DraftFinding[] = [];

  for (const entry of series) {
    if (input.reportedFirstTransitionSeriesIds.has(entry.id)) continue;

    const scored = score(entry, snapshot, config);
    if (scored.points < config.trial.minPoints) continue;

    // §5.6's stated limitation. A first charge this close to the start of the
    // imported window cannot be told apart from a pre-existing subscription we
    // are only now seeing, and the finding says so rather than hiding it.
    const earlyInWindow =
      windowStart !== null &&
      daysBetweenIso(windowStart, entry.firstSeen) < config.trial.earlyWindowDays;

    const raw = Math.min(
      config.trial.baseConfidence + config.trial.confidencePerPoint * scored.points,
      config.trial.maxConfidence,
    );

    /**
     * Halved, but not out of existence.
     *
     * §5.6 halves confidence in the blind spot and says "The UI says so on the
     * finding **rather than hiding it**" — so the halving cannot be allowed to
     * push the finding under §5.1's suppression threshold, which would hide it.
     * That bites in the ordinary case rather than a corner: a two-point finding
     * scores 0.60, halves to 0.30, and 0.35 is where suppression starts. Floored
     * at the bottom of the Low band, which is the weakest claim the bands can
     * still show. See §9d.
     */
    const confidence = earlyInWindow ? Math.max(raw / 2, config.global.bands.low) : raw;
    const annualCents = annualCentsOf(entry);

    drafts.push({
      ruleId: TRIAL_RULE_ID,
      ruleVersion: TRIAL_RULE_ID,
      subjectType: 'series',
      subjectId: entry.id,
      title: `${merchants.get(entry.merchantId)?.displayName ?? 'Subscription'} looks like a converted trial`,
      detail: {
        merchantId: entry.merchantId,
        accountId: entry.accountId,
        points: scored.points,
        signals: scored.signals,
        authorizationTransactionId: scored.authorizationId,
        firstChargeAt: entry.firstSeen,
        annualCents,
        earlyInWindow,
        limitation: earlyInWindow
          ? 'This merchant’s first charge lands near the start of the imported window, so a ' +
            'converted trial and a pre-existing subscription look the same. Confidence is halved.'
          : null,
      },
      evidenceTransactionIds: [
        ...(scored.authorizationId ? [scored.authorizationId] : []),
        ...entry.charges.map((charge) => charge.transactionId),
      ],
      confidence,
      impactKind: impactKindFor(),
      impactMonthlyCents: Math.round(annualCents / 12),
      impactAnnualCents: annualCents,
      llmDependent: false,
      evidenceHash: evidenceHash({
        ruleId: TRIAL_RULE_ID,
        subjectId: entry.id,
        amountCents: entry.amountCentsCurrent,
        cadenceLabel: entry.cadenceLabel,
        seriesStatus: entry.status,
      }),
    });
  }

  return applyEmissionPolicy(TRIAL_RULE_ID, drafts, config, {
    llmAttributed: llmAttributedIds(snapshot),
  });
}

/**
 * §5.6 does not state one, and the choice is not free.
 *
 * `savings` would be the intuitive reading — a converted trial is the classic
 * "cancel this" case. But the impact would be the series' whole annual cost, and
 * §5.4's same-merchant rule already claims a duplicate series' annual cost as
 * `savings` while §5.5 claims its price delta. Two of those three can describe
 * one series, and §7.3 says "two findings may never claim the same dollars as
 * `savings`". §5.1's three examples of savings — a price-creep delta, a duplicate
 * subscription's cost, an avoidable maintenance fee — pointedly do not include
 * this one.
 *
 * So `visibility`: the finding's value is that you did not realise this became a
 * paid subscription, which is information, and it keeps the headline honest.
 * Recorded in §9d as a gap filled rather than a rule overridden.
 */
function impactKindFor(): 'savings' | 'visibility' {
  return 'visibility';
}

interface Score {
  readonly points: number;
  readonly signals: readonly string[];
  readonly authorizationId: string | null;
}

function score(entry: RecurringSeries, snapshot: Snapshot, config: AnalyzerConfig): Score {
  const signals: string[] = [];
  let points = 0;

  const authorization = findAuthorization(entry, snapshot, config);
  if (authorization) {
    points += 2;
    signals.push('authorization');

    const gap = daysBetweenIso(authorization.effectiveDate, entry.firstSeen);
    const matchesTrialLength = config.trial.trialLengthsDays.some(
      (length) => Math.abs(gap - length) <= config.trial.trialLengthToleranceDays,
    );
    if (matchesTrialLength) {
      points += 1;
      signals.push('trial_length');
    }
  }

  if (hasTrialMarker(entry, snapshot, config)) {
    points += 2;
    signals.push('trial_marker');
  }

  // Worth one point and never sufficient alone (§5.6's third correction).
  const firstStep = entry.priceSteps[0];
  if (firstStep && firstStep.deltaCents > 0) {
    points += 1;
    signals.push('intro_rate');
  }

  return { points, signals, authorizationId: authorization?.id ?? null };
}

/**
 * The classic card-validation pattern: a $0.00 or near-zero charge at the same
 * merchant and account, 5–35 days before the first real charge.
 *
 * §3.2 admits a $0 row only as a trial authorization, which is precisely this —
 * so the rows this looks for are the ones the Import page's `allowZeroAmountRows`
 * opt-in exists to let through.
 */
function findAuthorization(
  entry: RecurringSeries,
  snapshot: Snapshot,
  config: AnalyzerConfig,
): SnapshotTransaction | null {
  const candidates = snapshot.transactions.filter((transaction) => {
    if (transaction.merchantId !== entry.merchantId) return false;
    if (transaction.accountId !== entry.accountId) return false;
    if (transaction.isExcluded) return false;
    if (Math.abs(transaction.amountCents) > config.trial.authorizationMaxCents) return false;

    const gap = daysBetweenIso(transaction.effectiveDate, entry.firstSeen);
    return (
      gap >= config.trial.authorizationMinDaysBefore &&
      gap <= config.trial.authorizationMaxDaysBefore
    );
  });

  // The closest one to the first charge: with two authorizations the later is the
  // one the trial clock plausibly started from.
  return [...candidates].sort((a, b) => (a.effectiveDate > b.effectiveDate ? -1 : 1))[0] ?? null;
}

/** Whole-token match on the normalized descriptors of the series' own charges
 *  and of any authorization at that merchant. */
function hasTrialMarker(
  entry: RecurringSeries,
  snapshot: Snapshot,
  config: AnalyzerConfig,
): boolean {
  const ids = new Set(entry.charges.map((charge) => charge.transactionId));
  const descriptors = snapshot.transactions
    .filter((transaction) => ids.has(transaction.id) || transaction.merchantId === entry.merchantId)
    .map((transaction) => transaction.descriptionNormalized);

  return descriptors.some((descriptor) =>
    config.trial.trialMarkers.some((marker) => containsTokens(descriptor, marker)),
  );
}

/**
 * `marker` as a run of whole tokens inside `descriptor`.
 *
 * Splitting on non-alphanumerics rather than on spaces, because a descriptor
 * reaches this having been through §4's chain but not through §3.3's collapse —
 * `INTRO-OFFER` and `INTRO OFFER` are the same claim and a space-only split would
 * miss the first.
 */
function containsTokens(descriptor: string, marker: string): boolean {
  const tokens = descriptor
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const wanted = marker
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (wanted.length === 0) return false;

  for (let start = 0; start + wanted.length <= tokens.length; start += 1) {
    if (wanted.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

function earliestDate(transactions: readonly SnapshotTransaction[]): string | null {
  let earliest: string | null = null;
  for (const transaction of transactions) {
    if (earliest === null || transaction.effectiveDate < earliest) {
      earliest = transaction.effectiveDate;
    }
  }
  return earliest;
}

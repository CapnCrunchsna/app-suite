/**
 * §7.4: "Every threshold in §5 is a default in a config object; Settings
 * overrides it; `analysis_run` records `config_hash`; `finding.rule_version`
 * incorporates it. **No analyzer reads a module-level constant.**"
 *
 * That last sentence is the rule this file exists to make true, and the reason is
 * in §5.1: changing a threshold that lives in code silently resolves and
 * re-creates findings with no explanation, and quietly invalidates dismissals
 * whose evidence never changed. With the threshold in a hashed config, the same
 * change resurfaces those findings grouped as "re-evaluated with an improved
 * rule" — the user is told why their dismissal was reopened.
 *
 * **Every number here is uncalibrated** in the §7.6 sense. Nothing in §5 has been
 * run against a real statement; these are starting points with stated reasoning,
 * and the hash machinery below exists precisely so that tuning them is a normal
 * operation rather than a schema migration.
 *
 * Analyzers take `(snapshot, config)`. A rule that reaches for a constant instead
 * is a rule whose behaviour cannot be explained from `analysis_run`.
 */

import { createHash } from 'node:crypto';

import type { Cadence } from './cadence.js';

/** §5.1's bands. Bands, not raw numbers, reach the user — a "0.72" implies a
 *  precision these rules do not have. */
export interface BandThresholds {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface GlobalConfig {
  readonly bands: BandThresholds;
  /**
   * §5.1's absolute impact floor. No finding under this annual impact is emitted
   * unless its rule opts out — only `lapsed.v1` does, because its value is
   * confirmation rather than money. Applied globally, this kills the largest
   * single source of noise in §5.9 and §5.10 without touching their statistics.
   */
  readonly minAnnualImpactCents: number;
  /**
   * §5.1's emission budget. False-positive volume is the failure mode that gets a
   * tool like this abandoned, and an unbounded rule is one bad threshold away
   * from producing a thousand cards.
   */
  readonly maxFindingsPerRule: number;
  /** §2.4/§5.1: confidence is capped at Medium for any `llm_dependent` finding. */
  readonly llmDependentConfidenceCap: number;
  /**
   * §2.2's guard on the snapshot, which that section insists on having: "The
   * design is allowed to have a ceiling — it is not allowed to have an
   * undiscovered one." A heavy household is ~58,000 transactions, so these are
   * four and seventeen times the design load.
   */
  readonly snapshotWarnRows: number;
  readonly snapshotMaxRows: number;
}

export interface RecurrenceConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the series it produces feed §5.4–§5.7 and §6.5.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /**
   * §5.2's cadence table — data, not a constant, for the reason at the top of
   * this file. The tolerances in particular are exactly the kind of number §7.6
   * expects to move once real statements exist: a bank that bills "the first
   * business day" produces monthly gaps that drift further than ±4 across a run
   * of holidays.
   */
  readonly cadences: readonly Cadence[];
  /** §5.2 pass 1: split wherever the gap to the running median exceeds
   *  `max(percent, floor)`. */
  readonly amountTolerancePercent: number;
  readonly amountToleranceFloorCents: number;
  /** Pass 1 recomputes medians and re-splits until stable, capped here. */
  readonly seedIterations: number;
  /** Charges needed before a cluster gets a cadence fit at all. */
  readonly minOccurrences: number;
  /** §5.2's cadence fit allows up to two missed cycles: `1 ≤ k ≤ 3`. */
  readonly maxCyclesPerDelta: number;
  /** Four-weekly beats monthly only when every delta is in range *and* there are
   *  at least this many charges — a fixed-day-of-month subscription cannot
   *  produce that, because any span covering a 31-day month forces 30 or 31. */
  readonly fourWeeklyMinOccurrences: number;
  readonly fourWeeklyDeltaMinDays: number;
  readonly fourWeeklyDeltaMaxDays: number;
  /** §5.2's annual exception: two charges this far apart with stable amounts
   *  emit at Medium without the known-subscription flag. */
  readonly annualPairMinDays: number;
  readonly annualPairMaxDays: number;
  /** Active = last charge within this multiple of `cadence_days` of the
   *  account's coverage end (§7.2). */
  readonly livenessCadenceMultiple: number;
  readonly weightRegularity: number;
  readonly weightCount: number;
  readonly weightAmountStability: number;
  readonly knownSubscriptionBonus: number;
  /** `count_score = clamp((n − 2) ÷ span, 0, 1)` — 0.17 at three occurrences,
   *  1.0 at eight. */
  readonly countScoreSpan: number;
  /** `amount_stability = 1 − clamp(CV ÷ ceiling, 0, 1)`. */
  readonly amountStabilityCvCeiling: number;
  /**
   * §5.2's fee test: the share of a fitted series' charges whose exact amount
   * occurs more than once in it.
   *
   * A subscription is a **fee** — the same amount, over and over — so its charges
   * sit on one flat plateau, or on two when the price changed. Ordinary repeat
   * spending at one merchant is a scatter of one-off numbers that never repeat, and
   * over enough charges some subset of it will always land on a cadence. Measured
   * on exact amounts rather than a dispersion, because a plateau is what a fee
   * *is*; a coefficient of variation cannot tell two tight plateaus from a narrow
   * scatter, and computing it inside the current price step makes a one-charge step
   * perfectly stable by construction.
   *
   * Applies to `fitted` series only. §5.2's two annual exceptions are exempt: a
   * single charge cannot repeat, and an annual pair already has to clear
   * `amountStabilityCvCeiling` to qualify at all.
   */
  readonly feePlateauShare: number;
  /** §5.2's caps. Under the design session's formula a two-occurrence series
   *  scored 0.90 — MAD of a single delta is always zero, so regularity was always
   *  1.0 — which contradicted the same section's "two occurrences emit at Low". */
  readonly twoOccurrenceConfidenceCap: number;
  readonly threeOccurrenceConfidenceCap: number;
  /** §5.5's "holds" requirement, as a day budget: a step is confirmed by
   *  `max(1, min(2, ceil(days ÷ cadence_days)))` occurrences at the new price, so
   *  weekly through monthly need two and quarterly through annual need one. */
  readonly priceStepConfirmationDays: number;
  /**
   * The smallest amount change that counts as a **different price level**, as
   * opposed to proration noise.
   *
   * Distinct from `amountTolerancePercent` above, which decides whether two
   * charges belong to the same *cluster*, and distinct again from §5.5's
   * reporting floor, which decides whether a step is worth telling the user
   * about. Collapsing this into the clustering tolerance is what hides §5.5's own
   * motivating example: at 5%, a $3.80 rise on a $200/month subscription never
   * becomes a step at all, so the noise floor stated in cents never gets to see
   * it. See §9d.
   */
  readonly priceStepMinDeltaCents: number;
}

/** §5.4 — two rules under one id, "deliberately weighted differently, and
 *  separately toggleable in Settings — one claims an error, the other claims
 *  nothing." The toggles are why they are two flags rather than one. */
export interface DuplicateConfig {
  readonly sameMerchantEnabled: boolean;
  readonly categoryOverlapEnabled: boolean;
  /** Usually a real error: a double-charged account, or a personal plan still
   *  billing after a family plan started. */
  readonly sameMerchantConfidence: number;
  /** Informational. Owning both Netflix and Disney+ is a legitimate choice; the
   *  app's job is to make the total visible, not to nag. */
  readonly categoryOverlapConfidence: number;
}

export interface PriceCreepConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /**
   * §5.5's noise floor, stated in the unit the whole app sorts by. The design
   * session's "under 2% or $0.50" suppressed a $3.80 step on a $200/month
   * subscription (1.9%, $45.60/yr — material) while admitting a $0.60 step on an
   * annual plan ($0.60/yr — not). Percentage is a presentation field, not a
   * filter.
   */
  readonly minStepDeltaCents: number;
  readonly minAnnualisedDeltaCents: number;
  /** §5.5: the arithmetic is certain; the only doubt is whether the series is
   *  really one subscription, which is what `series.confidence` measures. */
  readonly confirmedConfidenceCap: number;
  readonly unconfirmedConfidenceCap: number;
}

export interface TrialConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /** The classic card-validation pattern: a $0.00 or near-zero authorization
   *  shortly before the first real charge. */
  readonly authorizationMaxCents: number;
  readonly authorizationMinDaysBefore: number;
  readonly authorizationMaxDaysBefore: number;
  /** Trial lengths that count as corroboration, measured from the authorization
   *  and not from the merchant's first appearance — §5.6's first correction. */
  readonly trialLengthsDays: readonly number[];
  readonly trialLengthToleranceDays: number;
  /**
   * Whole-token markers. `FREE` alone is deliberately absent: normalization
   * uppercases everything, so an unanchored substring test matches `FREE PEOPLE`
   * (a clothing retailer), `FREEDOM MORTGAGE`, `FREEPORT` and `FREESTYLE`.
   */
  readonly trialMarkers: readonly string[];
  readonly baseConfidence: number;
  readonly confidencePerPoint: number;
  readonly maxConfidence: number;
  readonly minPoints: number;
  /** §5.6's stated limitation: a first charge this close to the start of the
   *  imported window cannot be told apart from a pre-existing subscription, so
   *  confidence is halved and the finding says so. */
  readonly earlyWindowDays: number;
}

export interface LapsedConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  readonly minOccurrences: number;
  /** §5.7 uses `2 ×`, where §5.2's liveness uses `1.5 ×`. The gap between them is
   *  hysteresis rather than an inconsistency: a series that is merely late stops
   *  counting as active without immediately being announced as cancelled. */
  readonly cadenceMultiple: number;
}

/**
 * §2.6's internal-transfer matcher.
 *
 * Every number below is transcribed from that section's scoring table and its
 * candidate window, and lives here rather than in `transfers.ts` for the reason at
 * the top of this file — but the stakes are higher here than for any §5 threshold.
 * §2.6's own argument is an asymmetry: "A false link removes money from every
 * total invisibly; a false negative leaves a number that is visibly too big." The
 * dial that decides which of those you get is `autoLinkScore`, and it is data so
 * that moving it is a recorded, hashed decision rather than an edit somebody
 * notices three months of wrong headlines later.
 */
export interface TransferConfig {
  /** §2.6's keyword list, matched as substrings of `description_normalized` —
   *  which §4.1's stages 1–5 have already uppercased and space-collapsed. */
  readonly keywords: readonly string[];
  /**
   * §2.6's candidate window: `−1 ≤ (c.effective_date − d.effective_date) ≤ 7`.
   * "Money leaves before it lands, and one day of posting-order noise is normal.
   * Seven days covers ACH settlement across a holiday weekend; ±3 loses the common
   * case."
   */
  readonly windowMinDays: number;
  readonly windowMaxDays: number;
  /** The gap that earns the corroborating point, which is the ±3 the design
   *  session wanted as a *predicate* — kept as a signal instead. */
  readonly closeGapDays: number;

  readonly pointsKeywordBothSides: number;
  readonly pointsCounterpartyLast4: number;
  readonly pointsCreditCardInstitution: number;
  readonly pointsCloseGap: number;
  /** §2.6's "Learning": confirming a proposal writes a `transfer_rule` that scores
   *  this much on subsequent runs, so a monthly card payment is confirmed once and
   *  auto-links thereafter. */
  readonly pointsLearnedRule: number;
  /** The two negative signals, both worth −2 in §2.6. */
  readonly pointsRecurringSpendSeries: number;
  readonly pointsSpendCategory: number;

  /** §2.6's dispositions. `≥ autoLinkScore` links silently; `≥ proposeScore` goes
   *  to §6.2's queue and is **not** excluded from spend until confirmed; below
   *  that, nothing. */
  readonly autoLinkScore: number;
  readonly proposeScore: number;

  /** §2.6's partial-payment pass: "a single credit in B against a set of ≤3 debits
   *  in A inside the window summing exactly to it". */
  readonly maxPartialParts: number;
  /** A ceiling on the debits one credit is tried against, so the subset search
   *  stays bounded. `C(24, 3)` is 2,024 combinations, which is nothing; an
   *  uncapped pool over a busy account is not. */
  readonly maxPartialCandidates: number;

  /** How an institution name is looked for inside a descriptor. A bank calls
   *  itself "Cardinal Bank" and prints `ONLINE PMT CARDINAL CARD`, so the whole
   *  string rarely appears and a token test is the only one that fires. */
  readonly institutionTokenMinLength: number;
  /** Tokens too generic to identify anyone. Without these, every institution
   *  matches every card descriptor through the word `CARD`. */
  readonly institutionStopWords: readonly string[];
}

export interface AnalyzerConfig {
  readonly global: GlobalConfig;
  readonly recurrence: RecurrenceConfig;
  readonly duplicate: DuplicateConfig;
  readonly priceCreep: PriceCreepConfig;
  readonly trial: TrialConfig;
  readonly lapsed: LapsedConfig;
  readonly transfers: TransferConfig;
  readonly fees: FeesConfig;
  readonly outlier: OutlierConfig;
  readonly trend: TrendConfig;
  readonly micro: MicroConfig;
}

/** §5.8. The keyword lists are data for the usual §7.4 reason and for one more:
 *  they are the part of this rule most likely to be wrong about a bank nobody
 *  has imported yet, and adding a keyword should not be a code change. */
export interface FeesConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /** §5.8's list, matched **whole-token** against `description_normalized`. A
   *  substring test would make `NSF` match `TRANSFERS` and `ATM` match `ATMOS`. */
  readonly keywords: readonly string[];
  /**
   * §5.8's exclusions. `INTEREST CHECKING` and `INTEREST EARNED` are account
   * descriptors rather than fees; the disqualifying tokens rule out a match
   * outright, because a line reading `LATE FEE REVERSAL` is the opposite of a
   * late fee.
   */
  readonly excludedPhrases: readonly string[];
  readonly disqualifyingTokens: readonly string[];
  /** §5.8: "A fee credited back within 60 days at the same account and amount is
   *  netted to zero." */
  readonly reversalWindowDays: number;
  /**
   * The avoidable subset — §5.8's "recurring maintenance fees [...] they usually
   * have a fee-waiver condition". A keyword from this list seen at least
   * `avoidableMinOccurrences` times on one account is the part that carries
   * `impact_kind = savings`.
   */
  readonly avoidableKeywords: readonly string[];
  readonly avoidableMinOccurrences: number;
  /** §5.8: "Confidence **0.95** on a keyword hit, **0.75** on a category-only
   *  hit." */
  readonly keywordConfidence: number;
  readonly categoryOnlyConfidence: number;
}

export interface OutlierConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /** §5.9's sample sizes. A distribution needs members before a charge can be
   *  unlike them. */
  readonly merchantMinSamples: number;
  readonly categoryMinSamples: number;
  /** §5.9: "flag `|z| > 3.5`". */
  readonly zThreshold: number;
  /** §5.9's `MAD = 0` fallback: "anything above `3 × median`". */
  readonly steadyMultiple: number;
  /**
   * §5.9's absolute floor, and the reason it is on *every* branch: "a coffee shop
   * with a $6.40 median and a $0.50 MAD flags a $9.80 latte at z = 4.6, and the
   * MAD=0 fallback flags a $7 transit fare against a $2 median."
   */
  readonly minExcessCents: number;
  /** §5.9's global branch, for the one-off large charge at a merchant with no
   *  history — which has no distribution to be an outlier in. */
  readonly globalPercentile: number;
  readonly globalMinCents: number;
  readonly globalTopN: number;
  /**
   * The window needs this many candidates before a 99th percentile means
   * anything. §5.9 sets a minimum sample for the merchant branch (5) and the
   * category branch (15) and none for this one — but a 99th percentile over six
   * debits *is* the largest of them by construction, so without a floor here the
   * rule emits a "largest charges" rollup for any account holding one charge over
   * $200. Recorded in §9g.
   */
  readonly globalMinSamples: number;
  readonly zConfidenceBase: number;
  readonly zConfidencePerPoint: number;
  readonly zConfidenceMax: number;
  readonly steadyConfidence: number;
  readonly globalConfidence: number;
}

export interface TrendConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /** §5.10's spike: "exceeds its trailing three-month average by **both** >40%
   *  *and* >$75 **of excess**" — both, because a percentage alone flags a $12
   *  category and a dollar amount alone flags every large category every month. */
  readonly trailingMonths: number;
  readonly spikePercent: number;
  readonly spikeExcessCents: number;
  /** §5.10's climb: three consecutive increases totalling >25% and >$50/month. */
  readonly climbMonths: number;
  readonly climbPercent: number;
  readonly climbRiseCents: number;
  /**
   * The volatility test that keeps an ordinary random walk from reading as a
   * trend. §5.10: three consecutive increases happen "about one window in eight;
   * across thirty categories and a year of windows that is roughly twenty-five
   * spurious climbs per run."
   */
  readonly climbMadMultiple: number;
  /** §5.10: a category dominated by one recurring series is §5.2's and §5.5's
   *  business, and they cover it better. */
  readonly seriesDominanceFraction: number;
  /** §5.10's own caps, tighter than §5.1's budget of 25. */
  readonly maxSpikes: number;
  readonly maxClimbs: number;
  readonly spikeConfidence: number;
  readonly climbConfidence: number;
}

export interface MicroConfig {
  /**
   * §6.8's per-rule enable. `false` suppresses this rule's *findings*; it does not
   * stop it running, because the shared snapshot pass is one traversal either way.
   * Part of the config, so turning a rule off moves `config_hash` and §5.1
   * re-evaluates its dismissals — which is what §6.8 warns about.
   */
  readonly enabled: boolean;
  /** §5.11: "averaging ≥8 transactions per month across fully-covered months, at
   *  a median ≤$15". */
  readonly minPerMonth: number;
  readonly maxMedianCents: number;
  /** Fully-covered months needed before an average over them means anything. */
  readonly minMonths: number;
  /** A category that is one qualifying merchant restated is not a second finding.
   *  Same shape as §5.10's dominance test, and there for the same reason. */
  readonly merchantDominanceFraction: number;
  readonly confidence: number;
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  global: {
    bands: { high: 0.8, medium: 0.55, low: 0.35 },
    minAnnualImpactCents: 2500,
    maxFindingsPerRule: 25,
    // The top of the Medium band. §5.1 says "capped at Medium", which is a band
    // and not a number, so the cap is the highest confidence still inside it.
    llmDependentConfidenceCap: 0.79,
    snapshotWarnRows: 250_000,
    snapshotMaxRows: 1_000_000,
  },
  recurrence: {
    enabled: true,
    cadences: [
      { label: 'weekly', days: 7, toleranceDays: 2, perYear: 52.18 },
      { label: 'biweekly', days: 14, toleranceDays: 2, perYear: 26.09 },
      { label: 'four_weekly', days: 28, toleranceDays: 2, perYear: 13.04 },
      { label: 'monthly', days: 30.44, toleranceDays: 4, perYear: 12 },
      { label: 'quarterly', days: 91.3, toleranceDays: 7, perYear: 4 },
      { label: 'semiannual', days: 182.6, toleranceDays: 12, perYear: 2 },
      { label: 'annual', days: 365.25, toleranceDays: 20, perYear: 1 },
    ],
    amountTolerancePercent: 0.05,
    amountToleranceFloorCents: 100,
    seedIterations: 5,
    minOccurrences: 3,
    maxCyclesPerDelta: 3,
    fourWeeklyMinOccurrences: 6,
    fourWeeklyDeltaMinDays: 27,
    fourWeeklyDeltaMaxDays: 29,
    annualPairMinDays: 355,
    annualPairMaxDays: 375,
    livenessCadenceMultiple: 1.5,
    weightRegularity: 0.45,
    weightCount: 0.3,
    weightAmountStability: 0.25,
    knownSubscriptionBonus: 0.1,
    countScoreSpan: 6,
    amountStabilityCvCeiling: 0.05,
    // Half, from the first real statement: every genuine subscription in it scored
    // 1.00 and every false one 0.00, so the threshold sits in an empty gap rather
    // than on a slope. Recorded in §9l, and §7.6 still applies — it is one file.
    feePlateauShare: 0.5,
    twoOccurrenceConfidenceCap: 0.45,
    threeOccurrenceConfidenceCap: 0.7,
    priceStepConfirmationDays: 60,
    priceStepMinDeltaCents: 50,
  },
  duplicate: {
    sameMerchantEnabled: true,
    categoryOverlapEnabled: true,
    sameMerchantConfidence: 0.85,
    categoryOverlapConfidence: 0.6,
  },
  priceCreep: {
    enabled: true,
    minStepDeltaCents: 50,
    minAnnualisedDeltaCents: 500,
    confirmedConfidenceCap: 0.9,
    unconfirmedConfidenceCap: 0.7,
  },
  trial: {
    enabled: true,
    authorizationMaxCents: 150,
    authorizationMinDaysBefore: 5,
    authorizationMaxDaysBefore: 35,
    trialLengthsDays: [7, 14, 30, 90],
    trialLengthToleranceDays: 3,
    trialMarkers: ['TRIAL', 'FREE TRIAL', 'INTRO OFFER', 'INTRO RATE'],
    baseConfidence: 0.3,
    confidencePerPoint: 0.15,
    maxConfidence: 0.85,
    minPoints: 2,
    earlyWindowDays: 45,
  },
  lapsed: {
    enabled: true,
    minOccurrences: 3,
    cadenceMultiple: 2,
  },
  transfers: {
    keywords: [
      'TRANSFER',
      'XFER',
      'ONLINE PMT',
      'AUTOPAY',
      'PAYMENT THANK YOU',
      'E-PAYMENT',
      'ACH PMT',
    ],
    windowMinDays: -1,
    windowMaxDays: 7,
    closeGapDays: 3,
    pointsKeywordBothSides: 3,
    pointsCounterpartyLast4: 2,
    pointsCreditCardInstitution: 2,
    pointsCloseGap: 1,
    pointsLearnedRule: 3,
    pointsRecurringSpendSeries: -2,
    pointsSpendCategory: -2,
    autoLinkScore: 5,
    proposeScore: 2,
    maxPartialParts: 3,
    maxPartialCandidates: 24,
    institutionTokenMinLength: 4,
    institutionStopWords: [
      'BANK',
      'CARD',
      'CREDIT',
      'UNION',
      'FEDERAL',
      'NATIONAL',
      'SAVINGS',
      'TRUST',
      'FINANCIAL',
      'SERVICES',
      'THE',
      'AND',
      'OF',
    ],
  },
  fees: {
    enabled: true,
    // §5.8's list, verbatim.
    keywords: [
      'INTEREST CHARGE',
      'CASH ADVANCE FEE',
      'LATE FEE',
      'ANNUAL MEMBERSHIP FEE',
      'OVERDRAFT',
      'NSF',
      'RETURNED ITEM',
      'FOREIGN TRANSACTION',
      'ATM FEE',
      'MONTHLY MAINTENANCE',
      'MINIMUM BALANCE',
    ],
    excludedPhrases: ['INTEREST CHECKING', 'INTEREST EARNED'],
    disqualifyingTokens: ['REFUND', 'REVERSAL', 'CREDIT', 'WAIVED', 'ADJUSTMENT'],
    reversalWindowDays: 60,
    avoidableKeywords: ['MONTHLY MAINTENANCE', 'MINIMUM BALANCE'],
    // Twice is what makes it "recurring" rather than a one-off a waiver would not
    // have prevented.
    avoidableMinOccurrences: 2,
    keywordConfidence: 0.95,
    categoryOnlyConfidence: 0.75,
  },
  outlier: {
    enabled: true,
    merchantMinSamples: 5,
    categoryMinSamples: 15,
    zThreshold: 3.5,
    steadyMultiple: 3,
    minExcessCents: 2500,
    globalPercentile: 0.99,
    globalMinCents: 20_000,
    globalTopN: 10,
    globalMinSamples: 50,
    // Confidence rises with how far past the threshold the charge sits, so a
    // z of 12 does not present identically to a z of 3.6.
    zConfidenceBase: 0.6,
    zConfidencePerPoint: 0.05,
    zConfidenceMax: 0.9,
    // A perfectly steady charge that tripled is arithmetic, but the absence of
    // dispersion means there is no distribution vouching for it.
    steadyConfidence: 0.7,
    // "The ten largest debits in this window" is a fact about the data rather
    // than an inference from it.
    globalConfidence: 0.9,
  },
  trend: {
    enabled: true,
    trailingMonths: 3,
    spikePercent: 0.4,
    spikeExcessCents: 7500,
    climbMonths: 3,
    climbPercent: 0.25,
    climbRiseCents: 5000,
    climbMadMultiple: 2,
    seriesDominanceFraction: 0.8,
    maxSpikes: 5,
    maxClimbs: 5,
    spikeConfidence: 0.7,
    // Lower than a spike: a climb is a claim about direction over three months,
    // where a spike is a claim about one month against the three before it.
    climbConfidence: 0.6,
  },
  micro: {
    enabled: true,
    minPerMonth: 8,
    maxMedianCents: 1500,
    minMonths: 3,
    merchantDominanceFraction: 0.8,
    // §5.11 attaches no judgment and infers nothing: the finding *is* the
    // annualized arithmetic, so the only doubt is whether the merchant grouping
    // is right — which is §4's business and is what `llm_dependent` reports.
    confidence: 0.9,
  },
};

/** A partial override, as Settings would supply it. One level of nesting, which
 *  is all the config has. */
export type ConfigOverride = {
  readonly [K in keyof AnalyzerConfig]?: Partial<AnalyzerConfig[K]>;
};

export function resolveConfig(override: ConfigOverride = {}): AnalyzerConfig {
  return {
    global: { ...DEFAULT_CONFIG.global, ...override.global },
    recurrence: { ...DEFAULT_CONFIG.recurrence, ...override.recurrence },
    duplicate: { ...DEFAULT_CONFIG.duplicate, ...override.duplicate },
    priceCreep: { ...DEFAULT_CONFIG.priceCreep, ...override.priceCreep },
    trial: { ...DEFAULT_CONFIG.trial, ...override.trial },
    lapsed: { ...DEFAULT_CONFIG.lapsed, ...override.lapsed },
    transfers: { ...DEFAULT_CONFIG.transfers, ...override.transfers },
    fees: { ...DEFAULT_CONFIG.fees, ...override.fees },
    outlier: { ...DEFAULT_CONFIG.outlier, ...override.outlier },
    trend: { ...DEFAULT_CONFIG.trend, ...override.trend },
    micro: { ...DEFAULT_CONFIG.micro, ...override.micro },
  };
}

/**
 * `analysis_run.config_hash` (§3.1), and an input to every `rule_version`.
 *
 * Keys are sorted before hashing, so a config assembled in a different property
 * order hashes the same. Without that, `resolveConfig`'s spread order would be
 * part of the contract and a harmless refactor would resurface every dismissed
 * finding as "re-evaluated with an improved rule".
 */
export function configHash(config: AnalyzerConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

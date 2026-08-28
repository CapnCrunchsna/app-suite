/**
 * What each rule is called, and what it does, in words a person reads.
 *
 * ## Why this is in the UI and not on the wire
 *
 * `outlier.v1` and `trend.v1` are **rule ids** — §5.1's primary keys. They are
 * stamped on every finding so a dismissal survives a rule version change, and
 * they are exactly right for that job. They were never meant to be a heading, and
 * a page that shows them is asking the reader to learn the schema.
 *
 * The API does carry a `label` for each rule, computed by §6.8's settings route
 * for its own payload. This file deliberately does not consume it: the Findings
 * page would have to fetch eighty thresholds and two dismissal counts per rule to
 * render six section headings, and the labels would still arrive too late to
 * render the first frame. Copy is a UI concern, it changes for UI reasons, and it
 * belongs where the words are.
 *
 * ## The blurb is the whole point
 *
 * Every threshold in §5 is tunable (§7.4) and §7.6 says every one of them is
 * uncalibrated. That is a good design and it produces a Settings page with eighty
 * numbers on it, which is unusable if each number is a bare identifier. A
 * one-sentence "what this actually does" is the difference between a control panel
 * and a wall.
 *
 * Written to be read by someone looking at their own statement, so: no section
 * numbers, no rule ids, no `cadence_days`. The spec references stay in the code
 * and in the commit messages, where the people who need them are.
 */

export interface RuleCopy {
  readonly label: string;
  /** One sentence, present tense, about the user's money. */
  readonly blurb: string;
}

/**
 * Keyed by §5.1's rule id. `duplicate.v1` covers §5.4's two halves under one id —
 * they are separately toggleable but they produce findings under the same key, so
 * one heading is the honest count.
 */
export const RULE_COPY: Readonly<Record<string, RuleCopy>> = {
  'recurrence.v1': {
    label: 'Subscriptions',
    blurb: 'Charges that repeat on a rhythm — what you are subscribed to, and what it costs.',
  },
  'duplicate.v1': {
    label: 'Duplicate & overlapping services',
    blurb: 'Paying twice for one thing, or paying two services that do the same job.',
  },
  'price_creep.v1': {
    label: 'Price rises',
    blurb: 'A subscription that costs more now than when it started, and how much more per year.',
  },
  'trial.v1': {
    label: 'Trials that converted',
    blurb: 'A free or cheap trial that quietly became a full-price subscription.',
  },
  'lapsed.v1': {
    label: 'Appears cancelled',
    blurb:
      'A subscription that stopped charging — confirmation it really ended, or a warning that it did not.',
  },
  'fees.v1': {
    label: 'Fees & interest',
    blurb: 'Bank and card charges, and which of them a waiver or a different account would avoid.',
  },
  'outlier.v1': {
    label: 'Unusually large charges',
    blurb: 'Single charges far bigger than what you normally spend at that merchant.',
  },
  'trend.v1': {
    label: 'Category trends',
    blurb: 'A category of spending that jumped in one month or has climbed for three.',
  },
  'micro.v1': {
    label: 'Frequent small spending',
    blurb: 'Lots of small charges at one merchant, priced as what it adds up to in a year.',
  },
};

/** The label, or the id if a rule appears that this file has not met yet — an
 *  unfamiliar id on screen is better than a blank heading. */
export function ruleLabel(ruleId: string): string {
  return RULE_COPY[ruleId]?.label ?? ruleId;
}

export function ruleBlurb(ruleId: string): string | null {
  return RULE_COPY[ruleId]?.blurb ?? null;
}

/**
 * What a single tunable number does, keyed `section.key` as §6.8's settings
 * payload names them.
 *
 * Not exhaustive on purpose. A threshold whose name already says it —
 * `minOccurrences`, `enabled` — gains nothing from a sentence repeating it, and a
 * tooltip on every control is a tooltip nobody reads. These are the ones whose
 * effect is not guessable from the name, which is most of the ones that matter.
 */
export const THRESHOLD_COPY: Readonly<Record<string, string>> = {
  'global.minAnnualImpactCents':
    'Hide any finding worth less than this per year. The single biggest control over how much noise you see.',
  'global.maxFindingsPerRule': 'Never show more than this many findings from one rule at a time.',
  'global.llmDependentConfidenceCap':
    'Ceiling on confidence for anything resting on an AI-suggested merchant grouping.',

  'recurrence.amountTolerancePercent':
    'How much two charges may differ and still count as the same price.',
  'recurrence.amountToleranceFloorCents':
    'The same allowance in cash, so small subscriptions are not split by rounding.',
  'recurrence.minOccurrences': 'How many charges before a repeating pattern counts as a subscription.',
  'recurrence.maxCyclesPerDelta':
    'How many billing cycles may be missing before a gap breaks the pattern — covers statements you have not imported.',
  'recurrence.priceStepMaxAmountRatio':
    'How far a price may jump and still be the same subscription rather than a different charge.',
  'recurrence.feePlateauShare':
    'How much of a subscription must sit on a repeated exact amount. Lower it to catch bills that vary; raise it to cut phantom subscriptions out of ordinary shopping.',
  'recurrence.livenessCadenceMultiple':
    'How long a subscription may go quiet before it stops counting as active.',
  'recurrence.amountStabilityCvCeiling':
    'How much the amount may wobble before confidence starts dropping.',
  'recurrence.annualPairMinDays':
    'Two charges at least this far apart can be an annual subscription on their own.',
  'recurrence.annualPairMaxDays': 'And no further apart than this.',

  'priceCreep.minStepDeltaCents': 'Ignore price changes smaller than this.',
  'priceCreep.minAnnualisedDeltaCents':
    'And ignore them unless they add up to at least this much over a year.',

  'lapsed.cadenceMultiple':
    'How many missed billing cycles before a subscription is called cancelled.',

  'outlier.zThreshold':
    'How far above normal a charge must be to be flagged. Higher means fewer, more extreme.',
  'outlier.minExcessCents':
    'And it must be at least this much above normal in cash — stops a $9 coffee being flagged as unusual.',
  'outlier.merchantMinSamples':
    'How many charges at a merchant before there is enough history to call one unusual.',

  'trend.spikePercent': 'How much a category must jump in one month to count as a spike.',
  'trend.spikeExcessCents': 'And by at least this much in cash.',
  'trend.climbPercent': 'How much a category must rise across three months to count as a climb.',

  'micro.minPerMonth': 'How many charges a month at one merchant before it counts as a habit.',
  'micro.maxMedianCents': 'And how small each has to be.',

  'fees.reversalWindowDays': 'A fee refunded within this many days is treated as never charged.',
  'fees.avoidableMinOccurrences':
    'How many times a fee must recur before it is called avoidable rather than a one-off.',

  'trial.authorizationMaxCents':
    'A charge this small before a real one looks like a card-validation test, which is how trials usually start.',
  'trial.earlyWindowDays':
    'A first charge this soon after your earliest statement cannot be told from a subscription you already had, so confidence is halved.',
};

export function thresholdBlurb(section: string, key: string): string | null {
  return THRESHOLD_COPY[`${section}.${key}`] ?? null;
}

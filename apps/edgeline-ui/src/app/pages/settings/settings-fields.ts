/**
 * §3.2's twenty-six keys as data, grouped the way §11.1 asks for them:
 * Staking, Thresholds, Polling, Safety.
 *
 * A table rather than twenty-six hand-written form rows, for one reason that is
 * worth more than the brevity: §3.2 is the list, and Phase 3's exit is "every
 * §3.2 setting editable in UI". A page built by hand goes out of step with the
 * spec the first time a key is added and nobody notices, because a missing input
 * looks like nothing at all. `settings-page.spec.ts` asserts this table against
 * the key set, so a new §3.2 key fails a test rather than quietly going
 * un-editable.
 *
 * Every `hint` is §3.2's own "meaning" column, sometimes with the consequence
 * spelled out — these are guardrails, and a number you can change without
 * knowing what it protects is a guardrail you will change.
 */

import type { Settings } from '@metrum/edgeline-api-client';

export type SettingKey = keyof Settings & string;

/**
 * How a value is edited, which is not always how it is stored.
 *
 * - `cents` is §1's integer cents shown and typed as dollars. The conversion is
 *   the only one in the page and it lives in `formatting.ts`.
 * - `list` is a `string[]` edited as comma-separated text; `json` is
 *   `consensus_weights`, the one setting with real structure.
 */
export type FieldKind = 'number' | 'cents' | 'select' | 'list' | 'json' | 'bool';

export interface FieldSpec {
  readonly key: SettingKey;
  readonly label: string;
  readonly kind: FieldKind;
  readonly hint: string;
  readonly step?: number;
  readonly min?: number;
  readonly options?: readonly string[];
  /** Rendered after the input — `%`, `s`, `credits`. Units that are in the key
   *  name are not in the label, so the key stays greppable against §3.2. */
  readonly unit?: string;
}

export interface FieldGroup {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly fields: readonly FieldSpec[];
}

export const STAKING: FieldGroup = {
  id: 'staking',
  title: 'Staking',
  blurb:
    '§6.7 sizes a bet from Kelly and then walks it down through every cap below, in order. ' +
    'Raising any of these raises the most you can lose on one mistake.',
  fields: [
    {
      key: 'kelly_fraction',
      label: 'Kelly fraction',
      kind: 'number',
      step: 0.01,
      min: 0,
      hint: 'Fraction of full Kelly. Full Kelly (1.0) maximises long-run growth and is far too volatile to live with; 0.25 is the default for a reason.',
    },
    {
      key: 'bankroll_start_cents',
      label: 'Starting bankroll',
      kind: 'cents',
      min: 0,
      hint: 'What the ledger counts from. Stake caps expressed as a percentage are measured against the current bankroll, not this.',
    },
    {
      key: 'max_stake_cents',
      label: 'Max stake per bet',
      kind: 'cents',
      min: 0,
      hint: 'Hard cap in money. Whichever of this and the percentage cap is smaller wins.',
    },
    {
      key: 'max_stake_pct',
      label: 'Max stake',
      kind: 'number',
      step: 0.1,
      min: 0,
      unit: '% of bankroll',
      hint: 'Hard cap as a share of the current bankroll.',
    },
    {
      key: 'stake_rounding_cents',
      label: 'Stake rounding',
      kind: 'cents',
      min: 0,
      hint: 'Recommended stakes are rounded to this. Arb splits are re-checked after rounding, which is what stops a rounded pair from losing its profit.',
    },
    {
      key: 'daily_exposure_cap_cents',
      label: 'Daily exposure cap',
      kind: 'cents',
      min: 0,
      hint: 'Sum of stakes recommended in a day. Reached, and nothing further is recommended until tomorrow.',
    },
    {
      key: 'daily_loss_stop_cents',
      label: 'Daily loss stop',
      kind: 'cents',
      min: 0,
      hint: 'Graded losses today at or over this engage the kill switch automatically (§12). It is the one guardrail that acts on its own.',
    },
  ],
};

export const THRESHOLDS: FieldGroup = {
  id: 'thresholds',
  title: 'Thresholds',
  blurb:
    'What counts as an opportunity at all (§6.4, §6.5). Lowering these does not find more ' +
    'edges — it lowers the bar for calling noise an edge.',
  fields: [
    {
      key: 'ev_threshold_pct',
      label: 'EV threshold',
      kind: 'number',
      step: 0.1,
      unit: '%',
      hint: 'Minimum expected value before an opportunity is alerted.',
    },
    {
      key: 'min_edge_to_bet_pct',
      label: 'Minimum edge to bet',
      kind: 'number',
      step: 0.1,
      unit: '%',
      hint: 'Below this the opportunity is still logged and still shows on Opportunities — it is simply not worth telling you about.',
    },
    {
      key: 'min_books_for_consensus',
      label: 'Books needed for consensus',
      kind: 'number',
      step: 1,
      min: 1,
      hint: 'A market quoted by fewer books than this never alerts. Lowering it makes the consensus price worse, which makes every EV figure derived from it worse.',
    },
    {
      key: 'arb_min_profit_pct',
      label: 'Minimum arb profit',
      kind: 'number',
      step: 0.1,
      unit: '%',
      hint: 'Measured after stake rounding, so it is the profit you would actually collect.',
    },
    {
      key: 'devig_method',
      label: 'De-vig method',
      kind: 'select',
      options: ['multiplicative', 'additive', 'power', 'shin'],
      hint: 'How the bookmaker margin is removed before probabilities are compared (§6.2).',
    },
    {
      key: 'consensus_weights',
      label: 'Consensus weights',
      kind: 'json',
      hint: 'Per-book integer weights, as JSON — e.g. {"default": 1, "pinnacle": 3}. A sharper book earns a heavier vote.',
    },
    {
      key: 'staleness_sigma_floor',
      label: 'Staleness σ floor',
      kind: 'number',
      step: 0.0001,
      min: 0,
      hint: 'Floor on the standard deviation used by §6.6, so a market where every book agrees does not divide by nearly zero.',
    },
  ],
};

export const POLLING: FieldGroup = {
  id: 'polling',
  title: 'Polling',
  blurb:
    'What is polled, how often, and how often you are told about it. Cadence spends provider ' +
    'credits — §8.4 checks the projected monthly cost against the budget below at startup.',
  fields: [
    {
      key: 'sports_enabled',
      label: 'Sports enabled',
      kind: 'list',
      hint: 'The Odds API sport keys, comma-separated. NFL and NBA are configuration, not code.',
    },
    {
      key: 'markets_featured',
      label: 'Featured markets',
      kind: 'list',
      hint: 'Polled every cycle — h2h, spreads, totals.',
    },
    {
      key: 'markets_props',
      label: 'Prop markets',
      kind: 'list',
      hint: 'Polled on their own cadence, and only for events starting soon (§8.4).',
    },
    {
      key: 'poll_interval_s',
      label: 'Poll interval',
      kind: 'number',
      step: 1,
      min: 1,
      unit: 's',
      hint: 'Featured-markets cycle, production cadence.',
    },
    {
      key: 'poll_interval_dev_s',
      label: 'Poll interval (dev)',
      kind: 'number',
      step: 1,
      min: 1,
      unit: 's',
      hint: 'Free-tier cadence — the default of 21600 is four polls a day.',
    },
    {
      key: 'props_poll_interval_s',
      label: 'Props poll interval',
      kind: 'number',
      step: 1,
      min: 1,
      unit: 's',
      hint: 'Props only, and only within six hours of the event.',
    },
    {
      key: 'closing_capture_offset_s',
      label: 'Closing capture offset',
      kind: 'number',
      step: 1,
      min: 0,
      unit: 's before start',
      hint: 'Forces a snapshot this far before start time. This is what CLV is measured against — while paper mode is on, it is the only number carrying information about whether the detector works.',
    },
    {
      key: 'alert_cooldown_s',
      label: 'Alert cooldown',
      kind: 'number',
      step: 1,
      min: 0,
      unit: 's',
      hint: 'Per market key. Stops one drifting line from becoming twenty messages.',
    },
    {
      key: 'edge_improve_delta_pct',
      label: 'Re-alert when edge grows by',
      kind: 'number',
      step: 0.1,
      unit: '%',
      hint: 'Inside the cooldown, the same opportunity is re-alerted only if its edge grew at least this much (§7.4).',
    },
    {
      key: 'quota_monthly_budget',
      label: 'Monthly quota budget',
      kind: 'number',
      step: 1,
      min: 0,
      unit: 'credits',
      hint: 'Provider credits per month. The scheduler refuses to start a cadence projected to exceed it.',
    },
  ],
};

/**
 * §11.1's fourth group. Both keys here are guardrails, and both are exposed
 * under their own confirmation on the page — see `settings-page.ts`.
 */
export const SAFETY: FieldGroup = {
  id: 'safety',
  title: 'Safety',
  blurb:
    'The two flags that decide whether any of the above reaches you, and in what form. ' +
    'Neither is a casual toggle.',
  fields: [
    {
      key: 'paper_mode',
      label: 'Paper mode',
      kind: 'bool',
      hint: 'On: recommendations are recorded and alerted, flagged PAPER. Off: they are live-money advice. §15 expects a reviewed CLV report over at least 200 paper recommendations before this is turned off.',
    },
    {
      key: 'kill_switch',
      label: 'Kill switch',
      kind: 'bool',
      hint: 'On: polling continues and opportunities keep being recorded, but nothing is alerted. §12 engages this by itself when the daily loss stop is hit.',
    },
  ],
};

/** The three groups edited together, with one Save. */
export const EDITABLE_GROUPS: readonly FieldGroup[] = [STAKING, THRESHOLDS, POLLING];

/** All four, for the completeness check against §3.2. */
export const ALL_GROUPS: readonly FieldGroup[] = [STAKING, THRESHOLDS, POLLING, SAFETY];

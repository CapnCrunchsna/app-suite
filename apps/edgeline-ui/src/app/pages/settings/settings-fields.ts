/**
 * §3.2's keys as data, grouped the way §11.1 asks for them: Staking,
 * Thresholds, Polling, Safety. Thirty-three of them as of 2026-10-01.
 *
 * A table rather than twenty-seven hand-written form rows, for one reason worth
 * more than the brevity: §3.2 is the list, Phase 3's exit is "every §3.2 setting
 * editable in UI", and a page built by hand goes out of step the first time a
 * key is added — silently, because a missing input looks like nothing at all.
 * The exhaustiveness check at the bottom of this file is what makes that a
 * compile error instead.
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
 *   the only one in the page and it lives in `@metrum/ui`'s `format.ts`.
 * - `list` is a `string[]` edited as comma-separated text; `json` is
 *   `consensus_weights`, the one setting with real structure.
 */
/** `text` is a plain string setting, added 2026-09-12 for `book_state`. It needs
 *  no case anywhere: the template's `@default` already renders a text input and
 *  both converters fall through to `String`. It exists so a scalar string is
 *  declared rather than arriving as an unlabelled default.
 *
 *  `schedule` is `poll_schedule`, added 2026-09-23: rows of sport, weekdays and
 *  an Eastern time, edited by `PollScheduleEditor` rather than as text. */
export type FieldKind =
  | 'number'
  | 'cents'
  | 'select'
  | 'list'
  | 'json'
  | 'bool'
  | 'text'
  | 'schedule';

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

export const STAKING = {
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
} as const satisfies FieldGroup;

export const THRESHOLDS = {
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
} as const satisfies FieldGroup;

export const POLLING = {
  id: 'polling',
  title: 'Polling',
  blurb:
    'What is polled, how often, and how often you are told about it. Cadence spends provider ' +
    'credits — §8.4 checks the projected monthly cost against the budget below at startup.',
  fields: [
    {
      key: 'poll_schedule',
      label: 'Weekly poll plan',
      kind: 'schedule',
      hint: 'When the worker buys odds on the free tier: fixed US Eastern times, per sport and weekday, whatever this computer’s zone. Each poll costs one sport’s markets × regions credits — or markets × one per ten named books — and the worker refuses to start a plan projected over the monthly budget. A sport with nothing listed in the lookahead window costs nothing. Empty, the dev poll interval takes over. Takes effect when the worker restarts.',
    },
    {
      key: 'sports_enabled',
      label: 'Sports enabled',
      kind: 'list',
      hint: 'The Odds API sport keys, comma-separated. What the dev interval polls when the weekly plan is empty, and what Poll now buys on a day the plan has nothing. NFL and NBA are configuration, not code.',
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
      key: 'regions',
      label: 'Provider regions',
      kind: 'list',
      hint: 'The Odds API region buckets to request, comma-separated. Each one multiplies the credit cost of every poll they are used for and the §13 budget guard counts them — `us` alone returns only four MD-legal books, one short of what a consensus needs, which is why the default is `us, us2` (§8.4). Closing snapshots always use them; featured polls only when books are not named below.',
    },
    {
      key: 'poll_bookmakers',
      label: 'Featured polls ask for',
      kind: 'select',
      options: ['enabled', 'regions'],
      hint: 'Enabled names the enabled sportsbooks instead of requesting regions: every ten named bill as one region, so ten books cost half of us + us2, and detection only ever reads enabled books anyway (measured 2026-09-30: the same seven Maryland books on all 65 NCAAF games either way). With no book enabled a poll falls back to regions. Prices stored from polls then come from those books alone, which is what grading falls back on for a game with no closing snapshot.',
    },
    {
      key: 'poll_lookahead_h',
      label: 'Poll lookahead',
      kind: 'number',
      step: 1,
      min: 0,
      unit: 'h',
      hint: 'A featured poll asks only for games starting within this many hours. A poll with no game in the window costs nothing — the NBA is free until the window reaches its opener — and nothing is recommended months out. 96 covers the default plan’s longest gap between two polls of one sport (Friday’s NHL to Monday’s puck drops). 0 asks for every game listed.',
    },
    {
      key: 'book_state',
      label: 'Book state',
      kind: 'text',
      hint: 'Two-letter state code, lower case. Several books return deep links containing a literal {state} — BetMGM and betPARX both do — and this is what fills it. Getting it wrong does not fail loudly; it sends you to another state’s version of the same sportsbook.',
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
      hint: 'Free-tier fallback, used only when the weekly plan is empty — the default of 43200 is two polls a day at whatever times the worker started, which is what the plan replaced on 2026-09-23.',
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
      hint: 'How far before start time a bought closing snapshot is taken. Only used when closing capture is not off.',
    },
    {
      key: 'closing_capture_mode',
      label: 'Closing capture',
      kind: 'select',
      options: ['off', 'recommended', 'opportunities', 'all'],
      hint: 'Whether to spend credits buying closing lines. Off buys none and measures CLV against the last price already stored before kickoff — free, but up to a poll interval stale, and circular when that is the very poll that found the edge. Recommended buys one for games with an alerted opportunity, in every market. Opportunities buys one for every game with an opportunity of any status, in only the markets they are in — the games CLV is measured on for every opportunity, at ~155 credits/month on the week to 2026-10-01. All buys one per game in the window: 1,188 credits/month, measured, against a 500 budget. The worker counts the chosen mode in its budget.',
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
      hint: 'An opportunity already alerted is alerted again only once its edge is at least this much better than when it was last alerted — not than at the last poll, against which an edge that dipped and recovered could re-alert an unchanged price (§7.4).',
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
} as const satisfies FieldGroup;

/**
 * §11.1's fourth group. Every key here is a guardrail, and each is exposed
 * under its own confirmation on the page — see `settings-page.ts`.
 */
export const SAFETY = {
  id: 'safety',
  title: 'Safety',
  blurb:
    'The flags that decide whether any of the above reaches you, in what form, and whether ' +
    'the engine spends anything to find it. None is a casual toggle.',
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
    {
      key: 'offline_mode',
      label: 'Offline mode',
      kind: 'bool',
      hint: 'On: no provider request is made by any job, and everything else keeps running on stored data — the worker stays up, this UI stays usable, grading and the opportunity lifecycle carry on. The mirror of the kill switch, and what lets work continue when the month’s credits are spent. Nothing new is ingested while it is on, including closing lines, which cannot be recovered afterwards.',
    },
  ],
} as const satisfies FieldGroup;

/** The three groups edited together, with one Save. */
export const EDITABLE_GROUPS: readonly FieldGroup[] = [STAKING, THRESHOLDS, POLLING];

/** All four. Deliberately not annotated `readonly FieldGroup[]` — the literal
 *  key types are what the exhaustiveness check below reads, and an annotation
 *  would widen them back to `SettingKey` and make the check vacuous. */
export const ALL_GROUPS = [STAKING, THRESHOLDS, POLLING, SAFETY] as const;

/**
 * Phase 3's exit is "every §3.2 setting editable in UI". This is what makes that
 * true rather than merely claimed.
 *
 * The check runs against **`Settings` from the generated client** — emitted from
 * the engine's `openapi.json`, emitted in turn from `config.py` — so the chain
 * runs from §3.2's real key set to this table with nothing hand-maintained in
 * between. Add a key to §3.2 and forget the form, and `npm run check` fails to
 * compile here with the key's own name in the error.
 *
 * A type-level check rather than a spec, on purpose. The obvious version — a
 * test comparing this table against a literal list of §3.2's keys — compares two
 * things the same author wrote at the same time and is blind to the API moving.
 * That version existed first and proved the point by staying green when
 * `regions` was added on 2026-09-09.
 */
type CoveredKey = (typeof ALL_GROUPS)[number]['fields'][number]['key'];

/** A §3.2 key with no field in any group. Must be `never`. */
type MissingField = Exclude<SettingKey, CoveredKey>;
/** A field bound to a key §3.2 does not have. The API rejects an unknown key,
 *  so the control would look like it saved and change nothing. Must be `never`. */
type UnknownField = Exclude<CoveredKey, SettingKey>;

// If either stops compiling, the offending key names itself in the error.
const _everySettingIsEditable: MissingField extends never ? true : MissingField = true;
const _everyFieldIsASetting: UnknownField extends never ? true : UnknownField = true;
void _everySettingIsEditable;
void _everyFieldIsASetting;

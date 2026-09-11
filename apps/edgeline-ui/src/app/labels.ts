/**
 * Provider keys turned into words a reader can act on.
 *
 * Everything the engine stores is keyed the way the provider names it —
 * `h2h`, `baseball_mlb`, `batter_home_runs` — because §7.2 normalizes *values*
 * and deliberately does not rewrite the keys those values are filed under. That
 * is right for the datastore and wrong for a screen: a table that says `h2h` is
 * asking the reader to already know the answer, and the one person this app is
 * for has said plainly that they do not.
 *
 * ## Why a map with a fallback and not a lookup table alone
 *
 * The provider adds markets faster than this app will. An unmapped key must
 * still render as *something* legible, so the fallback un-snake-cases and
 * capitalises: `batter_home_runs` → `Batter home runs`. That is not as good as a
 * real label, but it is never worse than the raw key, and it means a new market
 * appearing in a response is a slightly plain row rather than a mystery.
 *
 * ## Why this is not in `@metrum/ui`
 *
 * Same argument `formatting.ts` makes for American odds: putting sports-betting
 * vocabulary in the shared lib would be exporting it to a statement analyser.
 */

import type { EventRow } from '@metrum/edgeline-api-client';

/** §3.2's `markets_featured`, plus the prop markets the default config names. */
const MARKET_LABELS: Readonly<Record<string, string>> = {
  h2h: 'Moneyline',
  spreads: 'Spread',
  totals: 'Total',
  outrights: 'Outright',
  batter_home_runs: 'Batter home runs',
  pitcher_strikeouts: 'Pitcher strikeouts',
};

/** The provider's sport keys. Abbreviations because that is what a league is
 *  actually called — "MLB", not "Baseball MLB". */
const SPORT_LABELS: Readonly<Record<string, string>> = {
  baseball_mlb: 'MLB',
  basketball_nba: 'NBA',
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  icehockey_nhl: 'NHL',
  soccer_epl: 'EPL',
};

/** §4.3's opportunity `type`. Both are initialisms and both stay upper-case;
 *  "Ev" would read as a word. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  ev: 'EV',
  arb: 'ARB',
};

/** `some_provider_key` → `Some provider key`. The floor every label falls back
 *  to, so an unmapped key is plain rather than raw. */
export function humanise(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

export function marketLabel(key: string | null | undefined): string {
  if (!key) return '—';
  return MARKET_LABELS[key] ?? humanise(key);
}

export function sportLabel(key: string | null | undefined): string {
  if (!key) return '—';
  return SPORT_LABELS[key] ?? humanise(key);
}

export function typeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return TYPE_LABELS[type] ?? type.toUpperCase();
}

/** §4.3's status enum — `open`, `alerted`, `closed`, `expired` — as a word. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return humanise(status);
}

/**
 * `Kansas City Royals @ Cleveland Guardians`.
 *
 * Away-at-home, which is the order every North American book and scoreboard
 * prints. Getting it backwards would not look like a bug, it would look like a
 * different game, so the field names are read explicitly rather than joined in
 * whatever order the object happens to carry.
 */
export function matchup(event: EventRow | null | undefined): string {
  if (!event) return '';
  return `${event.away_team} @ ${event.home_team}`;
}

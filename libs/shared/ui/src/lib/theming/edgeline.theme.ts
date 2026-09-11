/**
 * Edgeline's own palette — the app's default, registered at bootstrap.
 *
 * ## What it is a theme *of*
 *
 * A trading screen at night. Edgeline is the one app in this suite whose content
 * is *live* — prices that move, a worker that either has a pulse or does not, an
 * edge that decays while you read it — and the two other themes are both themes
 * of documents. Ledgerline is ink on ledger paper; Metrum is the workspace's own
 * teal. Neither has a register for "this number is changing".
 *
 * - **Dark is the terminal.** A neutral graphite ground (`#13161c`), deliberately
 *   not teal-black and not navy: those are the other two, and a glance at the
 *   wrong tab should be immediately obvious.
 * - **Light is newsprint under a desk lamp.** A cool grey-slate (`#eef0f4`)
 *   rather than white, so the amber still reads as a signal rather than as
 *   highlighter on a blank page.
 *
 * ## Why amber, and what it cost
 *
 * `--accent` is amber (`#f0a33c`) and `--accent2` is ember (`#ff8c55`): the
 * colours of a lit indicator, and the one hue family neither sibling theme uses.
 * Against a cool graphite ground they read as *attention* without reading as
 * *alarm*, which is the exact register this app needs — it is trying to get a
 * number in front of someone who is about to risk money, while never implying
 * urgency the market has not actually produced.
 *
 * The cost is real and worth naming: amber is conventionally the *caution*
 * colour, and here the brand has taken it. So the warning family had to move out
 * of the way rather than sit next to the accent —
 *
 * - `--warn` is a lighter, yellower gold (`#ffd166`) that separates from the
 *   accent on saturation and lightness, the same trick the house theme already
 *   plays between its `warn` and its muted `caution` tan.
 * - `--danger` moved off coral, which every other theme here uses, and onto a
 *   rose-crimson (`#e8677a`). Coral beside an ember accent is two oranges, and
 *   the one place this app must never be ambiguous is the difference between
 *   "notice this" and "this failed".
 *
 * ## Why not the house teal, which §11.2 originally named
 *
 * §11.2 asked for "accent teal `#2dd4bf`, emerald `#34d399`" — which *is*
 * `METRUM_THEME`, so this app registered the house theme and its switcher had a
 * single entry and hid itself. That made Edgeline visually indistinguishable
 * from the workspace dashboard. §11.2 was amended on 2026-09-11 to record that
 * each app in the suite carries its own identity and offers the others; this
 * file is that decision.
 *
 * Every foreground/background pair is checked against WCAG in `theming.spec.ts`,
 * which audits every theme this lib ships. The light half is not an inversion:
 * `#f0a33c` on white is 1.9:1 and unusable, which is why the light accent is a
 * burnt amber (`#95560a`) rather than the dark one on a pale ground.
 */

import type { Theme } from './theme.js';

export const EDGELINE_THEME: Theme = {
  id: 'edgeline',
  label: 'Edgeline',
  note: 'Amber on a night terminal',
  radius: '10px',

  dark: {
    bg: '#13161c',
    surface: '#1a1e26',
    surface1: '#171a21',
    surface2: '#242934',
    border: '#353c4a',
    text: '#e9ecf3',
    textDim: '#9ba4b4',
    accent: '#f0a33c',
    accent2: '#ff8c55',
    onAccent: '#24180a',
    warn: '#ffd166',
    danger: '#e8677a',
    dangerSoft: '#f49aa8',
    caution: '#b4924f',
    cautionSoft: '#d9bb7c',
    ai: '#8b7fd4',
    aiSoft: '#b3a8ee',
    shadow: '0 1px 3px rgb(0 0 0 / 55%)',
  },

  light: {
    bg: '#eef0f4',
    surface: '#ffffff',
    surface1: '#f8f9fb',
    surface2: '#e2e6ec',
    border: '#c2c9d4',
    text: '#161a21',
    textDim: '#4d5665',
    accent: '#95560a',
    accent2: '#a83f17',
    onAccent: '#ffffff',
    warn: '#8a5a06',
    danger: '#b23046',
    dangerSoft: '#96233a',
    caution: '#8a6a12',
    cautionSoft: '#6b520c',
    // The text colour at low alpha rather than black — a black drop shadow under
    // a white card on a grey page reads as dirt, not as depth.
    shadow: '0 1px 3px rgb(22 26 33 / 12%)',
    ai: '#5546b8',
    aiSoft: '#463a9c',
  },
};

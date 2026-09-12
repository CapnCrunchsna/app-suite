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
 * - **Dark is the terminal.** A charcoal ground with a violet cast (`#151320`),
 *   deliberately not teal-black and not navy: those are the other two, and a
 *   glance at the wrong tab should be immediately obvious.
 * - **Light is paper under a desk lamp.** A faintly violet grey (`#f1eff7`)
 *   rather than white, so the accent reads as ink rather than as highlighter.
 *
 * ## Why violet, after amber did not work
 *
 * This palette was amber on graphite for a day. It looked good and it was
 * wrong, for a reason worth recording so nobody tries it again: **amber is the
 * warning colour, and a brand cannot have it.** With the accent at `#f0a33c`
 * every caution in the app had to move out of the brand's way — `warn` went to a
 * lighter gold that read as decoration, and `danger` was pushed off coral onto a
 * rose-crimson to avoid being a second orange. The net effect was an interface
 * where the things asking for attention were the least distinguishable, because
 * they were all competing with the chrome.
 *
 * Violet takes none of those. `--accent` is `#a78bfa` and `--accent2` is a
 * magenta `#f472b6`, both far from every signal hue, which lets the warning
 * family go back to what it should have been all along: `warn` is the house
 * amber `#f0b429`, `danger` is coral, `caution` is the muted tan. Those three
 * are now the only warm colours on the screen, so warmth *means* something.
 *
 * The one token violet displaced is `--ai`. §4.2 wants AI-assisted marks in a
 * distinct hue "so provenance is never inferred from tone alone", and the other
 * two themes use a violet for it — which is now the brand. So `--ai` moves to a
 * teal-green here. It is the same argument in the other direction, and it is why
 * the audit checks the whole palette rather than each colour on its own.
 *
 * ## Why not the house teal, which §11.2 originally named
 *
 * §11.2 asked for "accent teal `#2dd4bf`, emerald `#34d399`" — which *is*
 * `METRUM_THEME`, so this app registered the house theme and its switcher had a
 * single entry and hid itself. That made Edgeline visually indistinguishable
 * from the workspace dashboard. §11.2 was amended on 2026-09-11 to record that
 * each app in the suite carries its own identity and offers the others.
 *
 * Every foreground/background pair is checked against WCAG in `theming.spec.ts`,
 * which audits every theme this lib ships. The light half is not an inversion:
 * `#a78bfa` on white is 2.3:1 and unusable, which is why the light accent is a
 * deeper violet (`#6d28d9`) rather than the dark one on a pale ground.
 */

import type { Theme } from './theme.js';

export const EDGELINE_THEME: Theme = {
  id: 'edgeline',
  label: 'Edgeline',
  note: 'Violet on a night terminal',
  radius: '10px',

  dark: {
    bg: '#151320',
    surface: '#1d1a2b',
    surface1: '#191627',
    surface2: '#282338',
    border: '#3a3450',
    text: '#eae8f5',
    textDim: '#a29cba',
    accent: '#a78bfa',
    accent2: '#f472b6',
    onAccent: '#1a1033',
    warn: '#f0b429',
    danger: '#e0796a',
    dangerSoft: '#eda596',
    caution: '#b08b4f',
    cautionSoft: '#d9b878',
    ai: '#4ec9a5',
    aiSoft: '#7fe0c0',
    shadow: '0 1px 3px rgb(0 0 0 / 55%)',
  },

  light: {
    bg: '#f1eff7',
    surface: '#ffffff',
    surface1: '#faf9fd',
    surface2: '#e5e1ef',
    border: '#c7c1d8',
    text: '#1a1726',
    textDim: '#544d68',
    accent: '#6d28d9',
    accent2: '#a61e69',
    onAccent: '#ffffff',
    warn: '#8a5a06',
    danger: '#a83a26',
    dangerSoft: '#8c2e1c',
    caution: '#8a6a12',
    cautionSoft: '#6b520c',
    ai: '#0f766e',
    aiSoft: '#0b5c55',
    // The text colour at low alpha rather than black — a black drop shadow under
    // a white card on a tinted page reads as dirt, not as depth.
    shadow: '0 1px 3px rgb(26 23 38 / 12%)',
  },
};

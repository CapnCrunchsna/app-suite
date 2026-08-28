/**
 * Ledgerline's own palette — the app's default, registered at bootstrap.
 *
 * ## What it is a theme *of*
 *
 * A ledger. Not "finance" in the abstract — the specific physical object this app
 * replaces: a ruled statement, ink on paper, with the money in a column down the
 * right. That gives the two modes something to actually be, rather than one being
 * the other turned inside out:
 *
 * - **Dark is ink.** A deep navy ground (`#0b1220`) rather than the house
 *   theme's teal-black. Statements are printed in blue-black ink and the colour
 *   carries the association without being literal.
 * - **Light is the paper.** Warm cream (`#f4f1e8`), not white. Ledger stock is
 *   never white, white panels on a white page lose every edge, and a screen of
 *   figures read for half an hour is easier on cream.
 *
 * ## Why the accent is green and the second accent is gold
 *
 * `--accent` is the app's primary — links, focus, the active section — and it is
 * banknote green (`#46d492`). Green is the one colour that already means *money
 * you still have* to everyone who has looked at a bank statement, and the whole
 * app is an argument about how much of it is leaving.
 *
 * `--accent2` is gold (`#d9ae4a`), and it is the more considered of the two.
 * Every existing use of that token is a figure or a chip that wants a second look
 * — §6.4's flagged annual savings, and §6.8's header indicator when the LLM
 * provider is remote. In the house theme it is a green sibling of the teal
 * accent, which makes the headline number blend into the chrome. Gold separates
 * it, reads as money in its own right, and is the right temperature for a chip
 * that means "notice this" without meaning "something is wrong" — `--danger` and
 * `--warn` already own that register.
 *
 * ## Why not just re-use the house teal
 *
 * The teal palette is good and Ledgerline shipped on it for weeks. But a theme
 * switcher whose two entries are near-identical demonstrates nothing, and an app
 * that looks exactly like the workspace dashboard has no identity of its own to
 * return to. Metrum stays in the list, one selection away, and is still what the
 * dashboard and the artifact template look like.
 *
 * Every foreground/background pair here is checked against WCAG in
 * `ledgerline.theme.spec.ts`, using the same `auditTheme` the shared lib runs
 * over its own themes. The light half in particular is not eyeballed: `#46d492`
 * on cream is 2.1:1 and unusable, which is why the light accent is a different
 * green (`#0d6f47`) rather than the dark one on a pale ground.
 */

import type { Theme } from '@metrum/ui';

export const LEDGERLINE_THEME: Theme = {
  id: 'ledgerline',
  label: 'Ledgerline',
  note: 'Ink and ledger paper',
  radius: '10px',

  dark: {
    bg: '#0b1220',
    surface: '#121b2c',
    surface1: '#0f1726',
    surface2: '#1b2941',
    border: '#2c3d5c',
    text: '#e7eef8',
    textDim: '#94a6c2',
    accent: '#46d492',
    accent2: '#d9ae4a',
    onAccent: '#06180f',
    warn: '#f0b429',
    danger: '#e8806e',
    dangerSoft: '#f2a897',
    caution: '#b08b4f',
    cautionSoft: '#dcbb7c',
    ai: '#8b8fe0',
    aiSoft: '#b0b3f0',
    shadow: '0 1px 3px rgb(0 0 0 / 55%)',
  },

  light: {
    bg: '#f4f1e8',
    surface: '#fffdf7',
    surface1: '#faf7ee',
    surface2: '#e9e4d5',
    border: '#cdc6b1',
    text: '#1a2334',
    textDim: '#586176',
    accent: '#0d6f47',
    accent2: '#7a5c0a',
    onAccent: '#ffffff',
    warn: '#8a5a06',
    danger: '#ad3823',
    dangerSoft: '#8f2c1a',
    caution: '#7a5c0a',
    cautionSoft: '#634a06',
    ai: '#5044b4',
    aiSoft: '#413698',
    // The text colour at low alpha, not black. Black ink under a cream card is a
    // stain; this is the shadow the paper itself would cast.
    shadow: '0 1px 3px rgb(26 35 52 / 13%)',
  },
};

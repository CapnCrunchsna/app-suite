/**
 * The house theme — MetrumDigital's own palette, available in every app.
 *
 * The dark half is the workspace look verbatim: the same teal-on-near-black the
 * artifact template and `dashboard.html` use, so an app and the dashboard that
 * links to it read as one place. It is not re-derived here, it is transcribed,
 * and the values below are the ones `apps/ledgerline-ui/src/styles.scss` has been
 * shipping since the workspace was bootstrapped.
 *
 * The light half is new and is a design pass rather than an inversion. Two
 * decisions worth naming:
 *
 * - **`accent` is not the dark theme's teal.** `#2dd4bf` on white is 1.9:1 —
 *   invisible. The light accent is the same hue driven down to `#08736a`, which
 *   clears 5.7:1 on `surface` and still reads as the house teal rather than as a
 *   generic dark green.
 * - **The ground is tinted, not white.** `#eef4f3` keeps the teal cast that makes
 *   the dark theme recognisable, and stops a screen of white panels on a white
 *   page from losing all its structure.
 *
 * Every pair is checked in `theming.spec.ts` — see `contrast.ts` for the
 * thresholds and why each one is what it is.
 */

import type { Theme } from './theme.js';

export const METRUM_THEME: Theme = {
  id: 'metrum',
  label: 'Metrum Digital',
  note: 'The workspace house style',
  radius: '10px',

  dark: {
    bg: '#0a1517',
    surface: '#0f2124',
    surface1: '#0e2427',
    surface2: '#143034',
    border: '#1f4a47',
    text: '#dcefeb',
    textDim: '#7ea8a1',
    accent: '#2dd4bf',
    accent2: '#34d399',
    onAccent: '#06201c',
    warn: '#f0b429',
    danger: '#e0796a',
    dangerSoft: '#eda596',
    caution: '#b08b4f',
    cautionSoft: '#d9b878',
    ai: '#8b7fd4',
    aiSoft: '#b3a8ee',
    shadow: '0 1px 3px rgb(0 0 0 / 50%)',
  },

  light: {
    bg: '#eef4f3',
    surface: '#ffffff',
    surface1: '#f7fbfa',
    surface2: '#dfeae8',
    border: '#bcd2ce',
    text: '#0c2b28',
    textDim: '#456b66',
    accent: '#08736a',
    accent2: '#0a6e50',
    onAccent: '#ffffff',
    warn: '#8a5a06',
    danger: '#a83a26',
    dangerSoft: '#8c2e1c',
    caution: '#8a6a12',
    cautionSoft: '#6b520c',
    ai: '#5546b8',
    aiSoft: '#463a9c',
    // A tenth of the dark shadow's weight. A dark drop shadow scaled down is
    // still black ink under a white card; this is the panel's own border colour
    // at low alpha, which reads as depth rather than as a smudge.
    shadow: '0 1px 3px rgb(12 43 40 / 12%)',
  },
};

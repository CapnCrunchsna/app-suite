/**
 * WCAG contrast, so a palette is checked rather than eyeballed.
 *
 * The dark palette this suite started with is comfortable because it was tuned
 * against a real screen over weeks. A light palette gets no such tuning before it
 * ships, and "looks fine on my monitor" is exactly the judgement that produces
 * mid-grey captions nobody outside the author's eyesight can read.
 *
 * So the requirement list below is the design brief in executable form, and
 * `ui`'s own spec runs it over every theme this lib ships. An app that registers
 * its own theme is expected to do the same in one line — that is why `auditTheme`
 * is exported rather than kept in the test file.
 *
 * ## The thresholds and why they are what they are
 *
 * - **`text` at 7:1 (WCAG AAA).** Every screen in Ledgerline is a column of
 *   figures. AA's 4.5 is a reading threshold for prose; a mis-read digit in a
 *   statement is a different kind of wrong.
 * - **`textDim` and the accents at 4.5:1 (AA).** These carry labels, captions
 *   and the headline number. Held to AA rather than AAA because AAA on a light
 *   ground forces every accent to near-black and the palette loses its identity.
 * - **`danger` / `caution` / `ai` at 3:1 (WCAG 1.4.11).** These three are used
 *   as *borders*, not as text — the `-soft` sibling is the text weight, and it is
 *   held to 4.5. Non-text contrast is the correct requirement for a hairline.
 *
 * `border` and `shadow` are deliberately unchecked. A hairline between two panels
 * is decorative separation, and holding it to a ratio would force a palette into
 * boxed-in table styling for no accessibility gain — the regions it separates
 * differ in fill as well.
 */

import type { ResolvedMode, Theme, ThemePalette } from './theme.js';

/** Palette keys that name a plain colour — everything except the shadow, which is a whole `box-shadow` value. */
export type ColourToken = Exclude<keyof ThemePalette, 'shadow'>;

export interface ContrastRequirement {
  readonly foreground: ColourToken;
  readonly background: ColourToken;
  readonly minimum: number;
}

export interface ContrastFailure {
  readonly themeId: string;
  readonly mode: ResolvedMode;
  readonly foreground: ColourToken;
  readonly background: ColourToken;
  readonly minimum: number;
  readonly actual: number;
  /** Ready to read in a test failure: `ledgerline light: accent #0d6f47 on surface #fffdf7 is 4.1:1, needs 4.5:1`. */
  readonly message: string;
}

const GROUNDS: readonly ColourToken[] = ['bg', 'surface', 'surface1', 'surface2'];

function on(foreground: ColourToken, minimum: number, grounds = GROUNDS): ContrastRequirement[] {
  return grounds.map((background) => ({ foreground, background, minimum }));
}

/** The list every theme in this suite must satisfy, in both modes. */
export const THEME_CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  ...on('text', 7),
  ...on('textDim', 4.5),
  ...on('accent', 4.5),
  ...on('accent2', 4.5),
  ...on('warn', 4.5),
  ...on('dangerSoft', 4.5),
  ...on('cautionSoft', 4.5),
  ...on('aiSoft', 4.5),
  // Hairlines, not text — WCAG 1.4.11. Checked against the two grounds they are
  // actually drawn on; `surface1` and `surface2` are insets that never carry one.
  ...on('danger', 3, ['bg', 'surface']),
  ...on('caution', 3, ['bg', 'surface']),
  ...on('ai', 3, ['bg', 'surface']),
  // The one pair whose background is not a ground: text printed on a filled chip.
  { foreground: 'onAccent', background: 'accent', minimum: 4.5 },
];

/**
 * Relative luminance, per WCAG 2.1.
 *
 * Accepts `#rgb` and `#rrggbb`. Deliberately not a general CSS colour parser:
 * every palette in this suite is written as hex, and quietly returning a number
 * for a colour this cannot actually read would make the audit pass by accident.
 */
export function relativeLuminance(colour: string): number {
  const hex = colour.trim().replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour this audit can read: ${colour}`);
  }

  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Every requirement this theme does not meet, in both modes. Empty is a pass.
 *
 * Returns the failures rather than throwing, so a test can assert on the whole
 * list at once — one run that names all four bad pairs beats four runs that each
 * name the first.
 */
export function auditTheme(theme: Theme): ContrastFailure[] {
  const failures: ContrastFailure[] = [];

  for (const mode of ['light', 'dark'] as const) {
    const palette = mode === 'dark' ? theme.dark : theme.light;

    for (const { foreground, background, minimum } of THEME_CONTRAST_REQUIREMENTS) {
      const actual = contrastRatio(palette[foreground], palette[background]);
      if (actual >= minimum) continue;

      failures.push({
        themeId: theme.id,
        mode,
        foreground,
        background,
        minimum,
        actual,
        message:
          `${theme.id} ${mode}: ${foreground} ${palette[foreground]} on ` +
          `${background} ${palette[background]} is ${actual.toFixed(2)}:1, needs ${minimum}:1`,
      });
    }
  }

  return failures;
}

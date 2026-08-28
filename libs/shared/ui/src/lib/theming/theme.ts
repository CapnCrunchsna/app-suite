/**
 * The token contract — the whole vocabulary an app in this suite may paint with.
 *
 * ## Two axes, not one
 *
 * A **theme** is an identity: one app's palette, registered by that app. A
 * **mode** is light or dark within it. They are independent on purpose — picking
 * "Ledgerline" and picking "light" are different questions, and collapsing them
 * into a single list of four options makes adding a third app produce six.
 *
 * ## Why the contract is a TypeScript type and not a stylesheet
 *
 * The properties below are what every component in the suite already consumes,
 * as `var(--text-dim, …)` and friends. Writing them as a type buys two things a
 * `.scss` file cannot:
 *
 * - **A new theme cannot be half-written.** Omit `dangerSoft` and the compiler
 *   says so, rather than the app rendering a fallback hex from whichever
 *   component happened to declare one.
 * - **The palette is data, so it can be checked.** `contrast.ts` audits every
 *   registered theme's foreground/background pairs against WCAG, in a test. A
 *   light palette that reads well is a claim; a light palette that clears 4.5:1
 *   on twenty-eight pairs is a fact.
 */

/**
 * Every colour in a single mode of a single theme.
 *
 * Keys become CSS custom properties by kebab-casing: `textDim` → `--text-dim`,
 * `surface1` → `--surface-1`, `onAccent` → `--on-accent`. Components keep
 * consuming the properties; nothing in a feature lib imports this type.
 */
export interface ThemePalette {
  /** The page behind everything. */
  readonly bg: string;
  /** A panel, card, or header sitting on `bg`. */
  readonly surface: string;
  /** A recess *inside* a surface — code blocks, inset rows. Darker than `surface` in dark mode, lighter in light. */
  readonly surface1: string;
  /** A raised region on a surface — active rail item, table header, chips. */
  readonly surface2: string;
  /** Hairlines between regions. */
  readonly border: string;
  /** Body text. Held to 7:1 on every surface — this is a screen of numbers. */
  readonly text: string;
  /** Labels, captions, and anything secondary. Held to 4.5:1. */
  readonly textDim: string;
  /** The app's primary colour: links, focus, the active section. */
  readonly accent: string;
  /** The money colour: the headline figure, and the chip that wants a second look. */
  readonly accent2: string;
  /** Text on an `accent`-filled surface. The one token that is a foreground *for* another token. */
  readonly onAccent: string;
  /** "This did not work" — a failed read, a refused request. */
  readonly warn: string;
  /** Border weight for a destructive or failed thing. */
  readonly danger: string;
  /** Text weight for the same. Lighter than `danger` in dark mode, darker in light. */
  readonly dangerSoft: string;
  /** Border weight for "needs your attention but is not broken". */
  readonly caution: string;
  /** Text weight for the same. */
  readonly cautionSoft: string;
  /** Border weight for §4.2's "AI-assisted" marks — a distinct hue so provenance is never inferred from tone alone. */
  readonly ai: string;
  /** Text weight for the same. */
  readonly aiSoft: string;
  /** A full `box-shadow` value. Light mode needs a far weaker one; an inverted dark shadow reads as dirt. */
  readonly shadow: string;
}

/** Light, dark, or "whatever the OS is asking for". */
export type ThemeMode = 'light' | 'dark' | 'system';

/** What `mode` actually resolves to once `system` has been asked. */
export type ResolvedMode = 'light' | 'dark';

/**
 * One app's visual identity: a name, a corner radius, and two palettes.
 *
 * Both palettes are required. A theme with only a dark half is the state this
 * suite started in, and "light mode" then becomes an inversion at render time —
 * which is how you get 12%-opacity coral on cream and a shadow that looks like a
 * smudge. Writing the light palette by hand is the work; `auditTheme` is what
 * stops it from being guesswork.
 */
export interface Theme {
  /** Stable, kebab-case. Persisted, and written to `data-theme` on the root element. */
  readonly id: string;
  /** What the switcher calls it. */
  readonly label: string;
  /** One line under the name in the switcher — what this palette is *of*. */
  readonly note?: string;
  /** `--radius`. Shape, not colour, so it does not vary by mode. */
  readonly radius: string;
  readonly dark: ThemePalette;
  readonly light: ThemePalette;
}

/**
 * `textDim` → `--text-dim`, `surface1` → `--surface-1`.
 *
 * Digits get a hyphen too, so the generated names match the ones already written
 * by hand across the suite rather than being a near miss (`--surface2`) that
 * every existing `var()` would silently fall back out of.
 */
export function tokenName(key: string): string {
  return `--${key.replace(/([A-Z])|(\d+)/g, (_, upper: string | undefined, digits: string | undefined) => `-${upper ? upper.toLowerCase() : digits}`)}`;
}

/** The palette a mode selects. */
export function paletteFor(theme: Theme, mode: ResolvedMode): ThemePalette {
  return mode === 'dark' ? theme.dark : theme.light;
}

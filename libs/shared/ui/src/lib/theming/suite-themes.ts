/**
 * Every palette the suite ships, so an app can offer all of them in one line.
 *
 * ```ts
 * provideTheming(EDGELINE_THEME, { also: SUITE_THEMES })
 * ```
 *
 * The arrangement it encodes: **an app defaults to its own theme and offers
 * every other one.** Both halves matter. The default is the app's identity —
 * opening Edgeline should not look like opening Ledgerline — and the offer is
 * the reader's, because which palette someone can stand to read a screen of
 * figures in at 11pm is not a decision an app gets to make for them.
 *
 * Listing them here rather than in each app's config is what keeps that true as
 * the suite grows: a fourth app adds its theme to this array and every existing
 * app offers it, instead of three configs quietly falling out of step. Passing
 * the app's own theme here as well as to `provideTheming` is harmless —
 * `ThemeService` dedupes by id and keeps the app's own first, which is also the
 * switcher's order.
 */

import { EDGELINE_THEME } from './edgeline.theme.js';
import { LEDGERLINE_THEME } from './ledgerline.theme.js';
import { METRUM_THEME } from './metrum.theme.js';
import type { Theme } from './theme.js';

export const SUITE_THEMES: readonly Theme[] = [METRUM_THEME, LEDGERLINE_THEME, EDGELINE_THEME];

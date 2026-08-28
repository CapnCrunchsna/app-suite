/**
 * What an app calls at bootstrap to get theming.
 *
 * ```ts
 * providers: [provideTheming(LEDGERLINE_THEME)]
 * ```
 *
 * One argument, because one argument is the whole intended story: an app brings
 * its own theme, that theme becomes its default, and it joins the house theme in
 * the switcher. Registering a theme and choosing a default are not two decisions
 * an app should be able to get out of step.
 *
 * The environment initializer is the load-bearing part. `ThemeService` is
 * `providedIn: 'root'` and therefore lazy, so without this it would first
 * construct when the switcher rendered — which is after the first paint, in a
 * component the app might not even use. Forcing construction here is what makes
 * "the palette is on `:root` before anything renders" true.
 */

import {
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';

import { THEMING_CONFIG, ThemeService, type ThemingOptions } from './theme.service.js';
import type { Theme } from './theme.js';

export function provideTheming(theme: Theme, options: ThemingOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: THEMING_CONFIG, useValue: { ...options, theme } },
    // Constructing it is the whole point: the constructor reads the stored choice
    // and paints the root element. Nothing is done with the instance here.
    provideEnvironmentInitializer(() => void inject(ThemeService)),
  ]);
}

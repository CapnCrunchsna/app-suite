import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { EDGELINE_THEME, SUITE_THEMES, provideTheming } from '@metrum/ui';
import { appRoutes } from './app.routes';

/**
 * §11.2 originally asked for "a blue-green theme consistent with the
 * MetrumDigital palette (accent teal `#2dd4bf`, emerald `#34d399`)", which *is*
 * `METRUM_THEME` verbatim — so this app used to register the house theme. The
 * effect was that Edgeline, Ledgerline and the workspace dashboard all read as
 * the same product, and the switcher hid itself because one registered theme is
 * nothing to switch between.
 *
 * §11.2 was amended on 2026-09-11: each app carries its own identity and offers
 * the others. `EDGELINE_THEME` is the default, `SUITE_THEMES` is the rest.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      appRoutes,
      // The tables here are long and every rail item is a different table. Landing
      // halfway down a fresh page because the last one was scrolled is disorienting.
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),
    provideTheming(EDGELINE_THEME, { also: SUITE_THEMES }),
  ],
};

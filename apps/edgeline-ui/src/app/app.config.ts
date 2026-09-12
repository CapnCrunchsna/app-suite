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
      withInMemoryScrolling({
        // The tables here are long and every rail item is a different table.
        // Landing halfway down a fresh page because the last one was scrolled is
        // disorienting.
        scrollPositionRestoration: 'top',
        // The header's PAPER/ALERTS/OFFLINE badges are links to the control that
        // changes each flag (§16.2 — they are status, not switches). Without
        // this the fragment is carried in the URL and then ignored, so the badge
        // drops the reader at the top of Settings to hunt for the field it was
        // pointing at. A link that names a destination has to arrive at it.
        anchorScrolling: 'enabled',
      }),
    ),
    provideTheming(EDGELINE_THEME, { also: SUITE_THEMES }),
  ],
};

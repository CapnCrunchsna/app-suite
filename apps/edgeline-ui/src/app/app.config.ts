import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { METRUM_THEME, provideTheming } from '@metrum/ui';
import { appRoutes } from './app.routes';

/**
 * §11.2 asks for "a blue-green theme consistent with the MetrumDigital palette
 * (accent teal `#2dd4bf`, emerald `#34d399`)". `METRUM_THEME` in
 * `libs/shared/ui` **is** that palette — those two hexes verbatim — so this app
 * registers the house theme rather than declaring a near-copy of it under
 * another name. Ledgerline brings its own because it is a theme *of* something
 * (ink and ledger paper); Edgeline has no such argument to make, and a second
 * palette would be one more set of twenty-eight WCAG pairs to keep honest for no
 * visual gain.
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
    provideTheming(METRUM_THEME),
  ],
};

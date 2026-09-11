import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { LEDGERLINE_THEME, SUITE_THEMES, provideTheming } from '@metrum/ui';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    // Ledgerline's own palette is the default; `SUITE_THEMES` offers the rest in
    // the switcher. `@metrum/ui` owns every colour — this app names none.
    provideTheming(LEDGERLINE_THEME, { also: SUITE_THEMES }),
  ],
};

import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideTheming } from '@metrum/ui';
import { appRoutes } from './app.routes';
import { LEDGERLINE_THEME } from './ledgerline.theme';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    // One call registers the app's palette, makes it the default, and puts it in
    // the switcher next to the house theme. `@metrum/ui` owns the rest — this app
    // never names a colour outside `ledgerline.theme.ts`.
    provideTheming(LEDGERLINE_THEME),
  ],
};

import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { METRUM_THEME, SUITE_THEMES, provideTheming } from '@metrum/ui';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideTheming(METRUM_THEME, { also: SUITE_THEMES })],
};

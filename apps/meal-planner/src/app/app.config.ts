import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy } from '@ionic/angular/ionic-route-strategy';
import { provideIonicAngular } from '@ionic/angular/provide';
import { appRoutes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `useSetInputAPI` makes a modal's `componentProps` go through `setInput`, so modal
    // components take signal `input()`s like every other component here.
    provideIonicAngular({ useSetInputAPI: true }),
    // Ionic keeps each tab's page alive across tab switches; Angular's default strategy
    // would destroy and rebuild it, losing scroll position and half-typed input.
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    // Route params arrive as component inputs (the meal detail's `id`).
    provideRouter(appRoutes, withComponentInputBinding()),
  ],
};

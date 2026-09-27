import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular';
import { Database } from './data/database';

@Component({
  selector: 'mp-root',
  imports: [IonApp, IonRouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ion-app><ion-router-outlet /></ion-app>`,
})
export class App {
  constructor() {
    // Open (and migrate) while the first page renders rather than when it first asks.
    // Pages await the same promise and report a failure themselves.
    inject(Database)
      .ready()
      .catch((error) => console.error('Could not open the database', error));
  }
}

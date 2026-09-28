import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { IonApp } from '@ionic/angular/ion-app';
import { IonRouterOutlet } from '@ionic/angular/ion-router-outlet';
import { Platform } from '@ionic/angular/platform';
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

    if (Capacitor.isNativePlatform()) {
      // Android's Back button reaches Ionic only while a JS listener exists: without one the
      // App plugin just steps the WebView's history. With it, Ionic dismisses the open overlay
      // (asking first where a modal guards unsaved work) or pops the page; and when nothing
      // is left to close, this lowest-priority handler leaves the app, as Back should.
      void CapacitorApp.addListener('backButton', () => undefined);
      inject(Platform).backButton.subscribeWithPriority(-1, () => void CapacitorApp.exitApp());
    }
  }
}

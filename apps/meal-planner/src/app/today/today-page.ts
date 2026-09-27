import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'mp-today-page',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Today</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="empty-state"><p>Nothing planned yet.</p></div>
    </ion-content>
  `,
})
export class TodayPage {}

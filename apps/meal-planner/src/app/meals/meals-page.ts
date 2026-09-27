import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'mp-meals-page',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Meals</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="empty-state"><p>No meals yet.</p></div>
    </ion-content>
  `,
})
export class MealsPage {}

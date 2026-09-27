import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';

@Component({
  selector: 'mp-pantry-page',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Pantry</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <div class="empty-state"><p>Nothing in the pantry yet.</p></div>
    </ion-content>
  `,
})
export class PantryPage {}

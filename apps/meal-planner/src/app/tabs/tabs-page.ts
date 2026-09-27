import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { basketOutline, calendarOutline, restaurantOutline, settingsOutline } from 'ionicons/icons';

@Component({
  selector: 'mp-tabs-page',
  imports: [IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="pantry">
          <ion-icon name="basket-outline" aria-hidden="true" />
          <ion-label>Pantry</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="meals">
          <ion-icon name="restaurant-outline" aria-hidden="true" />
          <ion-label>Meals</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="today">
          <ion-icon name="calendar-outline" aria-hidden="true" />
          <ion-label>Today</ion-label>
        </ion-tab-button>
        <ion-tab-button tab="settings">
          <ion-icon name="settings-outline" aria-hidden="true" />
          <ion-label>Settings</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
})
export class TabsPage {
  constructor() {
    addIcons({ basketOutline, restaurantOutline, calendarOutline, settingsOutline });
  }
}

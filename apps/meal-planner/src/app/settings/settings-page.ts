/**
 * The Settings tab (meal-planner-spec.md §10) — its six things and nothing else.
 *
 * Every field saves as soon as it holds a valid value; there is no Save button to
 * forget. A field that is blank or out of range keeps the stored value and says so.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ViewWillEnter } from '@ionic/angular';
import { AlertController } from '@ionic/angular/alert-controller';
import { IonButton } from '@ionic/angular/ion-button';
import { IonContent } from '@ionic/angular/ion-content';
import { IonHeader } from '@ionic/angular/ion-header';
import { IonIcon } from '@ionic/angular/ion-icon';
import { IonInput } from '@ionic/angular/ion-input';
import { IonItem } from '@ionic/angular/ion-item';
import { IonLabel } from '@ionic/angular/ion-label';
import { IonList } from '@ionic/angular/ion-list';
import { IonListHeader } from '@ionic/angular/ion-list-header';
import { IonNote } from '@ionic/angular/ion-note';
import { IonSpinner } from '@ionic/angular/ion-spinner';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import { deleteAll, exportAll, type Settings, type SlotCounts } from '@metrum/meal-planner-data';
import { addIcons } from 'ionicons';
import { addOutline, removeOutline, shareOutline, trashOutline } from 'ionicons/icons';
import { Store } from '../data/store';
import { systemClock } from '../data/database';
import { shareTextFile } from '../platform/share-file';
import { eventValue, parseNumber } from '../shared/events';
import { Notify } from '../shared/notify';

@Component({
  selector: 'mp-settings-page',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonSpinner,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonInput,
    IonNote,
    IonButton,
    IonIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Settings</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      @if (failure()) {
        <div class="empty-state" role="alert"><p class="error">{{ failure() }}</p></div>
      } @else if (settings(); as s) {
        <ion-list lines="full">
          <ion-list-header><ion-label>Defaults for a new day</ion-label></ion-list-header>
          <ion-item>
            <ion-input
              label="Calories"
              labelPlacement="fixed"
              type="number"
              inputmode="numeric"
              class="numbers"
              [value]="s.defaultKcalBudget"
              (ionChange)="saveNumber('defaultKcalBudget', $event, 1)"
            />
            <span slot="end">kcal</span>
          </ion-item>
          <ion-item>
            <ion-input
              label="Protein"
              labelPlacement="fixed"
              type="number"
              inputmode="decimal"
              class="numbers"
              [value]="s.defaultProteinTarget"
              (ionChange)="saveNumber('defaultProteinTarget', $event, 0)"
            />
            <span slot="end">g</span>
          </ion-item>
          <ion-item>
            <ion-label>Meals</ion-label>
            <ion-button slot="end" fill="outline" aria-label="Fewer meals" [disabled]="s.defaultSlots.meals <= 1" (click)="stepSlots('meals', -1)">
              <ion-icon slot="icon-only" name="remove-outline" />
            </ion-button>
            <span slot="end" class="stepper-value numbers">{{ s.defaultSlots.meals }}</span>
            <ion-button slot="end" fill="outline" aria-label="More meals" [disabled]="s.defaultSlots.meals >= 3" (click)="stepSlots('meals', 1)">
              <ion-icon slot="icon-only" name="add-outline" />
            </ion-button>
          </ion-item>
          <ion-item>
            <ion-label>Snacks</ion-label>
            <ion-button slot="end" fill="outline" aria-label="Fewer snacks" [disabled]="s.defaultSlots.snacks <= 0" (click)="stepSlots('snacks', -1)">
              <ion-icon slot="icon-only" name="remove-outline" />
            </ion-button>
            <span slot="end" class="stepper-value numbers">{{ s.defaultSlots.snacks }}</span>
            <ion-button slot="end" fill="outline" aria-label="More snacks" [disabled]="s.defaultSlots.snacks >= 3" (click)="stepSlots('snacks', 1)">
              <ion-icon slot="icon-only" name="add-outline" />
            </ion-button>
          </ion-item>
          @if (invalid()) {
            <ion-item lines="none"><ion-note color="danger">{{ invalid() }}</ion-note></ion-item>
          }
        </ion-list>

        <ion-list lines="full">
          <ion-list-header><ion-label>USDA FoodData Central</ion-label></ion-list-header>
          <ion-item>
            <ion-input
              label="API key"
              labelPlacement="stacked"
              type="password"
              autocomplete="off"
              placeholder="Optional"
              [value]="s.usdaApiKey ?? ''"
              (ionChange)="saveKey($event)"
            />
          </ion-item>
          <ion-item lines="none">
            <ion-note>With a key, Search catalog also looks up foods in the USDA database. Get one free at api.data.gov.</ion-note>
          </ion-item>
        </ion-list>

        <ion-list lines="full">
          <ion-list-header><ion-label>Your data</ion-label></ion-list-header>
          <ion-item button [detail]="false" [disabled]="busy()" (click)="export()">
            <ion-icon slot="start" name="share-outline" />
            <ion-label>Export data<p>Everything, as one JSON file</p></ion-label>
          </ion-item>
          <ion-item button [detail]="false" [disabled]="busy()" (click)="confirmDeleteAll()">
            <ion-icon slot="start" name="trash-outline" color="danger" />
            <ion-label color="danger">Delete all data</ion-label>
          </ion-item>
        </ion-list>
      } @else {
        <div class="empty-state" aria-busy="true"><ion-spinner /></div>
      }
    </ion-content>
  `,
})
export class SettingsPage implements ViewWillEnter {
  private readonly store = inject(Store);
  private readonly notify = inject(Notify);
  private readonly alerts = inject(AlertController);

  protected readonly settings = signal<Settings | null>(null);
  protected readonly failure = signal<string | null>(null);
  protected readonly invalid = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    addIcons({ addOutline, removeOutline, shareOutline, trashOutline });
  }

  ionViewWillEnter(): void {
    void this.run(async () => {
      const { settings } = await this.store.ready();
      this.settings.set(await settings.read());
    });
  }

  protected saveNumber(field: 'defaultKcalBudget' | 'defaultProteinTarget', event: Event, min: number): void {
    const n = parseNumber(eventValue(event));
    const what = field === 'defaultKcalBudget' ? 'Calories' : 'Protein';
    if (n === null || n < min) {
      this.invalid.set(`${what} must be ${min === 0 ? 'zero or more' : 'more than zero'}; the saved value is unchanged.`);
      return;
    }
    this.invalid.set(null);
    void this.write({ [field]: n });
  }

  protected stepSlots(which: keyof SlotCounts, delta: number): void {
    const current = this.settings()?.defaultSlots;
    if (current) void this.write({ defaultSlots: { ...current, [which]: current[which] + delta } });
  }

  protected saveKey(event: Event): void {
    const key = eventValue(event).trim();
    void this.write({ usdaApiKey: key === '' ? null : key });
  }

  protected export(): Promise<void> {
    return this.run(async () => {
      const { db } = await this.store.ready();
      const dump = await exportAll(db, systemClock);
      const stamp = dump.exportedAt.slice(0, 10);
      await shareTextFile(`meal-planner-${stamp}.json`, JSON.stringify(dump, null, 2), 'application/json');
    });
  }

  protected async confirmDeleteAll(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Delete all data?',
      message: 'Your pantry, meals, plans and settings will be gone. Type DELETE to confirm.',
      inputs: [{ name: 'confirm', type: 'text', placeholder: 'DELETE', attributes: { autocapitalize: 'characters' } }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: (values: { confirm?: string }) => values.confirm?.trim() === 'DELETE' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role !== 'destructive') return;
    await this.run(async () => {
      const { db, settings } = await this.store.ready();
      await deleteAll(db, systemClock);
      this.settings.set(await settings.read());
      await this.notify.toast('All data deleted');
    });
  }

  private write(change: Partial<Settings>): Promise<void> {
    return this.run(async () => {
      const { settings } = await this.store.ready();
      this.settings.set(await settings.write(change));
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
      this.failure.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.settings()) await this.notify.toast(message, { seconds: 4 });
      else this.failure.set(message);
    } finally {
      this.busy.set(false);
    }
  }
}

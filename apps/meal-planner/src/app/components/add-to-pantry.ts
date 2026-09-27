/**
 * §7 step 2's sheet: "Add ⟨name⟩ to pantry" — how many packages, and optionally when
 * they expire. A scan says *what* was bought, never how many, so the count defaults to
 * one and is one tap to change.
 *
 * Dismisses with `{ packages, expiresOn }`, or with role `cancel`.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  ModalController,
} from '@ionic/angular';
import { formatAmount, productLabel, type Product } from '@metrum/meal-planner-domain';
import { addIcons } from 'ionicons';
import { addOutline, removeOutline } from 'ionicons/icons';
import { eventValue } from '../shared/events';

export interface AddToPantryResult {
  readonly packages: number;
  readonly expiresOn: string | null;
}

@Component({
  selector: 'mp-add-to-pantry',
  imports: [IonContent, IonList, IonItem, IonLabel, IonButton, IonIcon, IonInput, IonNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-content class="ion-padding">
      <h2 class="sheet-title">Add {{ label() }} to pantry</h2>
      <ion-list lines="none">
        <ion-item>
          <ion-label>
            Packages
            <ion-note>
              <p class="numbers">{{ total() }} in all</p>
            </ion-note>
          </ion-label>
          <ion-button slot="end" fill="outline" aria-label="One fewer" [disabled]="packages() <= 1" (click)="step(-1)">
            <ion-icon slot="icon-only" name="remove-outline" />
          </ion-button>
          <span slot="end" class="stepper-value numbers" aria-live="polite">{{ packages() }}</span>
          <ion-button slot="end" fill="outline" aria-label="One more" (click)="step(1)">
            <ion-icon slot="icon-only" name="add-outline" />
          </ion-button>
        </ion-item>
        <ion-item>
          <ion-input
            type="date"
            label="Expires (optional)"
            labelPlacement="stacked"
            [value]="expiresOn()"
            (ionInput)="expiresOn.set(value($event))"
          />
        </ion-item>
      </ion-list>
      <ion-button expand="block" (click)="confirm()">Add to pantry</ion-button>
      <ion-button expand="block" fill="clear" (click)="cancel()">Cancel</ion-button>
    </ion-content>
  `,
})
export class AddToPantry {
  readonly product = input.required<Product>();

  private readonly modals = inject(ModalController);

  protected readonly packages = signal(1);
  protected readonly expiresOn = signal('');
  protected readonly label = computed(() => productLabel(this.product()));
  protected readonly total = computed(() =>
    formatAmount(this.packages() * this.product().packageAmount, this.product().packageUnit),
  );
  protected readonly value = eventValue;

  constructor() {
    addIcons({ addOutline, removeOutline });
  }

  protected step(delta: number): void {
    this.packages.update((n) => Math.max(1, n + delta));
  }

  protected confirm(): void {
    const result: AddToPantryResult = { packages: this.packages(), expiresOn: this.expiresOn() || null };
    void this.modals.dismiss(result, 'confirm');
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }
}

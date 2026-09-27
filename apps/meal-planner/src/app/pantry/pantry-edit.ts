/**
 * §10's swipe-right Edit: how much is left, and when it expires.
 *
 * The amount is edited in the product's own unit — items, grams, millilitres — with
 * one-tap shortcuts for the two answers people actually give ("still full", "about half
 * left"), because §13.6 forbids demanding precision the person does not have. Both are
 * measured against the whole purchase the row still spans, so "about half" of two jars
 * is one jar.
 *
 * Dismisses with `{ quantity, expiresOn }`, with role `edit-product` to open the product
 * form instead, or with role `cancel`.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import type { PantryEntry } from '@metrum/meal-planner-data';
import { formatAmount, packagesSpanned, productLabel } from '@metrum/meal-planner-domain';
import { eventValue, parseNumber } from '../shared/events';

const UNIT_WORD = { COUNT: 'items', G: 'g', ML: 'ml' } as const;

@Component({
  selector: 'mp-pantry-edit',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonList, IonItem, IonInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-button (click)="cancel()">Cancel</ion-button></ion-buttons>
        <ion-title>{{ label() }}</ion-title>
        <ion-buttons slot="end">
          <ion-button [strong]="true" [disabled]="quantityValue() === null" (click)="save()">Save</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-list lines="full">
        <ion-item>
          <ion-input
            type="number"
            inputmode="decimal"
            labelPlacement="stacked"
            [label]="'Left (' + unitWord() + ')'"
            [value]="quantity()"
            (ionInput)="quantity.set(value($event))"
          />
        </ion-item>
        <ion-item>
          <ion-button fill="outline" size="small" (click)="setFraction(1)">Full ({{ fullText() }})</ion-button>
          <ion-button fill="outline" size="small" (click)="setFraction(0.5)">About half</ion-button>
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
      <div class="ion-padding">
        <ion-button expand="block" fill="clear" (click)="editProduct()">Edit product details</ion-button>
      </div>
    </ion-content>
  `,
})
export class PantryEdit implements OnInit {
  readonly entry = input.required<PantryEntry>();

  private readonly modals = inject(ModalController);

  protected readonly quantity = signal('');
  protected readonly expiresOn = signal('');
  protected readonly value = eventValue;

  protected readonly label = computed(() => productLabel(this.entry().product));
  protected readonly unitWord = computed(() => UNIT_WORD[this.entry().product.packageUnit]);
  /** What "full" means for this row: the whole packages it still spans (two jars → 800 g). */
  private readonly full = computed(() => {
    const { item, product } = this.entry();
    return packagesSpanned(item.quantity, product.packageAmount) * product.packageAmount;
  });
  protected readonly fullText = computed(() => formatAmount(this.full(), this.entry().product.packageUnit));
  protected readonly quantityValue = computed(() => {
    const n = parseNumber(this.quantity());
    return n !== null && n >= 0 ? n : null;
  });

  ngOnInit(): void {
    this.quantity.set(String(Math.round(this.entry().item.quantity * 100) / 100));
    this.expiresOn.set(this.entry().item.expiresOn ?? '');
  }

  protected setFraction(fraction: number): void {
    this.quantity.set(String(Math.round(this.full() * fraction * 100) / 100));
  }

  protected save(): void {
    const quantity = this.quantityValue();
    if (quantity === null) return;
    void this.modals.dismiss({ quantity, expiresOn: this.expiresOn() || null }, 'save');
  }

  protected editProduct(): void {
    void this.modals.dismiss(null, 'edit-product');
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }
}

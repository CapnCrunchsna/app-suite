/**
 * §10's "Search catalog": pick a product already known to the app.
 *
 * With nothing typed it opens on "Buy again" — the products most recently added to the
 * pantry — because groceries are overwhelmingly repeat purchases, and after the first
 * weeks most entry should be one tap here rather than a scan (design doc, food entry).
 *
 * Dismisses with the picked `Product`, with role `new` to create one, or `cancel`.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSearchbar,
  IonTitle,
  IonToolbar,
  ModalController,
  type ViewDidEnter,
} from '@ionic/angular';
import { distinctBrand, formatAmount, type Product } from '@metrum/meal-planner-domain';
import { Store } from '../data/store';
import { eventValue } from '../shared/events';

@Component({
  selector: 'mp-catalog-search',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonSearchbar,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonNote,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-button (click)="cancel()">Cancel</ion-button></ion-buttons>
        <ion-title>Add from catalog</ion-title>
        <ion-buttons slot="end"><ion-button (click)="createNew()">New</ion-button></ion-buttons>
      </ion-toolbar>
      <ion-toolbar>
        <ion-searchbar placeholder="Search your products" [debounce]="150" (ionInput)="search(value($event))" />
      </ion-toolbar>
    </ion-header>
    <ion-content>
      @if (query() === '' && recents().length > 0) {
        <ion-list>
          <ion-list-header>Buy again</ion-list-header>
          @for (product of recents(); track product.id) {
            <ion-item button (click)="pick(product)">
              <ion-label>{{ product.name }}@if (brand(product); as b) {<p>{{ b }}</p>}</ion-label>
              <ion-note slot="end" class="numbers">{{ size(product) }}</ion-note>
            </ion-item>
          }
        </ion-list>
      }
      <ion-list>
        <ion-list-header>{{ query() === '' ? 'All products' : 'Matches' }}</ion-list-header>
        @for (product of results(); track product.id) {
          <ion-item button (click)="pick(product)">
            <ion-label>{{ product.name }}@if (brand(product); as b) {<p>{{ b }}</p>}</ion-label>
            <ion-note slot="end" class="numbers">{{ size(product) }}</ion-note>
          </ion-item>
        } @empty {
          <div class="empty-state">
            <p>{{ query() === '' ? 'No products yet.' : 'Nothing matches “' + query() + '”.' }}</p>
            <ion-button fill="outline" (click)="createNew()">Add a new product</ion-button>
          </div>
        }
      </ion-list>
    </ion-content>
  `,
})
export class CatalogSearch implements ViewDidEnter {
  private readonly modals = inject(ModalController);
  private readonly store = inject(Store);

  protected readonly query = signal('');
  protected readonly results = signal<Product[]>([]);
  protected readonly recents = signal<Product[]>([]);
  protected readonly value = eventValue;

  async ionViewDidEnter(): Promise<void> {
    const { products } = await this.store.ready();
    this.recents.set(await products.recentlyBought());
    await this.search('');
  }

  protected async search(text: string): Promise<void> {
    this.query.set(text.trim());
    const { products } = await this.store.ready();
    const found = await products.search(text);
    if (this.query() === text.trim()) this.results.set(found);
  }

  protected readonly brand = distinctBrand;

  protected size(product: Product): string {
    return formatAmount(product.packageAmount, product.packageUnit);
  }

  protected pick(product: Product): void {
    void this.modals.dismiss(product, 'pick');
  }

  protected createNew(): void {
    void this.modals.dismiss(null, 'new');
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }
}

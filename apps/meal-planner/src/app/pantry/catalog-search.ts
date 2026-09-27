/**
 * §10's "Search catalog": pick a product already known to the app.
 *
 * With nothing typed it opens on "Buy again" — the products most recently added to the
 * pantry — because groceries are overwhelmingly repeat purchases, and after the first
 * weeks most entry should be one tap here rather than a scan (design doc, food entry).
 *
 * With a USDA key in Settings, a typed search can also be sent to USDA FoodData Central.
 *
 * Dismisses with the picked `Product` (role `pick`), a USDA `ProductPrefill` for the
 * product form (role `usda`), role `new` to create one, or `cancel`.
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
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
  type ViewDidEnter,
} from '@ionic/angular';
import { distinctBrand, formatAmount, type Product } from '@metrum/meal-planner-domain';
import { searchUsda, type ProductPrefill } from '@metrum/meal-planner-import';
import { Store } from '../data/store';
import { httpGet } from '../platform/http';
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
    IonSpinner,
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
      @if (usdaKey() && query() !== '') {
        <ion-list>
          <ion-list-header>USDA</ion-list-header>
          @if (usda(); as found) {
            @if (found.query !== query()) {
              <ion-item button [detail]="false" (click)="searchUsda()">
                <ion-label color="primary">Search USDA for “{{ query() }}”</ion-label>
              </ion-item>
            } @else if (found.error) {
              <ion-item lines="none"><ion-label class="ion-text-wrap error">{{ found.error }}</ion-label></ion-item>
            } @else {
              @for (food of found.foods; track $index) {
                <ion-item button (click)="pickUsda(food)">
                  <ion-label class="ion-text-wrap">{{ food.name }}@if (food.brand) {<p>{{ food.brand }}</p>}</ion-label>
                  @if (food.kcal !== null) {
                    <ion-note slot="end" class="numbers">{{ food.kcal }} kcal/100 g</ion-note>
                  }
                </ion-item>
              } @empty {
                <ion-item lines="none"><ion-label>USDA has nothing for “{{ query() }}”.</ion-label></ion-item>
              }
            }
          } @else if (usdaBusy()) {
            <ion-item lines="none"><ion-spinner slot="start" /><ion-label>Searching USDA…</ion-label></ion-item>
          } @else {
            <ion-item button [detail]="false" (click)="searchUsda()">
              <ion-label color="primary">Search USDA for “{{ query() }}”</ion-label>
            </ion-item>
          }
        </ion-list>
      }
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

  /** Set only when the person has entered a key in Settings; without one USDA is not offered (§7). */
  protected readonly usdaKey = signal<string | null>(null);
  protected readonly usda = signal<{ query: string; foods: readonly ProductPrefill[]; error: string | null } | null>(null);
  protected readonly usdaBusy = signal(false);

  async ionViewDidEnter(): Promise<void> {
    const { products, settings } = await this.store.ready();
    this.usdaKey.set((await settings.read()).usdaApiKey);
    this.recents.set(await products.recentlyBought());
    // Whatever was typed while the modal animated in, not a reset to empty.
    await this.search(this.query());
  }

  /** On a tap, not per keystroke: every search spends the person's own API quota. */
  protected async searchUsda(): Promise<void> {
    const key = this.usdaKey();
    const query = this.query();
    if (!key || query === '') return;
    this.usda.set(null);
    this.usdaBusy.set(true);
    const result = await searchUsda(httpGet, key, query).finally(() => this.usdaBusy.set(false));
    this.usda.set(
      result.kind === 'found'
        ? { query, foods: result.foods, error: null }
        : { query, foods: [], error: `Couldn’t search USDA: ${result.reason}` },
    );
  }

  protected pickUsda(food: ProductPrefill): void {
    void this.modals.dismiss(food, 'usda');
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

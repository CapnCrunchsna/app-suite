/**
 * One meal (meal-planner-spec.md §10 "Meal detail"): its ingredient lines as written,
 * per-serving nutrition, Edit, and Delete — soft, with the same Undo as the pantry.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NavController } from '@ionic/angular/nav-controller';
import type { ViewWillEnter } from '@ionic/angular';
import { IonBackButton } from '@ionic/angular/ion-back-button';
import { IonButton } from '@ionic/angular/ion-button';
import { IonButtons } from '@ionic/angular/ion-buttons';
import { IonChip } from '@ionic/angular/ion-chip';
import { IonContent } from '@ionic/angular/ion-content';
import { IonHeader } from '@ionic/angular/ion-header';
import { IonItem } from '@ionic/angular/ion-item';
import { IonLabel } from '@ionic/angular/ion-label';
import { IonList } from '@ionic/angular/ion-list';
import { IonListHeader } from '@ionic/angular/ion-list-header';
import { IonNote } from '@ionic/angular/ion-note';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import type { MealWithIngredients } from '@metrum/meal-planner-data';
import { displayKcal, displayProtein, type Product } from '@metrum/meal-planner-domain';
import { SLOT_LABEL } from '../components/slot-chips';
import { Store } from '../data/store';
import { Notify } from '../shared/notify';
import { MealFlows } from './meal-flows';

@Component({
  selector: 'mp-meal-detail-page',
  imports: [
    IonHeader,
    IonToolbar,
    IonButtons,
    IonBackButton,
    IonTitle,
    IonButton,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonNote,
    IonChip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/meals" /></ion-buttons>
        <ion-title>{{ detail()?.meal?.name ?? 'Meal' }}</ion-title>
        @if (detail()) {
          <ion-buttons slot="end"><ion-button (click)="edit()">Edit</ion-button></ion-buttons>
        }
      </ion-toolbar>
    </ion-header>
    <ion-content>
      @if (detail(); as d) {
        <div class="ion-padding">
          <p class="numbers detail-nutrition">
            <strong>{{ kcal() }} kcal</strong> · <strong>{{ protein() }} g</strong> protein per serving
          </p>
          <p class="notice">
            Makes {{ d.meal.servings }} {{ d.meal.servings === 1 ? 'serving' : 'servings' }}
            @if (d.meal.nutritionSource === 'site') {
              · nutrition as stated by the recipe page
            }
          </p>
          @for (slot of d.meal.slots; track slot) {
            <ion-chip [outline]="true">{{ slotLabel[slot] }}</ion-chip>
          }
        </div>
        <ion-list>
          <ion-list-header>Ingredients</ion-list-header>
          @for (line of d.ingredients; track line.id) {
            <ion-item>
              <ion-label>
                {{ line.displayText }}
                @if (line.productId && productName(line.productId) !== line.displayText) {
                  <p>{{ productName(line.productId) }}</p>
                }
              </ion-label>
              @if (line.toTaste) {
                <ion-note slot="end">to taste</ion-note>
              } @else if (!line.productId) {
                <ion-note slot="end">not counted</ion-note>
              }
            </ion-item>
          }
        </ion-list>
        @if (d.meal.sourceUrl) {
          <p class="ion-padding-horizontal notice">From {{ d.meal.sourceUrl }}</p>
        }
        <div class="ion-padding">
          <ion-button color="danger" fill="clear" expand="block" (click)="remove()">Delete meal</ion-button>
        </div>
      } @else if (missing()) {
        <div class="empty-state"><p>This meal no longer exists.</p></div>
      }
    </ion-content>
  `,
})
export class MealDetailPage implements ViewWillEnter {
  /** The route's `:id`, bound by the router. */
  readonly id = input.required<string>();

  private readonly store = inject(Store);
  private readonly flows = inject(MealFlows);
  private readonly notify = inject(Notify);
  private readonly nav = inject(NavController);

  protected readonly detail = signal<MealWithIngredients | null>(null);
  protected readonly products = signal<ReadonlyMap<string, Product>>(new Map());
  protected readonly missing = signal(false);
  protected readonly slotLabel = SLOT_LABEL;
  protected readonly kcal = computed(() => displayKcal(this.detail()?.meal.kcalPerServing ?? 0));
  protected readonly protein = computed(() => displayProtein(this.detail()?.meal.proteinPerServing ?? 0));

  ionViewWillEnter(): void {
    void this.reload();
  }

  protected productName(id: string): string {
    return this.products().get(id)?.name ?? '';
  }

  protected async edit(): Promise<void> {
    const d = this.detail();
    if (d && (await this.flows.build(d))) await this.reload();
  }

  protected async remove(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const { meals } = await this.store.ready();
    await meals.remove(d.meal.id);
    void this.nav.navigateBack('/meals');
    await this.notify.toast(`Deleted ${d.meal.name}`, { undo: () => meals.restore(d.meal.id) });
  }

  private async reload(): Promise<void> {
    const { meals, products } = await this.store.ready();
    const d = await meals.get(this.id());
    this.detail.set(d && !d.meal.deletedAt ? d : null);
    this.missing.set(!d || d.meal.deletedAt !== null);
    if (d) this.products.set(await products.getMany(d.ingredients.flatMap((i) => (i.productId ? [i.productId] : []))));
  }
}

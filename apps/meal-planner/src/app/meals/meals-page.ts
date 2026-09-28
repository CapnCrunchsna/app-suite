/**
 * The Meals tab (meal-planner-spec.md §10): the library, each meal with its per-serving
 * kcal and protein and whether the pantry can make it right now — "missing: X, Y" when
 * it cannot, because that is the difference between a meal the planner will offer and
 * one it will not.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ViewWillEnter } from '@ionic/angular';
import { IonButton } from '@ionic/angular/ion-button';
import { IonButtons } from '@ionic/angular/ion-buttons';
import { IonContent } from '@ionic/angular/ion-content';
import { IonHeader } from '@ionic/angular/ion-header';
import { IonIcon } from '@ionic/angular/ion-icon';
import { IonItem } from '@ionic/angular/ion-item';
import { IonLabel } from '@ionic/angular/ion-label';
import { IonList } from '@ionic/angular/ion-list';
import { IonSearchbar } from '@ionic/angular/ion-searchbar';
import { IonSpinner } from '@ionic/angular/ion-spinner';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import { displayKcal, displayProtein, shortfalls, type Meal } from '@metrum/meal-planner-domain';
import { addIcons } from 'ionicons';
import { addOutline, checkmarkCircle, linkOutline } from 'ionicons/icons';
import { Store } from '../data/store';
import { eventValue } from '../shared/events';
import { MealFlows } from './meal-flows';

interface MealRow {
  readonly meal: Meal;
  /** Names of what the pantry lacks for one serving; empty when makeable. */
  readonly missing: readonly string[];
}

@Component({
  selector: 'mp-meals-page',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonSearchbar,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Meals</ion-title>
        <ion-buttons slot="end">
          <ion-button aria-label="Import from URL" (click)="importUrl()">
            <ion-icon slot="icon-only" name="link-outline" />
          </ion-button>
          <ion-button aria-label="New meal" (click)="create()">
            <ion-icon slot="icon-only" name="add-outline" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
      @if (rows().length > 0) {
        <ion-toolbar>
          <ion-searchbar placeholder="Filter" [debounce]="100" (ionInput)="filter.set(value($event))" />
        </ion-toolbar>
      }
    </ion-header>
    <ion-content>
      @if (failure()) {
        <div class="empty-state" role="alert"><p class="error">{{ failure() }}</p></div>
      } @else if (!loaded()) {
        <div class="empty-state" aria-busy="true"><ion-spinner /><p>Getting your meals ready…</p></div>
      } @else if (rows().length === 0) {
        <div class="empty-state">
          <p>No meals yet. Build one from your products, or import a recipe you like.</p>
          <ion-button (click)="create()">New meal</ion-button>
          <ion-button fill="clear" (click)="importUrl()">Import from URL</ion-button>
        </div>
      } @else {
        <ion-list>
          @for (row of visible(); track row.meal.id) {
            <ion-item button (click)="open(row.meal)">
              <ion-label>
                {{ row.meal.name }}
                <p class="numbers">{{ kcal(row.meal) }} kcal · {{ protein(row.meal) }} g protein</p>
                @if (row.missing.length > 0) {
                  <p class="needs">missing: {{ row.missing.join(', ') }}</p>
                }
              </ion-label>
              @if (row.missing.length === 0) {
                <ion-icon slot="end" name="checkmark-circle" color="success" aria-label="Can make now" />
              }
            </ion-item>
          } @empty {
            <div class="empty-state"><p>Nothing matches “{{ filter() }}”.</p></div>
          }
        </ion-list>
      }
    </ion-content>
  `,
})
export class MealsPage implements ViewWillEnter {
  private readonly store = inject(Store);
  private readonly flows = inject(MealFlows);
  private readonly router = inject(Router);

  protected readonly rows = signal<MealRow[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly value = eventValue;

  protected readonly visible = computed(() => {
    const words = this.filter().toLowerCase().split(/\s+/).filter(Boolean);
    return this.rows().filter((r) => words.every((w) => r.meal.name.toLowerCase().includes(w)));
  });

  constructor() {
    addIcons({ addOutline, linkOutline, checkmarkCircle });
  }

  ionViewWillEnter(): void {
    void this.reload();
  }

  protected kcal(meal: Meal): string {
    return displayKcal(meal.kcalPerServing);
  }

  protected protein(meal: Meal): string {
    return displayProtein(meal.proteinPerServing);
  }

  protected open(meal: Meal): void {
    void this.router.navigate(['/meals', meal.id]);
  }

  protected async create(): Promise<void> {
    const meal = await this.flows.build();
    if (meal) await this.reload();
  }

  protected async importUrl(): Promise<void> {
    const meal = await this.flows.importFromUrl();
    if (meal) void this.router.navigate(['/meals', meal.id]);
  }

  private async reload(): Promise<void> {
    try {
      const { meals, pantry, products } = await this.store.ready();
      const [list, planned, stock] = await Promise.all([meals.list(), meals.plannerMeals(), pantry.stock()]);
      const needsById = new Map(planned.map((p) => [p.id, p.needs]));
      const short = new Map(list.map((m) => [m.id, shortfalls(needsById.get(m.id) ?? new Map(), stock)]));
      const names = await products.getMany([...short.values()].flat());
      this.rows.set(list.map((meal) => ({ meal, missing: (short.get(meal.id) ?? []).map((id) => names.get(id)?.name ?? '?') })));
      this.failure.set(null);
    } catch (error) {
      this.failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loaded.set(true);
    }
  }
}

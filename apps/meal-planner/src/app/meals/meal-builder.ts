/**
 * The Meal Builder (meal-planner-spec.md §10): name, eligible slots, servings, and
 * ingredient rows — each a product from the catalog, an amount, and a unit the product
 * can actually be measured in. Calories and protein per serving update as you type,
 * because that number is the reason the meal exists in this app.
 *
 * A cup of something sold by weight goes through §6 rule 3: the first time a volume
 * unit is picked for it, the density estimate is shown and must be accepted; otherwise
 * the row switches to grams.
 *
 * Dismisses with the saved `Meal` (role `saved`) or role `cancel`.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { AlertController } from '@ionic/angular/alert-controller';
import { IonButton } from '@ionic/angular/ion-button';
import { IonButtons } from '@ionic/angular/ion-buttons';
import { IonContent } from '@ionic/angular/ion-content';
import { IonFooter } from '@ionic/angular/ion-footer';
import { IonHeader } from '@ionic/angular/ion-header';
import { IonIcon } from '@ionic/angular/ion-icon';
import { IonInput } from '@ionic/angular/ion-input';
import { IonItem } from '@ionic/angular/ion-item';
import { IonLabel } from '@ionic/angular/ion-label';
import { IonList } from '@ionic/angular/ion-list';
import { IonListHeader } from '@ionic/angular/ion-list-header';
import { IonSelect } from '@ionic/angular/ion-select';
import { IonSelectOption } from '@ionic/angular/ion-select-option';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import { ModalController } from '@ionic/angular/modal-controller';
import type { MealWithIngredients } from '@metrum/meal-planner-data';
import {
  densityNote,
  displayKcal,
  displayProtein,
  entryToBase,
  entryUnitWord,
  entryUnitsFor,
  mealNutritionPerServing,
  mealProblems,
  trimNumber,
  type EntryUnit,
  type IngredientDraft,
  type Meal,
  type Product,
  type SlotType,
} from '@metrum/meal-planner-domain';
import { addIcons } from 'ionicons';
import { addOutline, closeCircleOutline, removeOutline } from 'ionicons/icons';
import { SlotChips } from '../components/slot-chips';
import { Store } from '../data/store';
import { guardDiscard } from '../shared/discard-guard';
import { eventValue, parseNumber } from '../shared/events';
import { ProductPicker } from './product-picker';

interface Row {
  readonly key: number;
  readonly product: Product | null;
  readonly amount: string;
  readonly unit: EntryUnit;
  /**
   * An existing line's text and exact stored quantity, kept until the row is touched —
   * so re-saving a meal neither rewrites "2 cups flour" nor rounds 46.728 g to 46.73.
   * Any edit clears both.
   */
  readonly displayText: string | null;
  readonly original: number | null;
  /** A to-taste or unlinked line from an existing meal: carried through as text. */
  readonly textOnly: boolean;
  readonly toTaste: boolean;
}

@Component({
  selector: 'mp-meal-builder',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonFooter,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonIcon,
    SlotChips,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './meal-builder.html',
})
export class MealBuilder implements OnInit {
  /** The meal to edit; null to build a new one. */
  readonly existing = input<MealWithIngredients | null>(null);

  private readonly modals = inject(ModalController);
  private readonly alerts = inject(AlertController);
  private readonly store = inject(Store);
  private readonly picker = inject(ProductPicker);

  protected readonly name = signal('');
  protected readonly slots = signal<SlotType[]>(['breakfast', 'lunch', 'dinner', 'snack']);
  protected readonly servings = signal(1);
  protected readonly rows = signal<Row[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly value = eventValue;
  protected readonly unitsFor = entryUnitsFor;
  protected readonly unitWord = entryUnitWord;

  private nextKey = 0;

  protected readonly drafts = computed<IngredientDraft[]>(() =>
    this.rows().map((row) => {
      if (row.textOnly) {
        return { productId: null, quantity: null, unit: null, displayText: row.displayText ?? '', toTaste: row.toTaste };
      }
      const amount = parseNumber(row.amount);
      const quantity =
        row.original !== null ? row.original : row.product && amount !== null ? entryToBase(amount, row.unit, row.product) : null;
      return {
        productId: row.product?.id ?? null,
        quantity,
        unit: row.product?.packageUnit ?? null,
        displayText: row.displayText ?? describe(row),
        toTaste: false,
      };
    }),
  );
  protected readonly perServing = computed(() => {
    const products = new Map(this.rows().flatMap((r) => (r.product ? [[r.product.id, r.product] as const] : [])));
    return mealNutritionPerServing(this.drafts(), products, this.servings());
  });
  protected readonly kcal = computed(() => displayKcal(this.perServing().kcal));
  protected readonly protein = computed(() => displayProtein(this.perServing().protein));
  protected readonly problems = computed(() =>
    mealProblems({ name: this.name(), servings: this.servings(), slots: this.slots(), ingredients: this.drafts() }),
  );

  constructor() {
    addIcons({ addOutline, removeOutline, closeCircleOutline });
    guardDiscard(() => this.baseline !== null && this.snapshot() !== this.baseline, 'this meal');
  }

  /** The form as it opened; a builder closed unchanged never asks before discarding. */
  private baseline: string | null = null;
  private snapshot(): string {
    return JSON.stringify([this.name(), this.slots(), this.servings(), this.drafts()]);
  }

  async ngOnInit(): Promise<void> {
    const existing = this.existing();
    if (!existing) {
      this.baseline = this.snapshot();
      return;
    }
    this.name.set(existing.meal.name);
    this.slots.set([...existing.meal.slots]);
    this.servings.set(existing.meal.servings);
    const { products } = await this.store.ready();
    const byId = await products.getMany(existing.ingredients.flatMap((i) => (i.productId ? [i.productId] : [])));
    this.rows.set(
      existing.ingredients.map((i) => {
        const product = i.productId ? (byId.get(i.productId) ?? null) : null;
        const textOnly = i.toTaste || !product;
        return {
          key: this.nextKey++,
          product,
          amount: i.quantity === null ? '' : trimNumber(i.quantity),
          unit: product ? baseEntryUnit(product) : 'g',
          displayText: i.displayText,
          original: textOnly ? null : i.quantity,
          textOnly,
          toTaste: i.toTaste,
        };
      }),
    );
    this.baseline = this.snapshot();
  }

  protected stepServings(delta: number): void {
    this.servings.update((n) => Math.max(1, n + delta));
  }

  protected async addRow(): Promise<void> {
    const product = await this.picker.pick();
    if (!product) return;
    this.rows.update((rows) => [
      ...rows,
      { key: this.nextKey++, product, amount: '', unit: baseEntryUnit(product), displayText: null, original: null, textOnly: false, toTaste: false },
    ]);
  }

  protected async changeProduct(row: Row): Promise<void> {
    const product = await this.picker.pick();
    if (product) this.patch(row.key, { product, unit: baseEntryUnit(product), displayText: null, original: null });
  }

  protected setAmount(row: Row, event: Event): void {
    this.patch(row.key, { amount: eventValue(event), displayText: null, original: null });
  }

  protected async setUnit(row: Row, event: Event): Promise<void> {
    const unit = eventValue(event) as EntryUnit;
    if (!row.product || unit === row.unit) return;
    const note = densityNote(unit, row.product);
    if (note) {
      const alert = await this.alerts.create({
        header: 'Measured by volume',
        message: `${note} Use that estimate?`,
        buttons: [
          { text: 'Enter grams', role: 'cancel' },
          { text: 'Use it', role: 'confirm' },
        ],
      });
      await alert.present();
      const { role } = await alert.onDidDismiss();
      if (role !== 'confirm') {
        this.patch(row.key, { unit: 'g', displayText: null, original: null });
        return;
      }
    }
    this.patch(row.key, { unit, displayText: null, original: null });
  }

  protected removeRow(row: Row): void {
    this.rows.update((rows) => rows.filter((r) => r.key !== row.key));
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }

  protected async save(): Promise<void> {
    if (this.problems().length > 0 || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const { meals } = await this.store.ready();
      const draft = { name: this.name(), servings: this.servings(), slots: this.slots(), ingredients: this.drafts() };
      const existing = this.existing();
      const saved: Meal = existing
        ? await meals.update(existing.meal.id, draft)
        : await meals.create({ ...draft, source: 'manual', sourceUrl: null });
      await this.modals.dismiss(saved, 'saved');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the meal.');
    } finally {
      this.saving.set(false);
    }
  }

  private patch(key: number, change: Partial<Row>): void {
    this.rows.update((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }
}

function baseEntryUnit(product: Product): EntryUnit {
  return product.packageUnit === 'COUNT' ? 'item' : product.packageUnit === 'G' ? 'g' : 'ml';
}

/** "2 Large eggs", "90 g Rolled oats", "0.5 cups Milk" — the row as the person entered it. */
function describe(row: Row): string {
  if (!row.product) return '';
  const amount = parseNumber(row.amount);
  if (amount === null) return row.product.name;
  if (row.unit === 'item') return `${trimNumber(amount)} ${row.product.name}`;
  return `${trimNumber(amount)} ${entryUnitWord(row.unit, amount)} ${row.product.name}`;
}

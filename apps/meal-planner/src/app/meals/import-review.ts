/**
 * The import review (meal-planner-spec.md §8 step 6, §10): every ingredient line the
 * recipe page listed, what it was read as, and which of the person's products it is.
 * Nothing is written until Save; Cancel leaves no trace.
 *
 * A line can be linked (auto or by choice), marked to taste, or left unlinked — kept as
 * text and counted as nothing. Save waits only on lines whose amount is an unconfirmed
 * estimate or missing; unlinked lines are allowed, and the footer says how many there are,
 * because a meal missing the calories of an ingredient is wrong in a way no one sees.
 *
 * When the page states its own nutrition and it is more than 25% from ours, both are shown
 * and the person picks which to trust (§8 step 6).
 *
 * Dismisses with the saved `Meal` (role `saved`) or role `cancel`.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { ActionSheetController } from '@ionic/angular/action-sheet-controller';
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
import { IonNote } from '@ionic/angular/ion-note';
import { IonSegment } from '@ionic/angular/ion-segment';
import { IonSegmentButton } from '@ionic/angular/ion-segment-button';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import { ModalController } from '@ionic/angular/modal-controller';
import {
  displayKcal,
  displayProtein,
  mealNutritionPerServing,
  mealProblems,
  nutritionDisagrees,
  type Meal,
  type Product,
  type SlotType,
} from '@metrum/meal-planner-domain';
import type { RecipeImport } from '@metrum/meal-planner-import';
import { addIcons } from 'ionicons';
import { addOutline, removeOutline } from 'ionicons/icons';
import { SlotChips } from '../components/slot-chips';
import { Store } from '../data/store';
import { guardDiscard } from '../shared/discard-guard';
import { eventValue } from '../shared/events';
import { blocking, initialLine, lineStatus, relink, toDraft, type ReviewLine } from './import-lines';
import { ProductPicker } from './product-picker';

const UNIT_WORD = { COUNT: 'items', G: 'g', ML: 'ml' } as const;

@Component({
  selector: 'mp-import-review',
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
    IonNote,
    IonIcon,
    IonSegment,
    IonSegmentButton,
    SlotChips,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-review.html',
})
export class ImportReview implements OnInit {
  readonly recipe = input.required<RecipeImport>();
  /** The catalog the lines were matched against, by id. */
  readonly products = input.required<ReadonlyMap<string, Product>>();

  private readonly modals = inject(ModalController);
  private readonly sheets = inject(ActionSheetController);
  private readonly store = inject(Store);
  private readonly picker = inject(ProductPicker);

  protected readonly name = signal('');
  protected readonly servings = signal(1);
  protected readonly slots = signal<SlotType[]>(['lunch', 'dinner']);
  protected readonly lines = signal<ReviewLine[]>([]);
  protected readonly trust = signal<'computed' | 'site'>('computed');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly value = eventValue;
  protected readonly status = lineStatus;
  protected readonly unitWord = UNIT_WORD;

  protected readonly drafts = computed(() => this.lines().map(toDraft));
  protected readonly perServing = computed(() => {
    const products = new Map(this.lines().flatMap((l) => (l.product ? [[l.product.id, l.product] as const] : [])));
    return mealNutritionPerServing(this.drafts(), products, this.servings());
  });
  protected readonly kcal = computed(() => displayKcal(this.perServing().kcal));
  protected readonly protein = computed(() => displayProtein(this.perServing().protein));
  protected readonly siteKcal = computed(() => this.recipe().siteKcal);
  protected readonly disagrees = computed(() => nutritionDisagrees(this.perServing().kcal, this.siteKcal()));
  protected readonly blockingCount = computed(() => blocking(this.lines()));
  protected readonly unlinkedCount = computed(() => this.lines().filter((l) => lineStatus(l) === 'unlinked').length);
  protected readonly canSave = computed(
    () =>
      this.blockingCount() === 0 &&
      mealProblems({ name: this.name(), servings: this.servings(), slots: this.slots(), ingredients: this.drafts() })
        .length === 0,
  );

  constructor() {
    addIcons({ addOutline, removeOutline });
    // A fetched recipe is always worth a question: losing it means importing again.
    guardDiscard(() => true, 'this import');
  }

  ngOnInit(): void {
    const recipe = this.recipe();
    this.name.set(recipe.name);
    this.servings.set(recipe.servings);
    this.lines.set(
      recipe.lines.map((source, key) =>
        initialLine(key, source, source.autoProductId ? (this.products().get(source.autoProductId) ?? null) : null),
      ),
    );
  }

  protected stepServings(delta: number): void {
    this.servings.update((n) => Math.max(1, n + delta));
  }

  protected setQuantity(line: ReviewLine, event: Event): void {
    this.patch(line.key, { quantity: eventValue(event), estimate: null });
  }

  protected confirmEstimate(line: ReviewLine): void {
    this.patch(line.key, { estimate: null });
  }

  protected productName(id: string): string {
    return this.products().get(id)?.name ?? 'Unknown product';
  }

  /** §8.2's review choices: the top five, search, create, to taste — or leave it unlinked. */
  protected async choose(line: ReviewLine): Promise<void> {
    const candidates = line.source.candidates
      .map((c) => this.products().get(c.productId))
      .filter((p): p is Product => p !== undefined);
    const sheet = await this.sheets.create({
      header: line.source.original,
      buttons: [
        ...candidates.map((p) => ({ text: p.name, data: { kind: 'product', product: p } })),
        { text: 'Search your products…', data: { kind: 'search' } },
        { text: 'Create a new product', data: { kind: 'create' } },
        { text: 'Mark as to taste', data: { kind: 'taste' } },
        { text: 'Leave unlinked', data: { kind: 'unlink' } },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<{ kind: string; product?: Product }>();
    if (!data) return;
    if (data.kind === 'product' && data.product) this.replace(relink(line, data.product));
    else if (data.kind === 'search') {
      const picked = await this.picker.pick();
      if (picked) this.replace(relink(line, picked));
    } else if (data.kind === 'create') {
      const created = await this.picker.create(
        { name: capitalize(line.source.parsed.name), packageUnit: line.source.parsed.unit ?? 'G' },
        `From the recipe: “${line.source.original}”`,
      );
      if (created) this.replace(relink(line, created));
    } else if (data.kind === 'taste') this.patch(line.key, { product: null, toTaste: true, quantity: '', estimate: null });
    else if (data.kind === 'unlink') this.patch(line.key, { product: null, toTaste: false, quantity: '', estimate: null });
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }

  protected async save(): Promise<void> {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const recipe = this.recipe();
      const site =
        this.disagrees() && this.trust() === 'site' && recipe.siteKcal !== null
          ? { kcal: recipe.siteKcal, protein: recipe.siteProtein ?? this.perServing().protein }
          : null;
      const { meals } = await this.store.ready();
      const saved: Meal = await meals.create({
        name: this.name(),
        servings: this.servings(),
        slots: this.slots(),
        source: 'import',
        sourceUrl: recipe.url,
        ingredients: this.drafts(),
        siteNutrition: site,
      });
      await this.modals.dismiss(saved, 'saved');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the meal.');
    } finally {
      this.saving.set(false);
    }
  }

  private replace(line: ReviewLine): void {
    this.lines.update((lines) => lines.map((l) => (l.key === line.key ? line : l)));
  }

  private patch(key: number, change: Partial<ReviewLine>): void {
    this.lines.update((lines) => lines.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

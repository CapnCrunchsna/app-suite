/**
 * The Today tab (meal-planner-spec.md §10): targets and slots for a date, Generate → up
 * to three cards, the chosen card as the day's plan, and per-row Pin, Swap and Mark
 * cooked.
 *
 * The planner runs on the UI thread: it is synchronous, deterministic, and measured at
 * about 130 ms on a 200-meal library (planner-performance.spec.ts), so a worker would buy
 * nothing a person could notice. What each button holds fixed is in `today-model.ts`.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
  type ViewWillEnter,
} from '@ionic/angular';
import {
  dayTotals,
  displayKcal,
  displayProtein,
  replanDay,
  type Day,
  type DayOption,
  type Meal,
  type PantryStock,
  type PlanSlot,
  type PlannerMeal,
} from '@metrum/meal-planner-domain';
import { slotsFor, type PlanWithSlots, type SlotCounts } from '@metrum/meal-planner-data';
import { addIcons } from 'ionicons';
import {
  addOutline,
  checkmarkCircle,
  checkmarkCircleOutline,
  chevronBackOutline,
  chevronForwardOutline,
  lockClosed,
  lockOpenOutline,
  removeOutline,
  swapHorizontalOutline,
} from 'ionicons/icons';
import { Store } from '../data/store';
import { eventValue, parseNumber } from '../shared/events';
import { Notify } from '../shared/notify';
import {
  SLOT_LABELS,
  addDays,
  assignmentFor,
  constraintNote,
  countsOf,
  dateLabel,
  generateDay,
  hasCooked,
  isCurrent,
  isoDate,
  sameShape,
  swapDay,
  type Targets,
} from './today-model';

@Component({
  selector: 'mp-today-page',
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonSpinner,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonNote,
    IonInput,
    IonCard,
    IonCardContent,
    IonBadge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './today-page.html',
  styleUrl: './today-page.scss',
})
export class TodayPage implements ViewWillEnter {
  private readonly store = inject(Store);
  private readonly notify = inject(Notify);

  protected readonly today = signal(isoDate(new Date()));
  protected readonly date = signal(this.today());
  protected readonly label = computed(() => dateLabel(this.date(), this.today()));

  protected readonly loaded = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly saved = signal<PlanWithSlots | null>(null);
  private readonly meals = signal<ReadonlyMap<string, Meal>>(new Map());
  private plannerMeals: readonly PlannerMeal[] = [];
  private stock: PantryStock = new Map();
  protected readonly mealCount = computed(() => this.meals().size);

  protected readonly kcalText = signal('');
  protected readonly proteinText = signal('');
  protected readonly counts = signal<SlotCounts>({ meals: 3, snacks: 1 });
  /**
   * What the inputs were last filled from: the date plus its saved plan, or the Settings
   * defaults when it has none. Re-entering the tab keeps what was typed unless that
   * changed — a new date, a plan appearing or going, or new defaults.
   */
  private inputsFrom: string | null = null;

  /** Cards on offer, and which slot they swap (null: a whole Generate). */
  protected readonly options = signal<readonly DayOption[] | null>(null);
  private level: 0 | 1 | 2 | 3 = 0;
  protected readonly swapping = signal<number | null>(null);
  /** The day the cards on offer were planned for. */
  private offered: Day | null = null;

  protected readonly value = eventValue;

  protected readonly targets = computed<Targets | null>(() => {
    const kcal = parseNumber(this.kcalText());
    const protein = parseNumber(this.proteinText());
    return kcal !== null && kcal > 0 && protein !== null && protein >= 0 ? { kcalBudget: kcal, proteinTarget: protein } : null;
  });
  private readonly slots = computed(() => slotsFor(this.counts()));
  protected readonly keepsShape = computed(() => sameShape(this.saved(), this.slots()));
  protected readonly shapeLocked = computed(() => hasCooked(this.saved()));
  protected readonly savedTotals = computed(() => {
    const byId = new Map([...this.meals()].map(([id, m]) => [id, { kcal: m.kcalPerServing, protein: m.proteinPerServing }]));
    return dayTotals(this.saved()?.slots.map((s) => s.mealId) ?? [], byId);
  });
  /** Level 3 with every open slot empty: the pantry cannot make anything. */
  protected readonly nothingMakeable = computed(() => {
    const cards = this.options();
    return this.level === 3 && cards !== null && cards.every((c) => c.plan.mealIds.every((id) => id === null));
  });

  constructor() {
    addIcons({
      chevronBackOutline,
      chevronForwardOutline,
      lockClosed,
      lockOpenOutline,
      swapHorizontalOutline,
      checkmarkCircle,
      checkmarkCircleOutline,
      addOutline,
      removeOutline,
    });
  }

  ionViewWillEnter(): void {
    // The app may have been left open overnight.
    const now = isoDate(new Date());
    if (now !== this.today()) {
      this.today.set(now);
      if (this.date() < now) this.date.set(now);
    }
    void this.reload();
  }

  protected step(days: number): void {
    this.date.set(addDays(this.date(), days));
    this.options.set(null);
    void this.reload();
  }

  protected stepCount(which: keyof SlotCounts, delta: number): void {
    this.counts.update((c) => ({ ...c, [which]: c[which] + delta }));
  }

  /** A slot's name, from the cards' day while they are shown, else from the saved plan. */
  protected slotLabel(index: number): string {
    const type = (this.options() ? this.offered?.slots : this.saved()?.slots)?.[index]?.slotType;
    return type ? SLOT_LABELS[type] : '';
  }

  protected mealName(id: string | null): string {
    return id === null ? 'Nothing fits' : (this.meals().get(id)?.name ?? 'Deleted meal');
  }

  protected mealKcal(id: string | null): string {
    const meal = id === null ? undefined : this.meals().get(id);
    return meal ? `${displayKcal(meal.kcalPerServing)} kcal` : '';
  }

  protected totals(kcal: number, protein: number): string {
    return `${displayKcal(kcal)} kcal · ${displayProtein(protein)} g protein`;
  }

  protected note(card: DayOption): string | null {
    return constraintNote(this.level, card, this.offered?.proteinTarget ?? 0);
  }

  /** Highlights, on a card, the slots it would change on a day already planned. */
  protected changed(card: DayOption, index: number): boolean {
    const saved = this.saved();
    const slots = this.offered?.slots.map((s) => s.slotType) ?? [];
    return sameShape(saved, slots) && saved.slots[index]?.mealId !== card.mealIds[index];
  }

  protected generate(): void {
    const targets = this.targets();
    if (!targets) return;
    this.swapping.set(null);
    this.offer(generateDay(targets, this.slots(), this.saved()));
  }

  protected swap(index: number): void {
    const saved = this.saved();
    if (!saved) return;
    this.swapping.set(index);
    this.offer(swapDay(saved, index));
  }

  protected async choose(card: DayOption): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { plans } = await this.store.ready();
      const saved = this.saved();
      const day = this.offered;
      if (!day) return;
      if (saved && (this.swapping() !== null || this.keepsShape())) {
        await plans.assign(assignmentFor(saved, card));
        if (saved.plan.kcalBudget !== day.kcalBudget || saved.plan.proteinTarget !== day.proteinTarget) {
          await plans.updateTargets(saved.plan.id, day);
        }
      } else {
        await plans.create(
          this.date(),
          day,
          day.slots.map((s, i) => ({ slotType: s.slotType, mealId: card.mealIds[i] ?? null, pinned: false })),
        );
      }
      this.options.set(null);
      this.swapping.set(null);
      this.saved.set(await plans.forDate(this.date()));
    } catch (error) {
      await this.notify.toast(`Saving the plan failed: ${error instanceof Error ? error.message : String(error)}`, { seconds: 4 });
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * §11: one serving out of the pantry, then 10 seconds to take it back exactly. The
   * shortfall names come from the catalog because the pantry rows may now be deleted.
   */
  protected async cook(slot: PlanSlot): Promise<void> {
    const meal = this.plannerMeals.find((m) => m.id === slot.mealId);
    if (!meal || this.busy()) return;
    this.busy.set(true);
    let undo: (() => Promise<void>) | null = null;
    let message = 'Pantry updated';
    try {
      const { plans, products } = await this.store.ready();
      const result = await plans.cook(slot.id, meal.needs);
      await this.refreshAfterPantryChange();
      if (!result) return;
      const names = await products.getMany(result.shortfalls.map((s) => s.productId));
      const short = result.shortfalls.map((s) => `${names.get(s.productId)?.name ?? 'Something'} ran short`);
      if (short.length > 0) message += ` · ${short.join(', ')}`;
      undo = async () => {
        await plans.uncook(slot.id, result.undo);
        await this.refreshAfterPantryChange();
      };
    } catch (error) {
      message = `Marking it cooked failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busy.set(false);
    }
    await this.notify.toast(message, undo ? { undo, seconds: 10 } : { seconds: 4 });
  }

  /** Cooking changes what is makeable, so the stock and the plan are re-read together. */
  private async refreshAfterPantryChange(): Promise<void> {
    const { pantry, plans } = await this.store.ready();
    const [stock, saved] = await Promise.all([pantry.stock(), plans.forDate(this.date())]);
    this.stock = stock;
    this.saved.set(saved);
  }

  protected async togglePin(slot: PlanSlot): Promise<void> {
    this.busy.set(true);
    try {
      const { plans } = await this.store.ready();
      await plans.setPinned(slot.id, !slot.pinned);
      this.saved.set(await plans.forDate(this.date()));
    } finally {
      this.busy.set(false);
    }
  }

  private offer(day: Day): void {
    const result = replanDay(day, this.plannerMeals, this.stock);
    this.offered = day;
    this.level = result.level;
    this.options.set(result.options.filter((o) => !isCurrent(this.saved(), o)));
  }

  private async reload(): Promise<void> {
    const date = this.date();
    try {
      const { meals, pantry, plans, settings } = await this.store.ready();
      const [list, planned, stock, saved, defaults] = await Promise.all([
        meals.list(),
        meals.plannerMeals(),
        pantry.stock(),
        plans.forDate(date),
        settings.read(),
      ]);
      if (date !== this.date()) return;
      this.meals.set(new Map(list.map((m) => [m.id, m])));
      this.plannerMeals = planned;
      this.stock = stock;
      this.saved.set(saved);
      const source = `${date}|${saved ? saved.plan.id : JSON.stringify(defaults)}`;
      if (this.inputsFrom !== source) {
        this.inputsFrom = source;
        this.kcalText.set(String(saved?.plan.kcalBudget ?? defaults.defaultKcalBudget));
        this.proteinText.set(String(saved?.plan.proteinTarget ?? defaults.defaultProteinTarget));
        this.counts.set(saved ? countsOf(saved) : defaults.defaultSlots);
      }
      this.failure.set(null);
    } catch (error) {
      this.failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loaded.set(true);
    }
  }
}

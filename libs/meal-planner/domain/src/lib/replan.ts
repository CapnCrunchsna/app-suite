/**
 * Planning a day that is already partly settled — §10's Swap, and Generate on a day that
 * has a plan.
 *
 * Two kinds of slot are fixed, for different reasons:
 *
 * - A **cooked** slot has been eaten. Its calories and protein come off the day's budget,
 *   and its ingredients are already out of the pantry (§11), so it must not reserve them a
 *   second time. It leaves the search entirely.
 * - A **pinned** slot has not been eaten yet: it stays in the search as a pin (§9), so its
 *   ingredients are still reserved against the meals planned around it.
 *
 * Everything else is open and gets re-planned.
 */

import type { NutritionFacts } from './nutrition.js';
import type { PantryStock } from './pantry.js';
import { generatePlans, type PlannerMeal, type PlanResult, type RankedPlan } from './planner.js';
import type { SlotType } from './types.js';

export interface DaySlot {
  readonly slotType: SlotType;
  readonly mealId: string | null;
  readonly pinned: boolean;
  readonly cooked: boolean;
}

export interface Day {
  readonly kcalBudget: number;
  readonly proteinTarget: number;
  readonly slots: readonly DaySlot[];
}

/** A candidate for the whole day: every slot's meal, cooked ones included, and day totals. */
export interface DayOption {
  readonly mealIds: readonly (string | null)[];
  readonly kcal: number;
  readonly protein: number;
  readonly plan: RankedPlan;
}

export interface Replan {
  readonly level: PlanResult['level'];
  readonly options: readonly DayOption[];
}

export function replanDay(day: Day, meals: readonly PlannerMeal[], pantry: PantryStock): Replan {
  const byId = new Map(meals.map((m) => [m.id, m]));
  const eaten = day.slots.reduce<NutritionFacts>(
    (sum, slot) => {
      const meal = slot.cooked && slot.mealId ? byId.get(slot.mealId) : undefined;
      return meal ? { kcal: sum.kcal + meal.kcal, protein: sum.protein + meal.protein } : sum;
    },
    { kcal: 0, protein: 0 },
  );

  // Positions of the slots still being planned, in the order the planner sees them.
  const open = day.slots.flatMap((slot, i) => (slot.cooked ? [] : [i]));
  const pinned = new Map<number, string>();
  open.forEach((dayIndex, i) => {
    const slot = day.slots[dayIndex];
    if (slot.pinned && slot.mealId) pinned.set(i, slot.mealId);
  });

  const result = generatePlans({
    kcalBudget: Math.max(0, day.kcalBudget - eaten.kcal),
    proteinTarget: Math.max(0, day.proteinTarget - eaten.protein),
    slots: open.map((i) => day.slots[i].slotType),
    pinned,
    meals,
    pantry,
  });

  return {
    level: result.level,
    options: result.plans.map((plan) => {
      const mealIds = day.slots.map((slot) => (slot.cooked ? slot.mealId : null));
      open.forEach((dayIndex, i) => (mealIds[dayIndex] = plan.mealIds[i] ?? null));
      return { mealIds, kcal: eaten.kcal + plan.kcal, protein: eaten.protein + plan.protein, plan };
    }),
  };
}

/** Totals of whatever is assigned, for the Today screen's summary line. */
export function dayTotals(mealIds: readonly (string | null)[], meals: ReadonlyMap<string, { readonly kcal: number; readonly protein: number }>): NutritionFacts {
  return mealIds.reduce<NutritionFacts>(
    (sum, id) => {
      const meal = id ? meals.get(id) : undefined;
      return meal ? { kcal: sum.kcal + meal.kcal, protein: sum.protein + meal.protein } : sum;
    },
    { kcal: 0, protein: 0 },
  );
}

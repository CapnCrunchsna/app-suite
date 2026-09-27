/**
 * The Today screen's decisions, kept out of the component so they can be tested without
 * Ionic: which slots a Generate or a Swap holds fixed, what a chosen card writes, and the
 * words a relaxed plan is labelled with (meal-planner-spec.md §9, §10).
 */

import type { Day, DayOption, SlotType } from '@metrum/meal-planner-domain';
import type { PlanWithSlots, SlotCounts } from '@metrum/meal-planner-data';

export interface Targets {
  readonly kcalBudget: number;
  readonly proteinTarget: number;
}

/** Whether the saved plan has exactly these slots, so choosing a card can re-assign it in place. */
export function sameShape(saved: PlanWithSlots | null, slots: readonly SlotType[]): saved is PlanWithSlots {
  return saved !== null && saved.slots.length === slots.length && saved.slots.every((s, i) => s.slotType === slots[i]);
}

export function countsOf(saved: PlanWithSlots): SlotCounts {
  const snacks = saved.slots.filter((s) => s.slotType === 'snack').length;
  return { meals: saved.slots.length - snacks, snacks };
}

export function hasCooked(saved: PlanWithSlots | null): boolean {
  return saved?.slots.some((s) => s.cookedAt !== null) ?? false;
}

/**
 * What Generate plans. On a day already planned with the same slots, its cooked and pinned
 * slots stay and the rest are re-solved (§9 "Regenerate with pins"). A different shape is a
 * new day: nothing carries over.
 */
export function generateDay(targets: Targets, slots: readonly SlotType[], saved: PlanWithSlots | null): Day {
  if (!sameShape(saved, slots)) {
    return { ...targets, slots: slots.map((slotType) => ({ slotType, mealId: null, pinned: false, cooked: false })) };
  }
  return {
    ...targets,
    slots: saved.slots.map((s) => ({
      slotType: s.slotType,
      mealId: s.mealId,
      pinned: s.pinned && s.mealId !== null,
      cooked: s.cookedAt !== null,
    })),
  };
}

/**
 * A row's Swap: a different meal for that one slot, everything already placed held where
 * it is. Slots left empty by a partial plan are re-solved too, since nothing holds them.
 */
export function swapDay(saved: PlanWithSlots, index: number): Day {
  return {
    kcalBudget: saved.plan.kcalBudget,
    proteinTarget: saved.plan.proteinTarget,
    slots: saved.slots.map((s, i) => ({
      slotType: s.slotType,
      mealId: i === index ? null : s.mealId,
      pinned: i !== index && s.mealId !== null,
      cooked: s.cookedAt !== null,
    })),
  };
}

/** The option that is what the day already has — not worth offering as a choice. */
export function isCurrent(saved: PlanWithSlots | null, option: DayOption): boolean {
  return saved !== null && saved.slots.length === option.mealIds.length && saved.slots.every((s, i) => s.mealId === option.mealIds[i]);
}

/** Slot id → new meal, for the slots a chosen card changes. Cooked slots are never in it. */
export function assignmentFor(saved: PlanWithSlots, option: DayOption): Map<string, string | null> {
  const out = new Map<string, string | null>();
  saved.slots.forEach((s, i) => {
    const mealId = option.mealIds[i] ?? null;
    if (s.cookedAt === null && s.mealId !== mealId) out.set(s.id, mealId);
  });
  return out;
}

/**
 * §10's label for a card from a relaxed level; null at level 0. Level 2 drops the protein
 * floor, so its card says by how much it misses — or, when this plan happens not to miss,
 * only that calories were relaxed.
 */
export function constraintNote(level: 0 | 1 | 2 | 3, option: DayOption, proteinTarget: number): string | null {
  switch (level) {
    case 0:
      return null;
    case 1:
      return 'relaxed calories';
    case 2: {
      const short = Math.round(proteinTarget - option.protein);
      return short > 0 ? `protein short by ${short} g` : 'relaxed calories';
    }
    case 3:
      return option.plan.partial ? 'partial' : 'best effort';
  }
}

/** `YYYY-MM-DD` in local time: a plan is for the day the person is living, not UTC's. */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

export function dateLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export const SLOT_LABELS: Readonly<Record<SlotType, string>> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

/**
 * What a meal needs before it can be saved (meal-planner-spec.md §10 Meal Builder:
 * "Save disabled until name + ≥ 1 mapped ingredient"), shared by the builder, the import
 * review and the repository so the three cannot disagree.
 */

import type { BaseUnit, MealSource, SlotType } from './types.js';

export interface IngredientDraft {
  readonly productId: string | null;
  /** For the whole recipe, in `unit`. */
  readonly quantity: number | null;
  readonly unit: BaseUnit | null;
  readonly displayText: string;
  readonly toTaste: boolean;
}

export interface MealDraft {
  readonly name: string;
  readonly servings: number;
  readonly slots: readonly SlotType[];
  readonly source: MealSource;
  readonly sourceUrl: string | null;
  readonly ingredients: readonly IngredientDraft[];
  /**
   * §8 step 6: when a recipe site's per-serving nutrition disagrees with the computed one
   * and the person trusts the site, these are stored instead — and kept when a product's
   * nutrition later changes.
   */
  readonly siteNutrition?: { readonly kcal: number; readonly protein: number } | null;
}

export type MealProblem = 'name' | 'servings' | 'slots' | 'ingredients';

/** A line that counts: mapped to a product, with a positive quantity, not to taste. */
export function isMappedIngredient(line: IngredientDraft): boolean {
  return !line.toTaste && line.productId !== null && line.quantity !== null && line.quantity > 0;
}

export function mealProblems(draft: Pick<MealDraft, 'name' | 'servings' | 'slots' | 'ingredients'>): MealProblem[] {
  const problems: MealProblem[] = [];
  if (draft.name.trim().length === 0) problems.push('name');
  if (!(Number.isFinite(draft.servings) && draft.servings > 0)) problems.push('servings');
  if (draft.slots.length === 0) problems.push('slots');
  if (!draft.ingredients.some(isMappedIngredient)) problems.push('ingredients');
  return problems;
}

/** §8 step 6's threshold: site and computed kcal more than 25% apart. */
export function nutritionDisagrees(computedKcal: number, siteKcal: number | null): boolean {
  if (siteKcal === null) return false;
  const larger = Math.max(computedKcal, siteKcal);
  return larger > 0 && Math.abs(computedKcal - siteKcal) / larger > 0.25;
}

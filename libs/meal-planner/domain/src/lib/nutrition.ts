/**
 * meal-planner-spec.md §4, exactly.
 *
 * Values are returned unrounded. Rounding is a display concern (whole kcal, protein to
 * one decimal) and happens only where a number meets a person; the planner compares
 * these sums against budgets, and a sum of rounded parts drifts from the rounded sum.
 */

import type { MealIngredient, Product } from './types.js';

export interface NutritionFacts {
  readonly kcal: number;
  readonly protein: number;
}

export type NutritionProduct = Pick<Product, 'nutritionBasis' | 'kcal' | 'proteinG'>;
export type NutritionIngredient = Pick<MealIngredient, 'productId' | 'quantity' | 'toTaste'>;

export const ZERO_NUTRITION: NutritionFacts = { kcal: 0, protein: 0 };

/**
 * One ingredient line's contribution. A to-taste line, an unmapped line, or a product
 * the caller could not find contributes nothing — the salt in a recipe is not what
 * decides whether it fits a calorie budget.
 */
export function ingredientNutrition(
  ingredient: NutritionIngredient,
  product: NutritionProduct | undefined,
): NutritionFacts {
  if (ingredient.toTaste || ingredient.productId === null || ingredient.quantity === null) {
    return ZERO_NUTRITION;
  }
  if (!product) return ZERO_NUTRITION;
  const factor = product.nutritionBasis === 'PER_UNIT' ? ingredient.quantity : ingredient.quantity / 100;
  return { kcal: factor * (product.kcal ?? 0), protein: factor * (product.proteinG ?? 0) };
}

/** Sum over the ingredients, divided by `servings`. */
export function mealNutritionPerServing(
  ingredients: readonly NutritionIngredient[],
  products: ReadonlyMap<string, NutritionProduct>,
  servings: number,
): NutritionFacts {
  let kcal = 0;
  let protein = 0;
  for (const ingredient of ingredients) {
    const facts = ingredientNutrition(
      ingredient,
      ingredient.productId === null ? undefined : products.get(ingredient.productId),
    );
    kcal += facts.kcal;
    protein += facts.protein;
  }
  const divisor = servings > 0 ? servings : 1;
  return { kcal: kcal / divisor, protein: protein / divisor };
}

/** Whole kcal, as §4 displays them. */
export function displayKcal(kcal: number): string {
  return String(Math.round(kcal));
}

/** Protein to one decimal, as §4 displays it; a whole number drops its ".0". */
export function displayProtein(protein: number): string {
  const rounded = Math.round(protein * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

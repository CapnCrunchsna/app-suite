/**
 * meal-planner-spec.md §5: what the pantry can make.
 *
 * Ingredient quantities are for the whole recipe; planning consumes exactly one serving
 * per slot, so a meal's *need* is `quantity / servings`. A plan is feasible only if the
 * summed needs of all its meals fit together — two meals that each need two of the three
 * eggs are each makeable and never both (§14 T7).
 */

import type { MealIngredient, PantryItem } from './types.js';

/** Total live quantity per product id, in each product's base unit. */
export type PantryStock = ReadonlyMap<string, number>;

/** One serving's draw on the pantry, per product id. */
export type ServingNeeds = ReadonlyMap<string, number>;

/** Float slack for comparisons of summed quantities; far below any real portion. */
const EPS = 1e-9;

export function pantryStock(
  items: readonly Pick<PantryItem, 'productId' | 'quantity' | 'deletedAt'>[],
): Map<string, number> {
  const stock = new Map<string, number>();
  for (const item of items) {
    if (item.deletedAt !== null || item.quantity <= 0) continue;
    stock.set(item.productId, (stock.get(item.productId) ?? 0) + item.quantity);
  }
  return stock;
}

/**
 * Per-serving needs. To-taste and unmapped lines are excluded (§5), and two lines naming
 * the same product add up — a recipe with butter in the sauce and butter on top needs both.
 */
export function perServingNeeds(
  ingredients: readonly Pick<MealIngredient, 'productId' | 'quantity' | 'toTaste'>[],
  servings: number,
): Map<string, number> {
  const divisor = servings > 0 ? servings : 1;
  const needs = new Map<string, number>();
  for (const ingredient of ingredients) {
    if (ingredient.toTaste || ingredient.productId === null || ingredient.quantity === null) continue;
    if (ingredient.quantity <= 0) continue;
    needs.set(ingredient.productId, (needs.get(ingredient.productId) ?? 0) + ingredient.quantity / divisor);
  }
  return needs;
}

/** Product ids whose stock falls short of one serving's need. Empty means makeable. */
export function shortfalls(needs: ServingNeeds, stock: PantryStock): string[] {
  const short: string[] = [];
  for (const [productId, need] of needs) {
    if ((stock.get(productId) ?? 0) + EPS < need) short.push(productId);
  }
  return short;
}

export function isMakeable(needs: ServingNeeds, stock: PantryStock): boolean {
  return shortfalls(needs, stock).length === 0;
}

/**
 * Whether `needs` fits on top of what is already `reserved`. The planner's search keeps
 * one reservation map per branch; this is the check it makes before placing a meal.
 */
export function fitsWithReserved(needs: ServingNeeds, reserved: ReadonlyMap<string, number>, stock: PantryStock): boolean {
  for (const [productId, need] of needs) {
    if ((reserved.get(productId) ?? 0) + need > (stock.get(productId) ?? 0) + EPS) return false;
  }
  return true;
}

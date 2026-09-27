/**
 * The entities of meal-planner-spec.md §3, as the app sees them.
 *
 * Every quantity is in a base unit — `COUNT`, `G` or `ML` — and nothing else is ever
 * stored (§3's base-unit rule, §13.4). Cups and ounces exist only at the input boundary
 * (`units.ts`) and in `MealIngredient.displayText`, which echoes what the person typed.
 *
 * Soft deletes are the rule (§2): a row is never removed, only stamped `deletedAt`, so a
 * future sync can tell "deleted" from "never existed".
 */

export type BaseUnit = 'COUNT' | 'G' | 'ML';
export type NutritionBasis = 'PER_100' | 'PER_UNIT';
export type SlotType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type ProductSource = 'off' | 'usda' | 'manual' | 'seed';
export type MealSource = 'manual' | 'import' | 'seed';

export const SLOT_TYPES: readonly SlotType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export interface Product {
  readonly id: string;
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly packageUnit: BaseUnit;
  /** One package, in `packageUnit`: 12 (eggs), 500 (g), 2000 (ml). */
  readonly packageAmount: number;
  readonly nutritionBasis: NutritionBasis;
  /** Per 100 g/ml, or per single unit — whichever `nutritionBasis` says. */
  readonly kcal: number | null;
  readonly proteinG: number | null;
  readonly source: ProductSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface PantryItem {
  readonly id: string;
  readonly productId: string;
  /** In the product's base unit. */
  readonly quantity: number;
  /** `YYYY-MM-DD`. Stored in v1 and used only to order depletion (§11). */
  readonly expiresOn: string | null;
  readonly acquiredAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface Meal {
  readonly id: string;
  readonly name: string;
  /** How many servings the ingredient list yields. Planning consumes one (§5). */
  readonly servings: number;
  readonly slots: readonly SlotType[];
  readonly source: MealSource;
  readonly sourceUrl: string | null;
  /** Cached from the ingredients (§4); recomputed whenever they change. */
  readonly kcalPerServing: number;
  readonly proteinPerServing: number;
  /** `site` when the person chose a recipe page's figures over the computed ones (§8 step 6). */
  readonly nutritionSource: 'ingredients' | 'site';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface MealIngredient {
  readonly id: string;
  readonly mealId: string;
  /** Null for an unmapped or to-taste line. */
  readonly productId: string | null;
  /** For the whole recipe, in `unit`. Null when `toTaste`. */
  readonly quantity: number | null;
  readonly unit: BaseUnit | null;
  /** What the person (or the recipe page) wrote: "2 cups flour". */
  readonly displayText: string;
  /** Excluded from nutrition and from feasibility (§4, §5). */
  readonly toTaste: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface Plan {
  readonly id: string;
  /** `YYYY-MM-DD`; one live plan per date. */
  readonly planDate: string;
  readonly kcalBudget: number;
  readonly proteinTarget: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface PlanSlot {
  readonly id: string;
  readonly planId: string;
  readonly slotType: SlotType;
  readonly position: number;
  readonly mealId: string | null;
  readonly pinned: boolean;
  readonly cookedAt: string | null;
  readonly updatedAt: string;
}

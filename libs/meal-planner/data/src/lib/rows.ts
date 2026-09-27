/**
 * Row shapes as SQLite returns them, and their mapping to the domain entities.
 *
 * SQLite has no boolean, so flags come back as 0/1; `slots` is a JSON array in a TEXT
 * column (§3). Both conversions live here and nowhere else.
 */

import type {
  BaseUnit,
  Meal,
  MealIngredient,
  MealSource,
  NutritionBasis,
  PantryItem,
  Plan,
  PlanSlot,
  Product,
  ProductSource,
  SlotType,
} from '@metrum/meal-planner-domain';

export interface ProductRow {
  id: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  package_unit: BaseUnit;
  package_amount: number;
  nutrition_basis: NutritionBasis;
  kcal: number | null;
  protein_g: number | null;
  source: ProductSource;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    packageUnit: row.package_unit,
    packageAmount: row.package_amount,
    nutritionBasis: row.nutrition_basis,
    kcal: row.kcal,
    proteinG: row.protein_g,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface PantryItemRow {
  id: string;
  product_id: string;
  quantity: number;
  expires_on: string | null;
  acquired_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toPantryItem(row: PantryItemRow): PantryItem {
  return {
    id: row.id,
    productId: row.product_id,
    quantity: row.quantity,
    expiresOn: row.expires_on,
    acquiredAt: row.acquired_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface MealRow {
  id: string;
  name: string;
  servings: number;
  slots: string;
  source: MealSource;
  source_url: string | null;
  kcal_per_serving: number;
  protein_per_serving: number;
  nutrition_source: 'ingredients' | 'site';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toMeal(row: MealRow): Meal {
  return {
    id: row.id,
    name: row.name,
    servings: row.servings,
    slots: parseSlots(row.slots),
    source: row.source,
    sourceUrl: row.source_url,
    kcalPerServing: row.kcal_per_serving,
    proteinPerServing: row.protein_per_serving,
    nutritionSource: row.nutrition_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

const SLOT_SET = new Set<string>(['breakfast', 'lunch', 'dinner', 'snack']);

function parseSlots(json: string): SlotType[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is SlotType => typeof s === 'string' && SLOT_SET.has(s)) : [];
  } catch {
    return [];
  }
}

export interface MealIngredientRow {
  id: string;
  meal_id: string;
  product_id: string | null;
  quantity: number | null;
  unit: BaseUnit | null;
  display_text: string;
  to_taste: number;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toMealIngredient(row: MealIngredientRow): MealIngredient {
  return {
    id: row.id,
    mealId: row.meal_id,
    productId: row.product_id,
    quantity: row.quantity,
    unit: row.unit,
    displayText: row.display_text,
    toTaste: row.to_taste === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface PlanRow {
  id: string;
  plan_date: string;
  kcal_budget: number;
  protein_target: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    planDate: row.plan_date,
    kcalBudget: row.kcal_budget,
    proteinTarget: row.protein_target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface PlanSlotRow {
  id: string;
  plan_id: string;
  slot_type: SlotType;
  position: number;
  meal_id: string | null;
  pinned: number;
  cooked_at: string | null;
  updated_at: string;
}

export function toPlanSlot(row: PlanSlotRow): PlanSlot {
  return {
    id: row.id,
    planId: row.plan_id,
    slotType: row.slot_type,
    position: row.position,
    mealId: row.meal_id,
    pinned: row.pinned === 1,
    cookedAt: row.cooked_at,
    updatedAt: row.updated_at,
  };
}

/** `?, ?, ?` for an IN list. */
export function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

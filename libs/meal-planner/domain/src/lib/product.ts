/**
 * What makes a product row usable (meal-planner-spec.md §3, §4).
 *
 * The nutrition basis is not a choice: it follows from the unit. §4 allows `PER_UNIT`
 * only for `COUNT` products, and a `COUNT` product has no weight to take "per 100 g" of —
 * so eggs are kcal per egg and flour is kcal per 100 g, always. The product form never
 * asks, and this module is the one place the rule is written down.
 */

import type { BaseUnit, NutritionBasis, Product, ProductSource } from './types.js';

export function basisFor(unit: BaseUnit): NutritionBasis {
  return unit === 'COUNT' ? 'PER_UNIT' : 'PER_100';
}

/** Everything a person (or Open Food Facts) supplies; ids and timestamps are the repository's. */
export interface ProductDraft {
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly packageUnit: BaseUnit;
  readonly packageAmount: number;
  readonly kcal: number | null;
  readonly proteinG: number | null;
  readonly source: ProductSource;
}

export type ProductProblem = 'name' | 'packageAmount' | 'kcal' | 'proteinG';

/** Which fields stop a draft from being saved. Empty means it can be saved. */
export function productProblems(draft: Pick<ProductDraft, 'name' | 'packageAmount' | 'kcal' | 'proteinG'>): ProductProblem[] {
  const problems: ProductProblem[] = [];
  if (draft.name.trim().length === 0) problems.push('name');
  if (!(Number.isFinite(draft.packageAmount) && draft.packageAmount > 0)) problems.push('packageAmount');
  if (draft.kcal !== null && !(Number.isFinite(draft.kcal) && draft.kcal >= 0)) problems.push('kcal');
  if (draft.proteinG !== null && !(Number.isFinite(draft.proteinG) && draft.proteinG >= 0)) problems.push('proteinG');
  return problems;
}

/** The brand, unless the name already says it ("Nutella" by Nutella) — then null. */
export function distinctBrand(product: Pick<Product, 'name' | 'brand'>): string | null {
  const brand = product.brand?.trim();
  if (!brand) return null;
  return product.name.toLowerCase().includes(brand.toLowerCase()) ? null : brand;
}

/** "Eggs" or "Eggs · Kirkland" — how a product is named in a list. */
export function productLabel(product: Pick<Product, 'name' | 'brand'>): string {
  const brand = distinctBrand(product);
  return brand ? `${product.name} · ${brand}` : product.name;
}

/** The nutrition label the product form shows beside its kcal field. */
export function nutritionUnitLabel(unit: BaseUnit): string {
  if (unit === 'COUNT') return 'per item';
  return unit === 'G' ? 'per 100 g' : 'per 100 ml';
}

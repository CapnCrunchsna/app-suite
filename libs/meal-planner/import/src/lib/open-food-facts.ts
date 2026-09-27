/**
 * Barcode → product prefill, from Open Food Facts (meal-planner-spec.md §7 step 3).
 *
 * The result is a *prefill*, never a saved product: the person reviews it in the product
 * form, because OFF entries are volunteer data and a wrong package size or a missing kcal
 * is common. Three outcomes, kept apart because the app says different things for each:
 * found, not in the database (so add it by hand), and could not ask (offline — also by
 * hand, but the wording should not claim the product is unknown).
 *
 * ## Nutrition per unit versus per 100
 *
 * OFF reports per 100 g/ml. That fits `G` and `ML` products as-is. A `COUNT` product
 * cannot use a per-100 figure (spec §4, `basisFor`), so for one the per-serving values
 * are used when OFF has them — for a carton of eggs the serving is usually one egg — and
 * left blank otherwise, for the person to fill.
 */

import type { BaseUnit, ProductSource } from '@metrum/meal-planner-domain';
import { describeFailure, type HttpGet } from './http.js';
import { parsePackageQuantity } from './package-quantity.js';

export const OFF_FIELDS = 'product_name,brands,quantity,serving_size,nutriments';

/** A product form's starting values. Nullable where the source may not know. */
export interface ProductPrefill {
  readonly barcode: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly packageUnit: BaseUnit | null;
  readonly packageAmount: number | null;
  readonly kcal: number | null;
  readonly proteinG: number | null;
  readonly source: ProductSource;
}

export type OffLookup =
  | { readonly kind: 'found'; readonly prefill: ProductPrefill }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export function offProductUrl(barcode: string): string {
  return `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}?fields=${OFF_FIELDS}`;
}

interface OffResponse {
  status?: number;
  product?: {
    product_name?: string;
    brands?: string;
    quantity?: string;
    nutriments?: Record<string, number | string | undefined>;
  };
}

export async function lookupOpenFoodFacts(
  http: HttpGet,
  barcode: string,
  headers?: Readonly<Record<string, string>>,
): Promise<OffLookup> {
  let response;
  try {
    response = await http(offProductUrl(barcode), headers);
  } catch (error) {
    return { kind: 'unreachable', reason: describeFailure(error) };
  }
  if (response.status === 404) return { kind: 'not-found' };
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `Open Food Facts answered ${response.status}` };
  }

  let body: OffResponse;
  try {
    body = JSON.parse(response.body) as OffResponse;
  } catch {
    return { kind: 'unreachable', reason: 'Open Food Facts sent something that was not JSON' };
  }
  if (body.status !== 1 || !body.product) return { kind: 'not-found' };
  return { kind: 'found', prefill: prefillFromOff(barcode, body.product) };
}

function prefillFromOff(barcode: string, product: NonNullable<OffResponse['product']>): ProductPrefill {
  const size = parsePackageQuantity(product.quantity);
  const n = product.nutriments ?? {};
  const perUnit = size?.unit === 'COUNT';

  const kcal = perUnit ? num(n['energy-kcal_serving']) : (num(n['energy-kcal_100g']) ?? kjToKcal(num(n['energy-kj_100g'])));
  const proteinG = perUnit ? num(n['proteins_serving']) : num(n['proteins_100g']);

  return {
    barcode,
    name: (product.product_name ?? '').trim(),
    brand: product.brands?.split(',')[0]?.trim() || null,
    packageUnit: size?.unit ?? null,
    packageAmount: size?.amount ?? null,
    kcal: kcal === null ? null : round1(kcal),
    proteinG: proteinG === null ? null : round1(proteinG),
    source: 'off',
  };
}

function num(value: number | string | undefined): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

function kjToKcal(kj: number | null): number | null {
  return kj === null ? null : kj / 4.184;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

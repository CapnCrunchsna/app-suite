/**
 * Generic food search on USDA FoodData Central (meal-planner-spec.md §7), used only when
 * the person has put their own API key in Settings.
 *
 * Results are prefills, like Open Food Facts': per 100 g, with no package size — USDA
 * describes foods, not packages — so the product form asks for one before saving.
 *
 * ## Which energy figure
 *
 * §7 names nutrient 1008 (Energy, kcal). Foundation Foods often omit it and carry the
 * Atwater figures instead (2048 specific, 2047 general), so those are the fallbacks, in
 * that order. A food with none of them comes back with kcal blank for the person to fill.
 */

import { describeFailure, type HttpGet } from './http.js';
import type { ProductPrefill } from './open-food-facts.js';

const ENERGY_IDS = [1008, 2048, 2047] as const;
const PROTEIN_ID = 1003;

export type UsdaSearch =
  | { readonly kind: 'found'; readonly foods: readonly ProductPrefill[] }
  | { readonly kind: 'unreachable'; readonly reason: string };

export function usdaSearchUrl(apiKey: string, query: string): string {
  return `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&pageSize=10`;
}

interface UsdaFood {
  description?: string;
  brandOwner?: string;
  brandName?: string;
  foodNutrients?: { nutrientId?: number; value?: number; unitName?: string }[];
}

export async function searchUsda(http: HttpGet, apiKey: string, query: string): Promise<UsdaSearch> {
  let response;
  try {
    response = await http(usdaSearchUrl(apiKey, query));
  } catch (error) {
    return { kind: 'unreachable', reason: describeFailure(error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'unreachable', reason: 'USDA refused the API key. Check it in Settings.' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `USDA answered ${response.status}` };
  }
  let body: { foods?: UsdaFood[] };
  try {
    body = JSON.parse(response.body) as { foods?: UsdaFood[] };
  } catch {
    return { kind: 'unreachable', reason: 'USDA sent something that was not JSON' };
  }
  return { kind: 'found', foods: (body.foods ?? []).filter((f) => f.description?.trim()).map(prefillFromUsda) };
}

function prefillFromUsda(food: UsdaFood): ProductPrefill {
  const byId = new Map((food.foodNutrients ?? []).map((n) => [n.nutrientId, n]));
  const energy = ENERGY_IDS.map((id) => byId.get(id)).find((n) => n && valid(n.value) && n.unitName?.toUpperCase() !== 'KJ');
  const protein = byId.get(PROTEIN_ID);
  return {
    barcode: null,
    name: tidyName(food.description ?? ''),
    brand: (food.brandName ?? food.brandOwner)?.trim() || null,
    packageUnit: 'G',
    packageAmount: null,
    kcal: energy && valid(energy.value) ? round1(energy.value) : null,
    proteinG: protein && valid(protein.value) ? round1(protein.value) : null,
    source: 'usda',
  };
}

/** USDA shouts some descriptions ("OATS, ROLLED"); sentence case reads better in a pantry. */
function tidyName(description: string): string {
  const trimmed = description.trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function valid(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

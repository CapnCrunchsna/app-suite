/**
 * The recipe URL pipeline up to the review screen (meal-planner-spec.md §8 steps 1–5):
 * fetch, extract, parse every line, rank the person's products for every line.
 *
 * It saves nothing. The result is a draft the review screen walks through line by line,
 * and nothing is written until the person confirms (§8 step 6).
 */

import { describeFailure, type HttpGet } from './http.js';
import { parseIngredient, type ParsedIngredient } from './ingredient-parser.js';
import { autoMatch, rankProducts, type MatchCandidate } from './matcher.js';
import { extractRecipe } from './recipe-jsonld.js';

export interface ImportedLine {
  /** The line exactly as the page gave it; becomes the ingredient's `display_text`. */
  readonly original: string;
  readonly parsed: ParsedIngredient;
  /** Up to five, best first (§8.2's review list). */
  readonly candidates: readonly MatchCandidate[];
  /** Set when §8.2's auto-map rule is met. */
  readonly autoProductId: string | null;
}

export interface RecipeImport {
  readonly url: string;
  readonly name: string;
  readonly servings: number;
  readonly lines: readonly ImportedLine[];
  readonly siteKcal: number | null;
  readonly siteProtein: number | null;
}

export class RecipeImportError extends Error {}

export const REVIEW_CANDIDATES = 5;

export async function importRecipe(
  http: HttpGet,
  url: string,
  products: readonly { readonly id: string; readonly name: string }[],
): Promise<RecipeImport> {
  let response;
  try {
    response = await http(url);
  } catch (error) {
    throw new RecipeImportError(`Could not load the page: ${describeFailure(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    // Several large recipe sites refuse any client that is not a full browser.
    throw new RecipeImportError(`This site refused the request (${response.status}). Recipes from other sites may still import.`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new RecipeImportError(`The page answered ${response.status}`);
  }
  const recipe = extractRecipe(response.body);
  return {
    url,
    name: recipe.name,
    servings: recipe.servings,
    siteKcal: recipe.kcal,
    siteProtein: recipe.protein,
    lines: recipe.ingredients.map((original) => lineFor(original, products)),
  };
}

export function lineFor(original: string, products: readonly { readonly id: string; readonly name: string }[]): ImportedLine {
  const parsed = parseIngredient(original);
  const ranked = parsed.name ? rankProducts(parsed.name, products) : [];
  return {
    original,
    parsed,
    candidates: ranked.slice(0, REVIEW_CANDIDATES),
    autoProductId: parsed.toTaste ? null : autoMatch(ranked),
  };
}

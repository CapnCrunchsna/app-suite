/**
 * A recipe from a web page's `schema.org/Recipe` JSON-LD (meal-planner-spec.md §8 steps
 * 2–3). Most recipe sites embed it for search engines, which is what makes URL import
 * deterministic: read JSON, no scraping and no language model.
 *
 * No HTML parser: the blocks are found with a pattern on the `<script>` tag, which runs
 * the same in Node (the tests) and in a phone's webview. A block that fails to parse is
 * skipped rather than fatal — pages routinely carry several, and one malformed analytics
 * blob should not hide the recipe beside it. v1 does not fall back to scraping the page.
 */

export interface RecipeData {
  readonly name: string;
  /** Servings the ingredient list makes: the first integer in `recipeYield`, else 1. */
  readonly servings: number;
  readonly ingredients: readonly string[];
  /** Per serving, as the site states it; null when absent. */
  readonly kcal: number | null;
  readonly protein: number | null;
}

export const NO_RECIPE_MESSAGE = 'No recipe found on this page';

export class NoRecipeError extends Error {
  constructor() {
    super(NO_RECIPE_MESSAGE);
  }
}

const LD_JSON = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function extractRecipe(html: string): RecipeData {
  for (const match of html.matchAll(LD_JSON)) {
    let parsed: Json;
    try {
      parsed = JSON.parse(match[1].trim()) as Json;
    } catch {
      continue;
    }
    const recipe = findRecipe(parsed);
    if (recipe) return toRecipe(recipe);
  }
  throw new NoRecipeError();
}

function isRecipe(node: { [key: string]: Json }): boolean {
  const type = node['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

/** Depth-first through arrays and `@graph` wrappers, first Recipe wins. */
function findRecipe(node: Json): { [key: string]: Json } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRecipe(child);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  if (isRecipe(node)) return node;
  const graph = node['@graph'];
  return graph === undefined ? null : findRecipe(graph);
}

function toRecipe(node: { [key: string]: Json }): RecipeData {
  const nutrition = node['nutrition'];
  const nutritionObj = nutrition && typeof nutrition === 'object' && !Array.isArray(nutrition) ? nutrition : {};
  const rawIngredients = node['recipeIngredient'] ?? node['ingredients'];
  return {
    name: decodeEntities(asText(node['name'])).trim() || 'Imported recipe',
    servings: firstInteger(node['recipeYield']) ?? 1,
    ingredients: (Array.isArray(rawIngredients) ? rawIngredients : [])
      .map((line) => decodeEntities(asText(line)).trim())
      .filter((line) => line.length > 0),
    kcal: firstNumber(nutritionObj['calories']),
    protein: firstNumber(nutritionObj['proteinContent']),
  };
}

function asText(value: Json | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(asText).join(' ');
  if (typeof value === 'object') return asText(value['name'] ?? value['text'] ?? null);
  return String(value);
}

function firstInteger(value: Json | undefined): number | null {
  const m = /\d+/.exec(asText(value));
  const n = m ? Number(m[0]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function firstNumber(value: Json | undefined): number | null {
  const m = /\d+(?:\.\d+)?/.exec(asText(value).replace(/(\d),(\d{3})/g, '$1$2'));
  return m ? Number(m[0]) : null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  frac13: '⅓',
  frac23: '⅔',
  frac18: '⅛',
  deg: '°',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Recipe plugins often HTML-escape text inside the JSON; undo the common cases. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Ingredient name → one of the person's products (meal-planner-spec.md §8.2).
 *
 * Jaccard similarity of token sets, after dropping words that describe preparation
 * rather than the food ("shredded", "chopped", "large"). Auto-mapping needs both a good
 * score and a clear lead over the runner-up: "cheddar cheese" against a block of cheddar
 * and a bag of mozzarella is an answer, against two cheddars it is a question, and a
 * question goes to the review screen.
 *
 * One stemming rule on top of the spec's tokenizer: a trailing "s" is dropped, on both
 * sides, from words longer than three letters that do not end in "ss". Without it "eggs"
 * never meets a product called "Egg", and the misses land on exactly the staples a recipe
 * uses most.
 */

export const MATCH_STOPWORDS: ReadonlySet<string> = new Set([
  'fresh',
  'large',
  'small',
  'medium',
  'chopped',
  'diced',
  'shredded',
  'sliced',
  'minced',
  'drained',
  'rinsed',
  'cooked',
  'raw',
  'of',
  'the',
  'a',
  'an',
]);

export const AUTO_MAP_MIN_SCORE = 0.5;
export const AUTO_MAP_MIN_LEAD = 0.2;

export interface MatchCandidate {
  readonly productId: string;
  readonly score: number;
}

export function matchTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !MATCH_STOPWORDS.has(t))
      .map(stem),
  );
}

function stem(token: string): string {
  return token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Every product with a score above zero, best first; ties keep the products' order. */
export function rankProducts(
  ingredientName: string,
  products: readonly { readonly id: string; readonly name: string }[],
): MatchCandidate[] {
  const wanted = matchTokens(ingredientName);
  return products
    .map((p, order) => ({ productId: p.id, score: jaccard(wanted, matchTokens(p.name)), order }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ productId, score }) => ({ productId, score }));
}

/** The product to map to without asking, or null when the answer is not clear enough. */
export function autoMatch(ranked: readonly MatchCandidate[]): string | null {
  const [top, second] = ranked;
  if (!top || top.score < AUTO_MAP_MIN_SCORE) return null;
  if (top.score - (second?.score ?? 0) < AUTO_MAP_MIN_LEAD) return null;
  return top.productId;
}

/**
 * Stage 6 — alias lookup (§4.1), and the precedence rules from §4.3.
 *
 * "Exact match on `alias_key` first, then prefix, then trigram fuzzy match above a
 * similarity floor. A hit resolves to a canonical merchant and stops."
 */

export type AliasMatchType = 'exact' | 'prefix' | 'fuzzy';

/** §4.3 precedence, highest first: `user` → `seed` → `rule` → `llm`. */
export type AliasSource = 'seed' | 'rule' | 'llm' | 'user';

export interface MerchantAlias {
  readonly aliasKey: string;
  readonly merchantId: string;
  readonly matchType: AliasMatchType;
  readonly confidence: number;
  readonly source: AliasSource;
}

/**
 * §4.3: "A user correction is permanent and beats everything, including a later re-run
 * with a better model."
 *
 * Source dominates match type. A `user` prefix alias therefore beats a `seed` exact
 * alias — which is the point: the user has already told this app it was wrong once, and
 * the app is not entitled to decide the seed data knows better.
 */
export const SOURCE_RANK: Readonly<Record<AliasSource, number>> = {
  user: 0,
  seed: 1,
  rule: 2,
  llm: 3,
};

/** §4.3: "Within a source, [...] match type order (exact → prefix → fuzzy) decide[s]." */
export const MATCH_TYPE_RANK: Readonly<Record<AliasMatchType, number>> = {
  exact: 0,
  prefix: 1,
  fuzzy: 2,
};

/**
 * Trigram similarity below which a fuzzy alias is not a match.
 *
 * **Uncalibrated** (§7.6). Set high on purpose: a wrong fuzzy merge is close to
 * invisible — it silently combines two merchants, and every §5 rule groups by merchant,
 * so the error surfaces as a confident-looking wrong finding rather than as an error. A
 * missed match just leaves a provisional merchant in the review queue, which is
 * visible and one click to fix. When the asymmetry is that steep, the floor belongs on
 * the conservative side until real statements say otherwise.
 *
 * Worth knowing before tuning it: this catches *truncation and decoration*, which is
 * how statement descriptors actually vary, not typos. `BLUE BOTTLE COFFE` against
 * `BLUE BOTTLE COFFEE` scores ~0.85; `STARBUKS` against `STARBUCKS` scores ~0.58,
 * because on a short string one wrong character costs a large share of the trigrams.
 */
export const FUZZY_SIMILARITY_FLOOR = 0.72;

/** Trigrams over a space-padded string, so short names still produce enough grams for
 *  the ratio to mean something and word boundaries count as signal. */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value.trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;

  return intersection / (setA.size + setB.size - intersection);
}

export interface AliasMatch {
  readonly alias: MerchantAlias;
  readonly matchType: AliasMatchType;
  readonly similarity: number;
}

/**
 * Resolve a cleaned merchant key against the alias table.
 *
 * All candidates are collected and then ordered, rather than returning the first hit
 * found. §4.1's "exact first, then prefix, then fuzzy" and §4.3's source precedence are
 * two different orderings of the same candidate set, and short-circuiting on match type
 * would silently make match type outrank source — quietly discarding a user correction
 * whenever a seed exact alias also matched.
 */
export function resolveAlias(
  merchantKey: string,
  aliases: readonly MerchantAlias[],
  fuzzyFloor: number = FUZZY_SIMILARITY_FLOOR
): AliasMatch | null {
  const candidates: AliasMatch[] = [];

  for (const alias of aliases) {
    switch (alias.matchType) {
      case 'exact':
        if (merchantKey === alias.aliasKey) {
          candidates.push({ alias, matchType: 'exact', similarity: 1 });
        }
        break;
      case 'prefix':
        if (alias.aliasKey !== '' && merchantKey.startsWith(alias.aliasKey)) {
          candidates.push({ alias, matchType: 'prefix', similarity: 1 });
        }
        break;
      case 'fuzzy': {
        const similarity = trigramSimilarity(merchantKey, alias.aliasKey);
        if (similarity >= fuzzyFloor) {
          candidates.push({ alias, matchType: 'fuzzy', similarity });
        }
        break;
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const bySource = SOURCE_RANK[a.alias.source] - SOURCE_RANK[b.alias.source];
    if (bySource !== 0) return bySource;

    const byMatchType = MATCH_TYPE_RANK[a.matchType] - MATCH_TYPE_RANK[b.matchType];
    if (byMatchType !== 0) return byMatchType;

    if (a.similarity !== b.similarity) return b.similarity - a.similarity;

    // A longer prefix is a more specific claim than a shorter one.
    if (a.alias.aliasKey.length !== b.alias.aliasKey.length) {
      return b.alias.aliasKey.length - a.alias.aliasKey.length;
    }

    if (a.alias.confidence !== b.alias.confidence) return b.alias.confidence - a.alias.confidence;

    // Total order, so the result is deterministic across runs regardless of input
    // ordering — the property T2 in §2.4 exists to protect.
    return a.alias.merchantId < b.alias.merchantId ? -1 : a.alias.merchantId > b.alias.merchantId ? 1 : 0;
  });

  return candidates[0];
}

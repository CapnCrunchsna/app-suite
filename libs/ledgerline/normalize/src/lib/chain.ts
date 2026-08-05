/**
 * The seven-stage deterministic merchant normalization chain (§4).
 *
 * "Statement descriptors are hostile by design: `SQ *BLUE BOTTLE COFFE 415-555-0111
 * CA`, `TST* THE PLANT CAFE #0042`, `PAYPAL *SPOTIFYUSA 4029357733`. Everything
 * downstream — recurrence, duplicates, categories — depends on collapsing those to one
 * merchant."
 *
 * Stages 1–5 clean the string, 6 resolves it against the alias table, 7 falls back to a
 * provisional merchant. There is **no LLM anywhere in this file**, which is §4.1's
 * stated intent — the chain is "rules-first on purpose: it is fast, reproducible,
 * debuggable, and works with the LLM off."
 *
 * This chain may grow freely. `collapse_v1` in `ledgerline-domain` may not. Conflating
 * the two would make every addition to the prefix table corrupt the dedupe history
 * (§3.3), which is why they are in different libs with different rules written on them.
 *
 * `normalize` returns values and never writes (§2.2). The alias table is passed in.
 */

import { resolveAlias, FUZZY_SIMILARITY_FLOOR } from './alias.js';
import type { AliasMatchType, AliasSource, MerchantAlias } from './alias.js';
import { isP2PDescriptor } from './p2p.js';
import { runStages, stageCaseAndWhitespace } from './stages.js';
import type { StageTrace } from './stages.js';
import { PROCESSOR_PREFIXES } from './tables.js';

export type MerchantResolution =
  | {
      readonly kind: 'alias';
      readonly merchantId: string;
      readonly matchType: AliasMatchType;
      readonly source: AliasSource;
      readonly similarity: number;
    }
  /** §4.1 step 7: "the cleaned string becomes a provisional merchant, marked
   *  `source = 'rule'`, and joins the review queue." */
  | { readonly kind: 'provisional'; readonly name: string; readonly source: 'rule' };

export interface NormalizeOptions {
  readonly aliases?: readonly MerchantAlias[];
  readonly prefixes?: readonly string[];
  readonly fuzzyFloor?: number;
  readonly knownMerchantKeys?: ReadonlySet<string>;
  /** Stage traces are useful and not free. On by default because the whole point of a
   *  rules-first chain is that it is inspectable; the bulk re-normalize job (§2.7) turns
   *  them off. */
  readonly trace?: boolean;
}

export interface NormalizeResult {
  readonly descriptionRaw: string;
  /** `transaction.description_normalized` (§3.1) — the output of stages 1–5. */
  readonly descriptionNormalized: string;
  readonly resolution: MerchantResolution;
  /** True when this descriptor names a person rather than a merchant (§2.4). Such
   *  descriptors must never be sent to an LLM provider. */
  readonly isP2P: boolean;
  readonly trace: readonly StageTrace[];
}

export function normalizeDescriptor(
  descriptionRaw: string,
  options: NormalizeOptions = {}
): NormalizeResult {
  const {
    aliases = [],
    prefixes = PROCESSOR_PREFIXES,
    fuzzyFloor = FUZZY_SIMILARITY_FLOOR,
    knownMerchantKeys,
    trace = true,
  } = options;

  const { output: descriptionNormalized, trace: stageTrace } = runStages(descriptionRaw, prefixes);

  const match = resolveAlias(descriptionNormalized, aliases, fuzzyFloor);

  const resolution: MerchantResolution = match
    ? {
        kind: 'alias',
        merchantId: match.alias.merchantId,
        matchType: match.matchType,
        source: match.alias.source,
        similarity: match.similarity,
      }
    : { kind: 'provisional', name: descriptionNormalized, source: 'rule' };

  const isP2P = isP2PDescriptor({
    upperDescriptor: stageCaseAndWhitespace(descriptionRaw),
    merchantKey: descriptionNormalized,
    knownMerchantKeys,
  });

  return {
    descriptionRaw,
    descriptionNormalized,
    resolution,
    isP2P,
    trace: trace ? stageTrace : [],
  };
}

/**
 * Normalize a batch, reusing one alias table.
 *
 * Batching matters at scale: §2.7 notes a first-time normalization of a few thousand
 * descriptors, and §4.3's re-normalize job re-runs this over every historical
 * transaction. Descriptors repeat heavily inside a statement, so identical raw strings
 * are resolved once and shared.
 */
export function normalizeBatch(
  descriptors: readonly string[],
  options: NormalizeOptions = {}
): NormalizeResult[] {
  const cache = new Map<string, NormalizeResult>();

  return descriptors.map((raw) => {
    const cached = cache.get(raw);
    if (cached) return cached;
    const result = normalizeDescriptor(raw, options);
    cache.set(raw, result);
    return result;
  });
}

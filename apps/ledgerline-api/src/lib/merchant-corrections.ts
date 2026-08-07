/**
 * What a merchant correction does besides change a row — §4.3.
 *
 * "Correcting a merchant in the UI writes a `merchant_alias` row and enqueues a
 * **re-normalize job** (§2.7) that reapplies the chain across the affected
 * historical transactions and then re-runs the analyzers. So fixing `SPOTIFYUSA`
 * once retroactively merges four years of charges into one series."
 *
 * Both halves live here rather than in the route because both routes need them:
 * `PATCH /api/transactions/:id` corrects one row and `POST /api/transactions/bulk`
 * corrects a filter-matched set, and they must have identical consequences. A
 * single-row edit that skipped the alias write would leave the next import of the
 * same descriptor resolving to the old merchant, which is precisely the "row by
 * row" failure §6.3's bulk path exists to end.
 *
 * This is the composition root, so this is where the payload's *meaning* lives.
 * `data` merges job payloads with a function it is handed (§2.2 — it may depend on
 * `type:domain` and nothing else, so it cannot know what a renormalize payload
 * is).
 */

import type { LedgerlineContext } from './context.js';

/**
 * §2.7's incremental re-normalization: "only transactions whose current
 * `description_normalized` falls in the affected alias key-space are
 * re-resolved."
 *
 * Both halves are carried. The transaction ids are what a re-run must revisit
 * *now*; the alias keys are what makes a coalesced job still correct after
 * merging, because a second correction may add rows the first never selected.
 */
export interface RenormalizePayload {
  readonly transactionIds: readonly string[];
  readonly aliasKeys: readonly string[];
}

function mergeRenormalize(existing: string | null, incoming: RenormalizePayload): string {
  const carried = existing ? (JSON.parse(existing) as Partial<RenormalizePayload>) : null;
  return JSON.stringify({
    transactionIds: [...new Set([...(carried?.transactionIds ?? []), ...incoming.transactionIds])],
    aliasKeys: [...new Set([...(carried?.aliasKeys ?? []), ...incoming.aliasKeys])],
  } satisfies RenormalizePayload);
}

/**
 * Write one `user` alias per corrected descriptor (§4.3).
 *
 * `match_type: 'exact'` because the key *is* the normalized descriptor the chain
 * produced — the user corrected this exact string, and a prefix or fuzzy alias
 * would silently claim descriptors they never looked at. §4.3's precedence
 * (`user` → `seed` → `rule` → `llm`) is enforced inside `upsertAlias`, so a
 * correction cannot be undone by a later re-seed or a better model.
 *
 * Returns the keys actually written, which is what the re-normalize payload and
 * the API response report.
 */
export function writeUserMerchantAlias(
  context: LedgerlineContext,
  descriptorsNormalized: readonly string[],
  merchantId: string,
): string[] {
  const written: string[] = [];

  for (const aliasKey of new Set(descriptorsNormalized)) {
    if (aliasKey.trim() === '') continue;
    context.store.merchants.upsertAlias({
      aliasKey,
      merchantId,
      matchType: 'exact',
      confidence: null,
      source: 'user',
    });
    written.push(aliasKey);
  }

  return written;
}

/**
 * Enqueue the coalesced re-normalize job (§2.7).
 *
 * Enqueue only — the runner is separate work. §2.7's debounce is a UI concern
 * ("Merchant corrections in the UI are debounced 5 seconds and batched"); the
 * coalescing that makes eight corrections one job is the queue's, and it is in
 * `JobRepository.enqueueCoalesced`.
 */
export function enqueueRenormalize(
  context: LedgerlineContext,
  payload: RenormalizePayload,
): { id: string; coalesced: boolean } {
  const { job, coalesced } = context.store.jobs.enqueueCoalesced({
    kind: 'renormalize',
    mergePayload: (existing) => mergeRenormalize(existing, payload),
    message: `re-normalizing ${payload.transactionIds.length} transaction${
      payload.transactionIds.length === 1 ? '' : 's'
    }`,
  });

  return { id: job.id, coalesced };
}

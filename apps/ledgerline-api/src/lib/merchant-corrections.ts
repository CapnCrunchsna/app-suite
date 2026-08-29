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

import { normalizeBatch, normalizeDescriptor, SEED_MERCHANT_KEYS } from '@metrum/ledgerline-normalize';
import type { MerchantAlias } from '@metrum/ledgerline-normalize';
import type { RenormalizedRow } from '@metrum/ledgerline-data';

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
  /**
   * §2.7's other half: "A full sweep is available explicitly from Settings."
   *
   * A separate flag rather than a sentinel alias key, because the two are different
   * operations rather than the same one over a wider set — the incremental path
   * re-points merchants inside a known key-space, and the sweep re-runs §4.1's chain
   * from the raw descriptor and may rewrite `description_normalized` (§9v).
   */
  readonly full?: boolean;
}

/**
 * Coalesce two payloads (§2.7).
 *
 * `full` is OR-ed, and that is the whole of why the sweep can share a job kind with
 * the incremental path: a full sweep **subsumes** any incremental work queued beside
 * it, because it re-resolves every row rather than a key-space. Merging the two into
 * one job therefore loses nothing, where dropping either would.
 */
function mergeRenormalize(existing: string | null, incoming: RenormalizePayload): string {
  const carried = existing ? (JSON.parse(existing) as Partial<RenormalizePayload>) : null;
  return JSON.stringify({
    transactionIds: [...new Set([...(carried?.transactionIds ?? []), ...incoming.transactionIds])],
    aliasKeys: [...new Set([...(carried?.aliasKeys ?? []), ...incoming.aliasKeys])],
    full: (carried?.full ?? false) || (incoming.full ?? false),
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
 * Enqueue only; `runRenormalize` below is what the job runner calls. §2.7's
 * debounce is a UI concern ("Merchant corrections in the UI are debounced 5
 * seconds and batched"); the coalescing that makes eight corrections one job is
 * the queue's, and it is in `JobRepository.enqueueCoalesced`.
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

  // After the response, not during it (§6.3: "the UI shows its progress rather
  // than blocking"). The drain is itself coalesced, so eight corrections in one
  // tick book one drain over one merged job.
  context.jobRunner.schedule();

  return { id: job.id, coalesced };
}

export interface RenormalizeResult {
  readonly descriptorsConsidered: number;
  readonly transactionsRepointed: number;
  readonly merchantsAffected: number;
  /** §2.7's full sweep only: rows whose `description_normalized` the current chain
   *  no longer agrees with. Zero on the incremental path by construction. */
  readonly descriptorsRewritten?: number;
  /** §4.1 step 7 merchants the sweep had to create because the new chain produced a
   *  cleaned name nothing had seen before. */
  readonly merchantsCreated?: number;
}

/** How many rows the sweep holds in memory at once. Uncalibrated (§7.6); chosen so
 *  §2.2's heavy household is ~120 pages rather than one 58,000-row array. */
const SWEEP_PAGE = 500;

/**
 * §2.7's **full sweep**: "A full sweep is available explicitly from Settings."
 *
 * ## Why this is a different function rather than a wider `runRenormalize`
 *
 * §9q predicted the fix would be `TransactionPatch` learning to carry
 * `description_normalized`, and building it that way would have been wrong. The
 * incremental path selects a *group* of rows by their shared current
 * `description_normalized`, runs the chain over one representative raw descriptor,
 * and applies the answer to the group. That is sound while the chain is fixed,
 * because the grouping was the chain's own. It stops being sound the moment the
 * chain changes — which is the only reason to run a sweep at all: two raw
 * descriptors the old chain merged may be ones the new chain separates, and one
 * sample's answer written across the group would merge them permanently.
 *
 * So the unit of work here is the **raw descriptor**, one row at a time. §4.1's
 * chain is a pure function of it, and nothing about the stored grouping is trusted.
 *
 * ## What it may and may not rewrite
 *
 * `description_normalized` and `merchant_id`, and the category where §4.3 allows it.
 * Never `dedupe_key` — §3.3 computes that from the raw descriptor through the frozen
 * `collapse_v1`, and §4 opens by separating the growing chain from the frozen one
 * precisely so a sweep like this is safe to run.
 *
 * Never a `user` category, for §4.3's reason: a correction is permanent, and
 * `category_source` is what records which is which. The merchant on those rows still
 * moves — a hand-picked category is not a reason to leave a merchant wrong.
 *
 * ## Only rows that actually changed are written
 *
 * A sweep over a database the chain already agrees with must be a no-op, not 58,000
 * `updated_at` stamps: §3.4's watermark re-index reads that column, and a sweep that
 * touched every row would hand it the whole table to re-index for nothing.
 */
export function runFullRenormalize(
  context: LedgerlineContext,
  report: (progress: number, message: string) => void = () => undefined,
): RenormalizeResult {
  const total = context.store.transactions.countAll();
  if (total === 0) {
    return {
      descriptorsConsidered: 0,
      transactionsRepointed: 0,
      merchantsAffected: 0,
      descriptorsRewritten: 0,
      merchantsCreated: 0,
    };
  }

  const aliases: MerchantAlias[] = context.store.merchants.listAliases().map((alias) => ({
    aliasKey: alias.aliasKey,
    merchantId: alias.merchantId,
    matchType: alias.matchType,
    confidence: alias.confidence ?? 1,
    source: alias.source,
  }));

  // The merchant's default category, looked up once per merchant rather than once
  // per row: on a real statement that is 21 lookups instead of 326, and on §2.2's
  // ceiling it is the difference between hundreds and tens of thousands.
  const defaultCategories = new Map<string, string | null>();
  const categoryOf = (merchantId: string): string | null => {
    if (!defaultCategories.has(merchantId)) {
      defaultCategories.set(merchantId, context.store.merchants.get(merchantId)?.defaultCategoryId ?? null);
    }
    return defaultCategories.get(merchantId) ?? null;
  };

  const merchantsTouched = new Set<string>();
  let afterId: string | null = null;
  let seen = 0;
  let repointed = 0;
  let rewritten = 0;
  let created = 0;

  for (;;) {
    const page = context.store.transactions.listForRenormalize(SWEEP_PAGE, afterId);
    if (page.length === 0) break;

    const writes: RenormalizedRow[] = [];

    for (const row of page) {
      const resolved = normalizeDescriptor(row.descriptionRaw, {
        aliases,
        knownMerchantKeys: SEED_MERCHANT_KEYS,
        trace: false,
      });

      // §4.1 step 7, applied by the sweep rather than by an import: a descriptor the
      // chain cleans but cannot match becomes a provisional merchant. This is the
      // branch `runRenormalize` skips — and skipping it is what §9q measured at 17
      // merchants of 21 on the first real statement, which is most of the ledger.
      let merchantId: string | null = null;
      if (resolved.resolution.kind === 'alias') {
        merchantId = resolved.resolution.merchantId;
      } else if (resolved.resolution.name.trim() !== '') {
        const before = context.store.merchants.findByCanonicalName(resolved.resolution.name);
        const merchant = context.store.merchants.getOrCreateProvisional(resolved.resolution.name);
        if (!before) created += 1;
        merchantId = merchant.id;
      }

      const descriptorMoved = row.descriptionNormalized !== resolved.descriptionNormalized;
      const merchantMoved = row.merchantId !== merchantId;
      if (!descriptorMoved && !merchantMoved) continue;

      // §4.3: a `user` category is permanent. Everything else follows the merchant,
      // including being cleared when the new merchant has no default — the rule now
      // says nothing, so the rule's answer goes rather than being left behind.
      const keepCategory = row.categorySource === 'user';
      const ruleCategory = merchantId === null ? null : categoryOf(merchantId);

      writes.push({
        id: row.id,
        descriptionNormalized: resolved.descriptionNormalized,
        merchantId,
        categoryId: keepCategory ? row.categoryId : ruleCategory,
        categorySource: keepCategory ? row.categorySource : ruleCategory === null ? null : 'rule',
      });

      if (descriptorMoved) rewritten += 1;
      if (merchantMoved) repointed += 1;
      if (merchantId !== null) merchantsTouched.add(merchantId);
    }

    context.store.transactions.applyRenormalized(writes);

    seen += page.length;
    afterId = page[page.length - 1].id;
    report(
      Math.min(95, Math.round((seen / total) * 95)),
      `re-normalized ${seen} of ${total} transactions`,
    );

    if (page.length < SWEEP_PAGE) break;
  }

  return {
    descriptorsConsidered: seen,
    transactionsRepointed: repointed,
    merchantsAffected: merchantsTouched.size,
    descriptorsRewritten: rewritten,
    merchantsCreated: created,
  };
}

/**
 * §4.3's second half: reapply the chain across the affected historical
 * transactions.
 *
 * "So fixing `SPOTIFYUSA` once retroactively merges four years of charges into
 * one series" — the retroactive part is this function, and it is why the payload
 * carries **alias keys and not only transaction ids**. The ids are the rows the
 * user was looking at; the keys are every row that spells the merchant the same
 * way, including the four years of them nobody selected. §2.7 calls this being
 * incremental: "only transactions whose current `description_normalized` falls
 * in the affected alias key-space are re-resolved."
 *
 * ## `merchant_id` moves, and the category it decides moves with it
 *
 * The chain is deterministic from `description_raw`, and a merchant correction
 * changes the *alias table*, not the chain — so `description_normalized` comes
 * back identical by construction and re-writing it would be a no-op that stamps
 * `updated_at` on every row. That keeps `dedupe_key` untouched, which §3.3
 * requires absolutely: the key is computed from the raw descriptor through the
 * frozen `collapse_v1`, and a re-normalize that moved it would re-key rows the
 * merge rule has already reasoned about.
 *
 * `category_id` moves because §2.5's rule *is* the merchant's default category:
 * a correction that repointed a row from a merchant defaulting to `dining` to one
 * defaulting to `groceries` and left `dining` behind would strand the old answer
 * on the new merchant, and §5.10 would keep trending a category the row no longer
 * belongs to. The new merchant having **no** default is the same statement — the
 * rule now says nothing, so the rule's answer is cleared rather than kept.
 *
 * **A `user` category is never touched.** §4.3 puts `user` above every other
 * source and calls a correction "permanent"; `category_source` is what records
 * which is which, and `excludeUserCategorized` is the filter that honours it. The
 * merchant on those rows still moves — a hand-picked category is not a reason to
 * leave a merchant wrong.
 *
 * Internal transfers and excluded rows are re-pointed too. They are hidden from
 * §6.3's table by default, not deleted, and leaving them on a stale merchant
 * would mean un-excluding a row later resurrects a correction the user already
 * made.
 */
export function runRenormalize(
  context: LedgerlineContext,
  payload: RenormalizePayload,
): RenormalizeResult {
  const descriptors = affectedDescriptors(context, payload);
  if (descriptors.length === 0) {
    return { descriptorsConsidered: 0, transactionsRepointed: 0, merchantsAffected: 0 };
  }

  const aliases: MerchantAlias[] = context.store.merchants.listAliases().map((alias) => ({
    aliasKey: alias.aliasKey,
    merchantId: alias.merchantId,
    matchType: alias.matchType,
    confidence: alias.confidence ?? 1,
    source: alias.source,
  }));

  // §4.1's chain runs over the *raw* descriptor, never the normalized one — the
  // normalized form is the chain's own output and feeding it back in would apply
  // stages 1–5 twice. One representative raw descriptor per normalized key is
  // enough, because they all normalize to that key by definition.
  const samples = rawSamplesFor(context, descriptors);
  const resolved = normalizeBatch(
    samples.map((sample) => sample.descriptionRaw),
    { aliases, knownMerchantKeys: SEED_MERCHANT_KEYS, trace: false },
  );

  const merchants = new Set<string>();
  let repointed = 0;

  samples.forEach((sample, index) => {
    const resolution = resolved[index].resolution;
    if (resolution.kind !== 'alias') return;

    const selector = {
      descriptorsNormalized: [sample.descriptionNormalized],
      includeInternalTransfers: true,
      includeExcluded: true,
    };

    const applied = context.store.transactions.applyBulk(selector, {
      merchantId: resolution.merchantId,
    });

    // Two passes over the same descriptor, because they select different sets:
    // every row gets the corrected merchant, but only rows the rule owns get the
    // merchant's category. One conditional UPDATE would have had to encode §4.3's
    // precedence in SQL; two named filters say it out loud.
    const categoryId =
      context.store.merchants.get(resolution.merchantId)?.defaultCategoryId ?? null;
    context.store.transactions.applyBulk(
      { ...selector, excludeUserCategorized: true },
      { categoryId, categorySource: categoryId === null ? null : 'rule' },
    );

    if (applied.matched > 0) {
      merchants.add(resolution.merchantId);
      repointed += applied.matched;
    }
  });

  return {
    descriptorsConsidered: descriptors.length,
    transactionsRepointed: repointed,
    merchantsAffected: merchants.size,
  };
}

/**
 * The key-space one coalesced job covers.
 *
 * The union of the payload's alias keys and the current descriptors of the rows
 * it named. Both halves are needed: a key with no rows yet is still worth
 * carrying (a later import may bring some), and a transaction id whose descriptor
 * the payload never mentioned is a row the user corrected directly.
 */
function affectedDescriptors(
  context: LedgerlineContext,
  payload: RenormalizePayload,
): readonly string[] {
  const keys = new Set(payload.aliasKeys.filter((key) => key.trim() !== ''));

  for (const id of payload.transactionIds) {
    const transaction = context.store.transactions.get(id);
    if (transaction) keys.add(transaction.descriptionNormalized);
  }

  return [...keys];
}

function rawSamplesFor(
  context: LedgerlineContext,
  descriptors: readonly string[],
): readonly { descriptionNormalized: string; descriptionRaw: string }[] {
  const samples: { descriptionNormalized: string; descriptionRaw: string }[] = [];

  for (const descriptionNormalized of descriptors) {
    const page = context.store.transactions.search({
      descriptorsNormalized: [descriptionNormalized],
      includeInternalTransfers: true,
      includeExcluded: true,
      limit: 1,
    });
    const row = page.rows[0]?.transaction;
    if (row) samples.push({ descriptionNormalized, descriptionRaw: row.descriptionRaw });
  }

  return samples;
}

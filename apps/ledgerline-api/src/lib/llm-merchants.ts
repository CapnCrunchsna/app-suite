/**
 * §4.2 — "Where the LLM helps", which is one stage and no more.
 *
 * "Only at step 7, and never in the driver's seat. Unresolved descriptors are
 * batched (~50 per call), sent as **descriptor strings only** — no amounts, no
 * dates, no account numbers, and nothing on the P2P filter list from §2.4 — and the
 * model is asked for `{ descriptor, merchant_name, category, confidence }` validated
 * against a schema. Results land as `merchant_alias` rows with `source = 'llm'`.
 * Above a confidence floor (0.85) they apply provisionally and are marked in the UI;
 * below it they sit in the review queue and apply to nothing."
 *
 * ## The shape of this file is the privacy argument
 *
 * Everything that leaves is assembled in one function, `descriptorsToConsider`, and
 * everything it produces is a string that was already in the review queue. There is
 * no path from a transaction row to a prompt: amounts, dates, account ids and the
 * raw descriptor never enter the batch. That is not a convention to remember at each
 * call — the batch type has no field for them.
 *
 * The P2P hard filter runs in front, via `redactBatch`, on the verdict `normalize`
 * made at normalization time. §2.4: "This is a hard filter, not a redaction, because
 * a partially-masked personal name is still a personal name."
 *
 * ## The floor is not the last word
 *
 * §4.2's exception overrides it in one direction only: "An LLM alias that would merge
 * or split an existing `recurring_series` with `occurrence_count ≥ 3` never
 * auto-applies at any confidence — it goes to the review queue with the affected
 * series shown. Rewriting four years of a settled subscription's history on a model's
 * say-so is exactly the failure that makes the tool untrustworthy, and the confidence
 * floor does not protect against it."
 *
 * So the order is: withhold P2P, ask, then **exception, then floor**. A 0.99 proposal
 * that touches a settled series is withheld; a 0.5 proposal that touches nothing is
 * withheld too, and for a different reason the card has to be able to say.
 *
 * ## What this never does
 *
 * It never overwrites an alias. §4.2 says "The LLM never overwrites an existing alias
 * and never touches anything with `source = 'user'`", and that is enforced one level
 * down — `MerchantRepository.upsertAlias` returns the existing row untouched for any
 * `source: 'llm'` write, which is stricter than §4.3's precedence and deliberately so.
 * This file does not restate the rule; it relies on it, and `appliedAlias` below is
 * how it notices when the store declined.
 */

import { normalizeDescriptor, SEED_MERCHANT_KEYS } from '@metrum/ledgerline-normalize';
import { llmAssist, redactBatch } from '@metrum/ledgerline-llm';
import type { LlmProvider } from '@metrum/ledgerline-llm';
import type { LlmProposalRecord } from '@metrum/ledgerline-data';

import type { LedgerlineContext } from './context.js';
import { enqueueRenormalize } from './merchant-corrections.js';
import {
  createLlmProvider,
  degradedCallSink,
  effectiveRedaction,
  modelFor,
  readLlmSettings,
} from './llm-service.js';

/** §4.2, verbatim: "batched (~50 per call)". */
export const LLM_BATCH_SIZE = 50;

/** §4.2's floor: "Above a confidence floor (0.85) they apply provisionally". */
export const LLM_CONFIDENCE_FLOOR = 0.85;

/** §4.2's exception: "an existing `recurring_series` with `occurrence_count ≥ 3`". */
export const SETTLED_SERIES_OCCURRENCES = 3;

/** A ceiling on one run, so a first import of a decade of statements cannot queue
 *  four hundred CLI calls at seconds apiece. Uncalibrated (§7.6). */
const MAX_DESCRIPTORS_PER_RUN = 500;

/** What the model is asked to return, per descriptor (§4.2). */
export interface LlmMerchantProposal {
  readonly descriptor: string;
  readonly merchantName: string;
  readonly category: string | null;
  readonly confidence: number;
}

export interface LlmProposalOutcome {
  readonly descriptor: string;
  readonly merchantName: string;
  readonly confidence: number;
  readonly status: 'applied' | 'pending' | 'blocked';
  readonly reason: string | null;
}

export interface LlmNormalizeResult {
  readonly providerId: string;
  readonly model: string;
  readonly descriptorsConsidered: number;
  /** §2.4's hard filter, counted. A caller that sent fewer descriptors than it
   *  thought is a caller that cannot tell a filtered batch from a dead provider. */
  readonly withheldP2P: number;
  readonly batches: number;
  readonly proposalsReceived: number;
  readonly applied: number;
  readonly queuedForReview: number;
  readonly outcomes: readonly LlmProposalOutcome[];
  /** Set when `llmAssist` fell back for every batch — i.e. the provider did
   *  nothing. Named so the UI can say "Ollama is not running" rather than
   *  "0 proposals", which look identical and are not. */
  readonly degraded: boolean;
  readonly jobId: string | null;
}

interface Candidate {
  readonly descriptor: string;
  readonly merchantId: string;
  readonly isP2P: boolean;
}

/**
 * §4.1 step 7's leftovers: the merchants the chain named for itself.
 *
 * A provisional merchant *is* an unresolved descriptor — §4.1 step 7: "the cleaned
 * string becomes a provisional merchant, marked `source = 'rule'`, and joins the
 * review queue" — so the queue and this batch are populated from the same fact, and
 * a descriptor an alias already resolves is by construction not here.
 *
 * The P2P verdict is recomputed from a *raw* descriptor rather than read from a
 * column, because `transaction` has none: `isP2PDescriptor` runs inside the chain
 * and its answer reaches `NormalizeResult`, which is not persisted. Re-running the
 * chain over one representative raw descriptor per merchant is exact — every row
 * under a provisional merchant normalized to that merchant's name by definition —
 * and it keeps §2.4's list in `normalize`, where the note on `p2p.ts` says it has to
 * stay.
 */
function descriptorsToConsider(context: LedgerlineContext): Candidate[] {
  const candidates: Candidate[] = [];

  for (const merchant of context.store.merchants.list()) {
    if (merchant.source !== 'rule') continue;

    const page = context.store.transactions.search({
      merchantIds: [merchant.id],
      includeInternalTransfers: true,
      includeExcluded: true,
      limit: 1,
    });
    const row = page.rows[0]?.transaction;
    if (!row) continue;

    const resolved = normalizeDescriptor(row.descriptionRaw, {
      knownMerchantKeys: SEED_MERCHANT_KEYS,
      trace: false,
    });

    candidates.push({
      descriptor: merchant.canonicalName,
      merchantId: merchant.id,
      isP2P: resolved.isP2P,
    });

    if (candidates.length >= MAX_DESCRIPTORS_PER_RUN) break;
  }

  return candidates;
}

/**
 * §4.2's prompt.
 *
 * Descriptor strings and nothing else, one per line, with the response shape stated
 * rather than demonstrated with a worked example — an example is a template a small
 * model will copy, and a copied merchant name is worse than no answer. The
 * instruction to return `null` for an unknown merchant matters for the same reason:
 * without it the failure mode is invention, and an invented merchant with a
 * confident number attached is exactly what the floor cannot catch.
 */
export function buildPrompt(descriptors: readonly string[]): string {
  return [
    'You are normalizing bank statement merchant descriptors.',
    '',
    'For each descriptor below, identify the real-world merchant. Return JSON only:',
    '{"proposals":[{"descriptor":"<the input string, verbatim>",' +
      '"merchant_name":"<the merchant\'s common name, or null if you do not know>",' +
      '"category":"<a short spend category, or null>",' +
      '"confidence":<0..1>}]}',
    '',
    'Rules: return one entry per descriptor, copy each descriptor exactly as given,',
    'and use null with a low confidence rather than guessing a name you are unsure of.',
    '',
    'Descriptors:',
    ...descriptors,
  ].join('\n');
}

/**
 * §4.2's "validated against a schema".
 *
 * Hand-written rather than a schema library because `type:llm` may depend on
 * `type:domain` and nothing else (§2.2), so `JsonRequest.validate` is the caller's
 * to supply — and the caller is here. Throwing is the contract: `llmAssist` turns a
 * throw into the deterministic fallback, so a model that answers with prose degrades
 * exactly like a model that was not running.
 *
 * Entries are dropped individually rather than failing the batch. A model that got
 * forty-nine right and one wrong has still done forty-nine useful things, and
 * discarding them would make the whole feature hostage to its worst answer.
 */
export function parseProposals(value: unknown, asked: ReadonlySet<string>): LlmMerchantProposal[] {
  const container = value as { proposals?: unknown };
  const rows = Array.isArray(container?.proposals) ? container.proposals : null;
  if (!rows) throw new Error('expected { proposals: [...] }');

  const parsed: LlmMerchantProposal[] = [];

  for (const row of rows) {
    const entry = row as Record<string, unknown>;
    const descriptor = entry['descriptor'];
    const merchantName = entry['merchant_name'];
    const confidence = entry['confidence'];

    if (typeof descriptor !== 'string') continue;
    // A descriptor nobody asked about is either a hallucination or a mangled
    // echo, and applying an alias keyed on it would write a row for a descriptor
    // that does not exist in the ledger.
    if (!asked.has(descriptor)) continue;
    if (typeof merchantName !== 'string' || merchantName.trim() === '') continue;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;

    const category = entry['category'];

    parsed.push({
      descriptor,
      merchantName: merchantName.trim(),
      category: typeof category === 'string' && category.trim() !== '' ? category.trim() : null,
      // Clamped rather than rejected: a model that says 1.5 means "very sure",
      // and the floor is a comparison, not a probability.
      confidence: Math.min(Math.max(confidence, 0), 1),
    });
  }

  return parsed;
}

/**
 * §4.2's exception, asked of one proposal.
 *
 * Both sides are checked, because both are ways to disturb a settled subscription.
 * Moving rows *off* the descriptor's current merchant splits whatever series that
 * merchant has; moving them *onto* the target merges into that one. §4.2 names both
 * — "would merge or split" — and the conservative answer is the only safe one,
 * since which of the two happens depends on data this function would have to
 * re-derive the analyzers' clustering to know.
 */
function settledSeriesBlocking(
  context: LedgerlineContext,
  merchantIds: readonly (string | null)[],
): string | null {
  const affected = new Set(merchantIds.filter((id): id is string => id !== null));
  if (affected.size === 0) return null;

  const series = context.store.analysis
    .listSeries()
    .filter(
      (entry) =>
        affected.has(entry.merchantId) && entry.occurrenceCount >= SETTLED_SERIES_OCCURRENCES,
    );

  if (series.length === 0) return null;

  const names = [
    ...new Set(
      series.map(
        (entry) => context.store.merchants.get(entry.merchantId)?.displayName ?? entry.merchantId,
      ),
    ),
  ];

  return (
    `This would ${series.length === 1 ? 'change a' : 'change'} settled ` +
    `${series.length === 1 ? 'subscription' : 'subscriptions'} — ` +
    `${names.join(', ')}, with ${series[0].occurrenceCount} or more charges on record. ` +
    'A grouping that rewrites subscription history is never applied automatically.'
  );
}

/**
 * Which merchant a proposed name refers to, if any that already exists.
 *
 * §4.2 lands results as **aliases**, and an alias points at a merchant. So the
 * useful case is the one where the model recognises a descriptor as a merchant the
 * ledger already knows under another spelling — that is the merge §4.1's chain could
 * not make, and it is where the whole stage earns its keep.
 *
 * A name matching nothing is *not* turned into a new merchant. The descriptor
 * already has one (its provisional merchant, §4.1 step 7), so creating a second and
 * aliasing across would change a display name and nothing else, while adding a row
 * the user never asked for. It goes to the review queue instead, where a person can
 * see the suggested name next to the descriptor and decide.
 */
function resolveTargetMerchant(
  context: LedgerlineContext,
  merchantName: string,
  excludeMerchantId: string,
): string | null {
  const wanted = merchantName.trim().toUpperCase();
  if (wanted === '') return null;

  for (const merchant of context.store.merchants.list()) {
    if (merchant.id === excludeMerchantId) continue;
    if (merchant.source === 'rule') continue;
    if (
      merchant.canonicalName.toUpperCase() === wanted ||
      merchant.displayName.toUpperCase() === wanted
    ) {
      return merchant.id;
    }
  }

  return null;
}

export interface LlmNormalizeOptions {
  /** Injected by the spec, which must never start a real provider — see the note
   *  at the top of `llm.spec.ts`. Production resolves it from settings. */
  readonly provider?: LlmProvider;
  readonly report?: (progress: number, message: string) => void;
}

/**
 * Run §4.2's stage: batch, ask, and write what may be written.
 *
 * Returns rather than throws on a dead provider. §2.4's whole design is that the
 * deterministic answer already exists — every descriptor here is already resolved to
 * a provisional merchant — so "the model said nothing" is a normal outcome and not
 * an error, and `degraded` is how the caller tells it from "the model had nothing to
 * add".
 */
export async function runLlmMerchantProposals(
  context: LedgerlineContext,
  options: LlmNormalizeOptions = {},
): Promise<LlmNormalizeResult> {
  const settings = readLlmSettings(context);
  const provider = options.provider ?? createLlmProvider(context);
  const model = modelFor(settings);
  const report = options.report ?? (() => undefined);
  const onDegraded = degradedCallSink(context);

  const candidates = descriptorsToConsider(context);
  const byId = new Map(candidates.map((entry) => [entry.descriptor, entry]));

  // §2.4's hard filter, ahead of everything. `redactBatch` takes `normalize`'s
  // verdict and enforces it; it does not re-derive the P2P rule (see `redact.ts`).
  // Redaction can be switched off in §6.8, but never for `claude-cli`, and the
  // filter is not part of that switch — §2.4 makes it a filter precisely so that it
  // is not a redaction setting.
  const { sendable, withheldP2P } = redactBatch(
    candidates.map((entry) => ({ id: entry.descriptor, text: entry.descriptor, isP2P: entry.isP2P })),
  );

  /**
   * What is sent, mapped back to what it came from.
   *
   * The model echoes the string it was given, and under redaction that string is
   * not the alias key — `SQ *BLUE BOTTLE 1234` goes out as
   * `SQ *BLUE BOTTLE [redacted]`, and writing an alias keyed on the redacted form
   * would key it on a descriptor no transaction has. So the batch carries the sent
   * text and this map carries the way home.
   *
   * A collision is dropped rather than resolved. Two descriptors that redact to one
   * string cannot be told apart in the answer, and guessing which one a proposal
   * meant would write a permanent grouping onto a coin flip.
   */
  const redacting = effectiveRedaction(settings);
  const bySentText = new Map<string, Candidate>();
  const collided = new Set<string>();

  for (const entry of sendable) {
    const candidate = byId.get(entry.id);
    if (!candidate) continue;
    const sent = redacting ? entry.text : entry.id;
    if (bySentText.has(sent)) {
      collided.add(sent);
      continue;
    }
    bySentText.set(sent, candidate);
  }
  for (const sent of collided) bySentText.delete(sent);

  const texts = [...bySentText.keys()];

  const outcomes: LlmProposalOutcome[] = [];
  const aliasKeysWritten: string[] = [];
  let proposalsReceived = 0;
  let batches = 0;
  let fallbacks = 0;

  for (let offset = 0; offset < texts.length; offset += LLM_BATCH_SIZE) {
    const slice = texts.slice(offset, offset + LLM_BATCH_SIZE);
    const asked = new Set(slice);
    batches += 1;

    report(
      Math.round((offset / Math.max(texts.length, 1)) * 80),
      `asking about ${slice.length} descriptor${slice.length === 1 ? '' : 's'}`,
    );

    const prompt = buildPrompt(slice);

    // §2.4: "No feature calls a provider directly." The fallback is the empty
    // list, which is the deterministic answer — every one of these descriptors is
    // already resolved to a provisional merchant, and adding nothing to that is
    // exactly what happens with the provider set to `none`.
    const proposals = await llmAssist(
      () => provider.completeJson<LlmMerchantProposal[]>({
        prompt,
        validate: (value) => parseProposals(value, asked),
      }),
      {
        fallback: () => [],
        operation: 'merchant normalization',
        onDegraded,
      },
    );

    if (proposals.length === 0) fallbacks += 1;
    proposalsReceived += proposals.length;

    for (const proposal of proposals) {
      outcomes.push(
        applyProposal(context, proposal, bySentText, settings.providerId, model, aliasKeysWritten),
      );
    }
  }

  // One job for the whole run, not one per alias. §4.3's sweep is coalesced anyway,
  // but enqueueing nothing when nothing was written is the difference between a
  // no-op run and a run that re-analyzes the database for no reason.
  let jobId: string | null = null;
  if (aliasKeysWritten.length > 0) {
    report(85, 're-normalizing the affected history');
    jobId = enqueueRenormalize(context, { transactionIds: [], aliasKeys: aliasKeysWritten }).id;
  }

  report(100, `${outcomes.filter((o) => o.status === 'applied').length} groupings applied`);

  return {
    providerId: settings.providerId,
    model,
    descriptorsConsidered: candidates.length,
    withheldP2P: withheldP2P.length,
    batches,
    proposalsReceived,
    applied: outcomes.filter((outcome) => outcome.status === 'applied').length,
    queuedForReview: outcomes.filter((outcome) => outcome.status !== 'applied').length,
    outcomes,
    degraded: batches > 0 && fallbacks === batches,
    jobId,
  };
}

/**
 * One proposal, through §4.2's three gates in order.
 *
 * Exception, then target, then floor — and the order is what makes each message
 * true. A settled-series block reported as "below the confidence floor" would send
 * the user to raise a threshold that was never the reason.
 */
function applyProposal(
  context: LedgerlineContext,
  proposal: LlmMerchantProposal,
  bySentText: ReadonlyMap<string, Candidate>,
  providerId: string,
  model: string,
  aliasKeysWritten: string[],
): LlmProposalOutcome {
  const candidate = bySentText.get(proposal.descriptor);
  // The real descriptor, never the redacted one the model saw — this is both the
  // alias key and what the review card prints, and neither may be a string no
  // transaction carries.
  const descriptor = candidate?.descriptor ?? proposal.descriptor;

  const record = (
    status: LlmProposalRecord['status'],
    reason: string | null,
  ): LlmProposalOutcome => {
    context.store.llm.upsertProposal({
      descriptor,
      merchantName: proposal.merchantName,
      // §4.2 asks the model for a category and this is where it stops: writing it
      // to `transaction.category_source = 'llm'` would be overwritten within
      // seconds by §4.3's re-normalize, which sets the category from the *new*
      // merchant's default (§2.5's rule). Recorded here so the review card can
      // show what the model thought; not applied, because two mechanisms writing
      // one column is how a category starts flickering. Recorded in §9s.
      categoryName: proposal.category,
      confidence: proposal.confidence,
      status,
      blockedReason: reason,
      provider: providerId,
      model,
    });

    return {
      descriptor,
      merchantName: proposal.merchantName,
      confidence: proposal.confidence,
      status: status === 'applied' ? 'applied' : status === 'blocked' ? 'blocked' : 'pending',
      reason,
    };
  };

  if (!candidate) {
    return record('pending', 'This descriptor is no longer unresolved.');
  }

  const target = resolveTargetMerchant(context, proposal.merchantName, candidate.merchantId);

  const blocking = settledSeriesBlocking(context, [candidate.merchantId, target]);
  if (blocking) return record('blocked', blocking);

  if (target === null) {
    return record(
      'pending',
      `No merchant named “${proposal.merchantName}” exists yet, so there is nothing to group ` +
        'this descriptor with. Assign it by hand to apply the suggestion.',
    );
  }

  if (proposal.confidence < LLM_CONFIDENCE_FLOOR) {
    return record(
      'pending',
      `Confidence ${proposal.confidence.toFixed(2)} is below the ${LLM_CONFIDENCE_FLOOR} floor.`,
    );
  }

  // §4.2: "The LLM never overwrites an existing alias." Enforced inside
  // `upsertAlias`, which returns the existing row for any `llm` write — so a
  // returned merchant that is not the one asked for means the store declined, and
  // the honest report is that nothing was applied.
  const alias = context.store.merchants.upsertAlias({
    aliasKey: descriptor,
    merchantId: target,
    matchType: 'exact',
    confidence: proposal.confidence,
    source: 'llm',
  });

  if (alias.merchantId !== target || alias.source !== 'llm') {
    return record(
      'pending',
      'A grouping for this descriptor already exists and takes precedence (spec 4.3).',
    );
  }

  aliasKeysWritten.push(descriptor);
  return record('applied', null);
}

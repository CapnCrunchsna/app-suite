/**
 * `GET /api/merchants` (§2.3), §4.1 step 7's review queue, and the one action that
 * resolves what the queue asks.
 *
 * The category surface used to live here as a single `GET`. It moved to
 * `categories.ts` when §6.8's editor gave it four more routes and an argument of its
 * own — see that file's header.
 *
 * §2.3's `PATCH /api/merchants/:id` and `POST /api/merchants/aliases` are at the
 * bottom of this file. They were the last of §2.3 left unbuilt, and the reason
 * given here for that was ownership: an alias write happened "as a consequence of
 * the transaction edit (§4.3) rather than as a call the UI makes itself, and
 * half-built endpoints teach the wrong model of who owns the alias table."
 *
 * That is answered rather than dropped. The alias route does not touch
 * `upsertAlias`; it calls the same `writeUserMerchantAlias` the §6.3 correction
 * and the merge below both call, so the table still has one owner. And the
 * `PATCH` writes no aliases at all — it changes what the rules know about a
 * merchant that is already the right one.
 *
 * ## Why the queue is a read and the merge is a write
 *
 * §4.1's chain is deliberately unable to settle some questions — `SAMSCLUB` and
 * `SAMS CLUB` differ by a space the bank chose, both run the chain cleanly, and
 * neither is wrong. §4.1 stage 4 argues the general case for not guessing: "over-
 * stripping silently merges two merchants and every §5 rule groups by merchant."
 *
 * So the chain stops and the queue carries the unanswered questions to a person.
 * It proposes and never decides — no `GET` here changes a row. The answer comes
 * back as `POST /api/merchants/:id/merge`, which is the *user's* decision and is
 * governed by §4.3 exactly as a transaction-level correction is: a `user` alias,
 * permanent, top-precedence, swept over history by the same job.
 */

import type { FastifyInstance } from 'fastify';
import { proposeMerchantMerges } from '@metrum/ledgerline-normalize';
import type { MergeSubject } from '@metrum/ledgerline-normalize';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { readLlmSettings } from '../llm-service.js';
import { enqueueRenormalize, writeUserMerchantAlias } from '../merchant-corrections.js';

/**
 * Why the LLM half of the queue is empty, when it is.
 *
 * `none` is the default and is not a failure — §2.4 makes it "a real
 * implementation, not a null", and an app that has never been pointed at a
 * provider has correctly sent nothing anywhere. Saying so is the difference
 * between a feature that looks broken and one that is switched off, which is the
 * same argument §6.8 makes about stated absences.
 */
function llmProposalsUnavailableReason(providerId: string, proposals: number): string | null {
  if (proposals > 0) return null;
  if (providerId === 'none') {
    return (
      'No LLM provider is configured, so no descriptor has left this machine and there is ' +
      'nothing to review. Choose a provider in the LLM section above to change that.'
    );
  }
  return null;
}

export function registerMerchantRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get(
    '/api/merchants',
    {
      schema: {
        summary: 'Canonical merchants, by name',
        operationId: 'listMerchants',
        description:
          'Includes provisional merchants — spec 4.1 step 7 makes an unresolved descriptor a ' +
          '`source = "rule"` merchant, and `source` is what the UI shows to distinguish one ' +
          'from a seeded merchant (spec 7.5).',
        tags: ['merchants'],
        response: {
          200: { type: 'array', items: ref('Merchant') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.merchants.list(),
  );

  app.get(
    '/api/merchants/review-queue',
    {
      schema: {
        summary: 'Merchant questions the chain cannot answer on its own',
        operationId: 'getMerchantReviewQueue',
        description:
          'Spec 4.1 step 7. Merge candidates are pairs of merchants similar enough to be worth ' +
          'asking about, and provisional merchants are descriptors the chain cleaned but never ' +
          'resolved. Nothing here has been applied — a merge is a user action (spec 4.3).',
        tags: ['merchants'],
        response: {
          200: ref('MerchantReviewQueue'),
          ...errorResponses,
        },
      },
    },
    async () => {
      const subjects = context.store.merchants.list().map(
        (merchant): MergeSubject & { displayName: string } => ({
          merchantId: merchant.id,
          canonicalName: merchant.canonicalName,
          displayName: merchant.displayName,
          // Both flags on, matching §6.3's bulk path: a row hidden by either
          // default still rides on this merchant and still moves with a merge, so
          // counting it out would understate what the user is authorising.
          transactionCount: context.store.transactions.countMatching({
            merchantIds: [merchant.id],
            includeInternalTransfers: true,
            includeExcluded: true,
          }),
          source: merchant.source,
        }),
      );

      const byId = new Map(subjects.map((subject) => [subject.merchantId, subject]));
      const merchants = new Map(context.store.merchants.list().map((row) => [row.id, row]));
      const llmProposals = context.store.llm.listProposals(['pending', 'blocked']);

      const describe = (subject: MergeSubject) => ({
        merchant: merchants.get(subject.merchantId),
        transactionCount: subject.transactionCount,
        sampleDescriptors: context.store.transactions
          .listMatchingDescriptors({
            merchantIds: [subject.merchantId],
            includeInternalTransfers: true,
            includeExcluded: true,
          })
          .slice(0, 3),
      });

      return {
        mergeCandidates: proposeMerchantMerges(subjects).map((candidate) => ({
          keep: describe(byId.get(candidate.keep.merchantId) ?? candidate.keep),
          merge: describe(byId.get(candidate.merge.merchantId) ?? candidate.merge),
          similarity: candidate.similarity,
        })),
        // §4.1 step 7: an unmatched descriptor "becomes a provisional merchant,
        // marked `source = 'rule'`, and joins the review queue".
        provisional: subjects
          .filter((subject) => subject.source === 'rule')
          .sort((a, b) => b.transactionCount - a.transactionCount)
          .map(describe),
        // §2.3's "sub-floor LLM proposals", which §4.2 says "sit in the review
        // queue and apply to nothing" — plus everything the settled-series
        // exception withheld at any confidence. `applied` is excluded: it wrote an
        // alias and is visible as one, and a queue that listed answered questions
        // is a queue nobody finishes reading.
        llmProposals,
        llmProposalsUnavailableReason: llmProposalsUnavailableReason(
          readLlmSettings(context).providerId,
          llmProposals.length,
        ),
      };
    },
  );

  /**
   * §4.3's correction, aimed at a merchant instead of a transaction.
   *
   * The queue above proposes; this is the only thing that acts, and it is composed
   * entirely of parts §4.3 already owns: every descriptor spelling of the losing
   * merchant becomes a `user` alias pointing at the surviving one, and the
   * coalesced re-normalize job sweeps the history and re-runs the analyzers. So a
   * merge is a bulk merchant correction with the descriptor list filled in for the
   * user, and it inherits §4.3's guarantees rather than restating them — permanent,
   * top-precedence, immune to a later re-seed or a better model.
   *
   * `user` aliases and not a row in `merchant_canonical`: the merchants both stay,
   * and what changes is which one their descriptors resolve to. That keeps the
   * merge reversible by the same mechanism that made it — correct one descriptor
   * back and its rows follow — where deleting a merchant would not be.
   */
  app.post<{ Params: { id: string }; Body: { intoMerchantId: string } }>(
    '/api/merchants/:id/merge',
    {
      schema: {
        summary: 'Treat this merchant as another one, retroactively',
        operationId: 'mergeMerchant',
        description:
          'Writes a `user` alias for every descriptor spelling of `:id` pointing at ' +
          '`intoMerchantId`, then enqueues spec 4.3’s re-normalize job, which repoints the ' +
          'history and re-runs the analyzers. Permanent and top-precedence (spec 4.3).',
        tags: ['merchants'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          required: ['intoMerchantId'],
          properties: { intoMerchantId: { type: 'string', minLength: 1 } },
        },
        response: { 200: ref('MerchantMergeResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { intoMerchantId } = request.body;

      if (!context.store.merchants.get(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
      }
      if (!context.store.merchants.get(intoMerchantId)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such target merchant' });
      }
      if (id === intoMerchantId) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'a merchant cannot be merged into itself',
        });
      }

      const selector = {
        merchantIds: [id],
        includeInternalTransfers: true,
        includeExcluded: true,
      };
      const descriptors = context.store.transactions.listMatchingDescriptors(selector);
      const transactionsAffected = context.store.transactions.countMatching(selector);

      const aliasKeysWritten = writeUserMerchantAlias(context, descriptors, intoMerchantId);
      // Alias keys rather than transaction ids: the ids are the rows that exist
      // now, the keys are every row that ever spells the merchant this way,
      // including ones a later import brings in. §4.3's sweep reads both.
      const { id: jobId, coalesced } = enqueueRenormalize(context, {
        transactionIds: [],
        aliasKeys: aliasKeysWritten,
      });

      return { merchantId: intoMerchantId, aliasKeysWritten, transactionsAffected, jobId, coalesced };
    },
  );

  /**
   * §2.3's `PATCH /api/merchants/:id`.
   *
   * ## What it changes, and what it deliberately does not
   *
   * `canonicalName` is not in the body. It is the merchant's identity — §3.2 makes
   * it UNIQUE and §4.1 step 7 resolves cleaned descriptors *through* it — so
   * editing it would leave the next import computing the old name, failing to find
   * the row, and making a second merchant out of it. `displayName` is the one a
   * person reads, and is what this changes. `source` is not in the body either:
   * provenance is not self-assigned (§7.5). The store moves the row to `user`
   * as a consequence, which is the argument in `MerchantRepository.update`.
   *
   * ## Why no re-normalize job
   *
   * Nothing here changes which merchant a descriptor resolves to. §4.3's sweep
   * exists to repoint history after a *grouping* changes; these fields are
   * properties of a merchant that is already the right one, so the rows behind it
   * are already correct and there is nothing to move.
   *
   * The analyzers are a different question, and the answer is deliberately still
   * no. `isKnownSubscription` and `defaultCategoryId` are read by §5.2 and §2.5,
   * so a finding computed before this call may now be stale — but §5.1 already
   * has the mechanism for that (`config_hash`, `evidence_hash`) and §2.7 already
   * has the trigger (Run analysis). Kicking off an analysis run from a rename
   * would make a cheap edit expensive and surprising, and would do it once per
   * keystroke-sized change while somebody works down a list of twenty merchants.
   */
  app.patch<{
    Params: { id: string };
    Body: {
      displayName?: string;
      website?: string | null;
      defaultCategoryId?: string | null;
      overlapGroup?: string | null;
      isKnownSubscription?: boolean;
      isTransferKind?: boolean;
    };
  }>(
    '/api/merchants/:id',
    {
      schema: {
        summary: 'Rename a merchant, or change what the rules know about it',
        operationId: 'updateMerchant',
        description:
          '`canonicalName` is not editable — spec 4.1 step 7 resolves cleaned descriptors ' +
          'through it, so changing it would make the next import create a second merchant. ' +
          'Editing moves the row to `source: user` (spec 4.3), which is what stops a later ' +
          'seed or re-normalize from overwriting the judgement. Does **not** re-run the ' +
          'analyzers: run analysis to pick up a changed `isKnownSubscription` (spec 5.2).',
        tags: ['merchants'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            displayName: { type: 'string', minLength: 1 },
            website: { type: ['string', 'null'] },
            defaultCategoryId: { type: ['string', 'null'] },
            overlapGroup: { type: ['string', 'null'] },
            isKnownSubscription: { type: 'boolean' },
            isTransferKind: { type: 'boolean' },
          },
        },
        response: { 200: ref('Merchant'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.merchants.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
      }

      // §3.2 RESTRICTs `merchant_canonical.default_category_id`, so an unknown id
      // would surface as a constraint violation. Checked here so the answer is
      // the reason rather than a 500 naming a foreign key.
      const { defaultCategoryId } = request.body;
      if (defaultCategoryId != null && !context.store.merchants.getCategory(defaultCategoryId)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such category' });
      }

      return context.store.merchants.update(request.params.id, request.body);
    },
  );

  /**
   * §2.3's `POST /api/merchants/aliases`.
   *
   * ## One owner for the alias table
   *
   * This file's header used to give the reason both these routes were unbuilt:
   * an alias write "happens as a consequence of the transaction edit (§4.3)
   * rather than as a call the UI makes itself, and half-built endpoints teach the
   * wrong model of who owns the alias table". That worry is answered rather than
   * ignored — this route does not touch `upsertAlias`. It calls
   * `writeUserMerchantAlias`, the same composition-root function §6.3's
   * correction and the merge above both go through, so there is still exactly one
   * path that writes a `user` alias and exactly one place its rules live.
   *
   * ## And it enqueues the sweep, because it changes a grouping
   *
   * Unlike the `PATCH` above, this one *does* move history: the point of writing
   * an alias by hand is that rows currently resolving elsewhere should resolve
   * here. §4.3's job is what makes that true of the rows already stored, so it is
   * enqueued exactly as the merge enqueues it — and coalesced, so somebody
   * entering four spellings books one sweep.
   */
  app.post<{ Body: { merchantId: string; aliasKeys: string[] } }>(
    '/api/merchants/aliases',
    {
      schema: {
        summary: 'Point one or more descriptor spellings at a merchant',
        operationId: 'createMerchantAliases',
        description:
          'Writes a `user` alias per key — permanent and top-precedence (spec 4.3) — then ' +
          'enqueues spec 4.3’s re-normalize job so the stored rows follow. The same write ' +
          'path as a spec 6.3 correction and a merchant merge, so the alias table has one ' +
          'owner. Keys are `description_normalized` values, which is what spec 4.1 matches on.',
        tags: ['merchants'],
        body: {
          type: 'object',
          required: ['merchantId', 'aliasKeys'],
          properties: {
            merchantId: { type: 'string', minLength: 1 },
            aliasKeys: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
        response: { 200: ref('MerchantAliasResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { merchantId, aliasKeys } = request.body;

      if (!context.store.merchants.get(merchantId)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
      }

      const aliasKeysWritten = writeUserMerchantAlias(context, aliasKeys, merchantId);
      if (aliasKeysWritten.length === 0) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'every alias key was blank once trimmed',
        });
      }

      const { id: jobId, coalesced } = enqueueRenormalize(context, {
        transactionIds: [],
        aliasKeys: aliasKeysWritten,
      });

      return { merchantId, aliasKeysWritten, jobId, coalesced };
    },
  );
}

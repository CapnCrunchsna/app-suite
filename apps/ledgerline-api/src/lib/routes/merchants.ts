/**
 * `GET /api/merchants` (§2.3), the category list behind it, §4.1 step 7's review
 * queue, and the one action that resolves what the queue asks.
 *
 * §2.3's `PATCH /api/merchants/:id` and `POST /api/merchants/aliases` remain
 * unbuilt: the alias write a merchant *correction* makes still happens as a
 * consequence of the transaction edit (§4.3) rather than as a call the UI makes
 * itself, and half-built endpoints teach the wrong model of who owns the alias
 * table.
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
import { enqueueRenormalize, writeUserMerchantAlias } from '../merchant-corrections.js';

/** §4.2's stage needs §2.4's provider seam, which is not built. Stated on the
 *  response rather than omitted, for the reason §6.8 gives about absences. */
const LLM_PROPOSALS_UNAVAILABLE =
  'Spec 4.2’s LLM stage needs spec 2.4’s provider seam, which is not built. No ' +
  'descriptor has been sent anywhere, so there are no proposals to review.';

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
        llmProposals: [],
        llmProposalsUnavailableReason: LLM_PROPOSALS_UNAVAILABLE,
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

  app.get(
    '/api/categories',
    {
      schema: {
        summary: 'Spend categories',
        operationId: 'listCategories',
        tags: ['merchants'],
        response: {
          200: { type: 'array', items: ref('Category') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.merchants.listCategories(),
  );
}

/**
 * `GET /api/merchants` (§2.3), the category list behind it, and §4.1 step 7's
 * review queue.
 *
 * The alias write a merchant correction makes still happens as a consequence of
 * the transaction edit (§4.3) rather than as a call the UI makes itself, so §2.3's
 * `PATCH /api/merchants/:id` and `POST /api/merchants/aliases` remain unbuilt —
 * half-built endpoints teach the wrong model of who owns the alias table.
 *
 * ## Why the review queue is a read
 *
 * §4.1's chain is deliberately unable to settle some questions — `SAMSCLUB` and
 * `SAMS CLUB` differ by a space the bank chose, both run the chain cleanly, and
 * neither is wrong. §4.1 stage 4 argues the general case for not guessing: "over-
 * stripping silently merges two merchants and every §5 rule groups by merchant."
 *
 * So the chain stops, and this endpoint is how the unanswered questions reach a
 * person. It proposes and never decides: everything here is a `GET`, and the only
 * thing that changes a merchant is a user action §4.3 already governs.
 */

import type { FastifyInstance } from 'fastify';
import { proposeMerchantMerges } from '@metrum/ledgerline-normalize';
import type { MergeSubject } from '@metrum/ledgerline-normalize';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

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

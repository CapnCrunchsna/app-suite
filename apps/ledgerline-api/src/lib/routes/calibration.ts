/**
 * §7.6's corpus, written and read — `/api/transactions/:id/label` and
 * `/api/calibration` (§9ab).
 *
 * §7.6 has been the standing caveat on every §5 number since this document was
 * written, and it names one remedy: "a hand-labelled year of real statements with the
 * expected findings written down". §9z built the half that judges findings after they
 * fire. This is the half that says what *should* fire, which is the only thing that
 * can measure a miss.
 *
 * ## The write captures the machine's answer, and the caller cannot forget to
 *
 * Every label records `chain_merchant_id` — what §4.1 had concluded for that row at
 * the moment of the judgement — and it is read off the transaction here rather than
 * accepted from the client. A labeller correcting a merchant would otherwise destroy
 * the evidence their correction produced: after the fix the chain looks right, and
 * nothing remembers that it was not.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import { calibration } from '../calibration-service.js';
import type { LedgerlineContext } from '../context.js';

interface LabelBody {
  readonly expectedMerchantId?: string | null;
  readonly isRecurring?: boolean | null;
  readonly isFee?: boolean | null;
  readonly isTransfer?: boolean | null;
  readonly isOutlier?: boolean | null;
  readonly note?: string | null;
}

/** `undefined` leaves a field alone, `null` clears it. Both have to survive JSON, so
 *  the schema admits null explicitly and the handler passes the property through only
 *  when it was actually sent. */
const nullableBool = { type: ['boolean', 'null'] } as const;

export function registerCalibrationRoutes(
  app: FastifyInstance,
  context: LedgerlineContext,
): void {
  app.put<{ Params: { id: string }; Body: LabelBody }>(
    '/api/transactions/:id/label',
    {
      schema: {
        summary: 'Record what this row really is (spec 7.6)',
        operationId: 'labelTransaction',
        description:
          'Spec 7.6’s corpus, written against the ledger rather than against findings — ' +
          'which is what makes it able to measure what the rules **missed**. Every field is ' +
          'three-valued: absent leaves it alone, `null` clears it back to "not asserted", ' +
          'and a boolean asserts. That distinction is load-bearing: an unlabelled row and a ' +
          'row labelled "not a fee" are different facts, and treating them alike would count ' +
          'every unexamined transaction as evidence the rules are right.',
        tags: ['calibration'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            expectedMerchantId: { type: ['string', 'null'] },
            isRecurring: nullableBool,
            isFee: nullableBool,
            isTransfer: nullableBool,
            isOutlier: nullableBool,
            note: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
        response: { 200: ref('TransactionLabel'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const transaction = context.store.transactions.get(request.params.id);
      if (!transaction) {
        return reply.code(404).send({ error: 'not_found', message: 'no such transaction' });
      }

      if (
        request.body.expectedMerchantId != null &&
        !context.store.merchants.get(request.body.expectedMerchantId)
      ) {
        return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
      }

      return context.store.transactionLabels.put({
        transactionId: transaction.id,
        ...request.body,
        // Read from the row, never from the client — see the header.
        chainMerchantId: transaction.merchantId,
        chainDescriptionNormalized: transaction.descriptionNormalized,
        origin: 'review',
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/transactions/:id/label',
    {
      schema: {
        summary: 'Withdraw a judgement (spec 7.6)',
        operationId: 'unlabelTransaction',
        description:
          'Removes the row from the corpus entirely, which is different from asserting ' +
          'everything false about it — a withdrawn judgement is one nobody has made.',
        tags: ['calibration'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: {
          200: { type: 'object', required: ['removed'], properties: { removed: { type: 'boolean' } } },
          ...errorResponses,
        },
      },
    },
    async (request) => ({ removed: context.store.transactionLabels.remove(request.params.id) }),
  );

  app.get(
    '/api/calibration',
    {
      schema: {
        summary: 'What the corpus says about the rules (spec 7.6)',
        operationId: 'getCalibration',
        description:
          'Precision from spec 9z’s finding labels, recall from spec 9ab’s transaction ' +
          'labels, and spec 4’s normalization accuracy from the merchant every label ' +
          'carries. Counts throughout and never a percentage: eleven judgements do not ' +
          'support "82% accurate", and two figures shaped like rates invite being divided ' +
          'into each other.',
        tags: ['calibration'],
        response: { 200: ref('Calibration'), ...errorResponses },
      },
    },
    async () => calibration(context),
  );
}

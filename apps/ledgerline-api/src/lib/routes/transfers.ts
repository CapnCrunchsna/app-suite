/**
 * `/api/transfers` — §2.3's three transfer routes, and the list §6.2 needs to
 * render them.
 *
 * ## Why there is a GET that §2.3 does not name
 *
 * §2.3's table names `POST /propose`, `POST /:id/confirm` and `DELETE /:id` — the
 * three *verbs*. §6.2 then requires "a Possible Transfers queue [with] proposed
 * pairs with both rows, the score's reasons, and the dollar effect of confirming",
 * and there is no route in that table a page could read it from. A queue that
 * cannot be listed is the same "nowhere to appear" problem §6.4 was built to fix.
 * `GET /api/transfers` is that read. Recorded in §9f.
 *
 * ## Confirm and reject both move money, so both say so first
 *
 * Confirming takes `spendReductionCents` out of every spend total; rejecting an
 * auto-link puts it back. The queue is handed both numbers before either button
 * is pressed, and both operations are reversible by the other — which is why
 * `DELETE` writes state `rejected` rather than deleting the row. A deleted row is
 * one the next pass re-proposes, so "no, that is not a transfer" would have to be
 * said once a month forever.
 */

import type { FastifyInstance } from 'fastify';

import type { TransferLinkState, TransferLinkView } from '@metrum/ledgerline-data';

import { errorResponses } from './errors.js';
import { ref, TRANSFER_LINK_STATES } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { confirmTransfer, parseTransferDetail, runTransferLinking } from '../transfer-service.js';

const csv = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === ''
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

/**
 * One link group on the wire.
 *
 * `reasons` and `kind` come out of `detail_json`, which the matcher wrote when it
 * proposed the pair. Re-deriving them here would mean scoring against a snapshot
 * that has since moved — showing the user reasons for confirming that are not the
 * reasons the pair was offered under.
 */
function toWire(view: TransferLinkView) {
  const detail = parseTransferDetail(view.detailJson);

  return {
    id: view.id,
    state: view.state,
    kind: detail?.kind ?? (view.debits.length > 1 ? 'partial' : 'one_to_one'),
    score: view.score,
    reasons: detail?.reasons ?? [],
    debits: view.debits,
    credit: view.credit,
    debitAccount: view.debitAccount,
    creditAccount: view.creditAccount,
    amountCents: detail?.amountCents ?? Math.abs(view.credit.amountCents),
    spendReductionCents: view.spendReductionCents,
    dayGapDays: detail?.dayGapDays ?? 0,
    createdAt: view.links[0].createdAt,
    updatedAt: view.links[0].updatedAt,
  };
}

export function registerTransferRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get<{ Querystring: { states?: string; accountIds?: string } }>(
    '/api/transfers',
    {
      schema: {
        summary: 'Spec 6.2’s Possible Transfers queue',
        operationId: 'listTransfers',
        description:
          'Defaults to the pairs awaiting a decision. A `proposed` pair is **not** excluded ' +
          'from spend until it is confirmed (spec 2.6), so this list is the difference between ' +
          'the totals on screen and the totals the user would get by agreeing with all of it.',
        tags: ['transfers'],
        querystring: {
          type: 'object',
          properties: {
            states: {
              type: 'string',
              description: `Comma-separated: ${TRANSFER_LINK_STATES.join(', ')}. Defaults to proposed.`,
            },
            accountIds: { type: 'string', description: 'Comma-separated account ids, either side' },
          },
        },
        response: {
          200: { type: 'array', items: ref('TransferLink') },
          ...errorResponses,
        },
      },
    },
    async (request) =>
      context.store.transfers
        .list({
          states: (csv(request.query.states) as TransferLinkState[] | undefined) ?? ['proposed'],
          accountIds: csv(request.query.accountIds),
        })
        .map(toWire),
  );

  /**
   * §2.3's `POST /api/transfers/propose`.
   *
   * Synchronous, unlike `POST /api/analysis/run`. Both read the whole snapshot,
   * but this one then runs a single bucketed pass rather than nine rules over it
   * (§2.2's index note is what makes that true), and §6.2's queue is the thing the
   * user is standing in front of when they press the button. A job id would make
   * them poll for a list that is already computed. Recorded in §9f.
   */
  app.post(
    '/api/transfers/propose',
    {
      schema: {
        summary: 'Re-run spec 2.6’s matcher over everything',
        operationId: 'proposeTransfers',
        description:
          'Replaces every machine-owned link: pairs scoring at or above the auto threshold are ' +
          'linked and leave the spend totals, the rest go to spec 6.2’s queue, and a link this ' +
          'pass no longer produces is withdrawn. Confirmed and rejected links are untouched.',
        tags: ['transfers'],
        response: { 200: ref('TransferProposeResult'), ...errorResponses },
      },
    },
    async () => runTransferLinking(context),
  );

  app.post<{ Params: { id: string } }>(
    '/api/transfers/:id/confirm',
    {
      schema: {
        summary: 'Confirm a proposed transfer',
        operationId: 'confirmTransfer',
        description:
          'Both sides leave every spend total, and spec 2.6’s learning writes a `transfer_rule` ' +
          'so the same pairing auto-links next month. Reversible: `DELETE /api/transfers/:id` ' +
          'puts it all back. A partial payment (spec 2.6’s second pass) is confirmed as a whole ' +
          'group and teaches no rule.',
        tags: ['transfers'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('TransferLink'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const view = confirmTransfer(context, request.params.id);
      if (!view) return reply.code(404).send({ error: 'not_found', message: 'no such transfer' });
      return toWire(view);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/transfers/:id',
    {
      schema: {
        summary: 'Reject a transfer link, or undo a confirmed one',
        operationId: 'rejectTransfer',
        description:
          'Sets state `rejected` rather than deleting the row, so the decision survives the ' +
          'next pass — a deleted row is one the matcher re-proposes. Any flags the link set are ' +
          'cleared, which puts the money back into the spend totals. Reversible with ' +
          '`POST /api/transfers/:id/confirm`.',
        tags: ['transfers'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('TransferLink'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const view = context.store.transfers.reject(request.params.id);
      if (!view) return reply.code(404).send({ error: 'not_found', message: 'no such transfer' });
      return toWire(view);
    },
  );
}

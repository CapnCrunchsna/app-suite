/**
 * `GET /api/jobs/:id` and `GET /api/jobs` (§2.3, §2.7).
 *
 * Two reads and one write. The reads are what the sentence at the end of §6.3 needs:
 * corrections "enqueue a coalesced re-normalize job (§2.7); the UI shows its
 * progress rather than blocking."
 *
 * The write is `POST /api/jobs/renormalize`, and it was deliberately absent until
 * §9v. An *incremental* re-normalize is never something a user asks for — it is a
 * consequence of a merchant correction (§4.3), enqueued by the transaction route
 * that made it, and an endpoint for it would have been a button for a thing that
 * already happens. §2.7's **full sweep** is the opposite: "available explicitly from
 * Settings", and nothing else can ask for it.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { enqueueRenormalize } from '../merchant-corrections.js';

export function registerJobRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
    {
      schema: {
        summary: 'One job’s state and progress',
        operationId: 'getJob',
        description: 'Spec 2.7: the UI polls this rather than blocking on the work.',
        tags: ['jobs'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('Job'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const job = context.store.jobs.get(request.params.id);
      if (!job) return reply.code(404).send({ error: 'not_found', message: 'no such job' });
      return job;
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/api/jobs',
    {
      schema: {
        summary: 'Recent jobs, newest first',
        operationId: 'listJobs',
        tags: ['jobs'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: { type: 'array', items: ref('Job') },
          ...errorResponses,
        },
      },
    },
    async (request) => context.store.jobs.list(request.query.limit),
  );

  /**
   * §2.3's `POST /api/jobs/renormalize`, and §2.7's "a full sweep is available
   * explicitly from Settings".
   *
   * **Explicitly** is the operative word and is why this is the only shape the route
   * takes. The incremental re-normalize is never something a user asks for — it is a
   * consequence of a correction, enqueued by the route that made it (§4.3). What
   * nothing could ask for until now is the sweep: re-run §4.1's chain over every
   * stored row from its raw descriptor, because the chain itself changed (§9o, §9v).
   *
   * Enqueues and returns a job id, per §2.7. It coalesces with any queued
   * re-normalize rather than stacking, and the merged job is a sweep — which loses
   * nothing, because a sweep re-resolves every row the incremental path would have.
   */
  app.post(
    '/api/jobs/renormalize',
    {
      schema: {
        summary: 'Re-run spec 4.1’s chain over every stored transaction',
        operationId: 'renormalizeAll',
        description:
          'Spec 2.7’s full sweep. Re-resolves every row from its raw descriptor rather than ' +
          'from the grouping the old chain produced, so a chain amendment reaches rows that ' +
          'were imported before it. Rewrites `description_normalized` and the merchant, and ' +
          'the category where spec 4.3 allows it; never `dedupe_key`, which spec 3.3 computes ' +
          'through the frozen `collapse_v1`. Only rows the chain no longer agrees with are ' +
          'written. Ends by re-running the analysis, like every other re-normalize.',
        tags: ['jobs'],
        response: {
          202: {
            type: 'object',
            required: ['id', 'coalesced', 'transactions'],
            properties: {
              id: { type: 'string' },
              /** Spec 2.7: a second request while one is queued merges into it. */
              coalesced: { type: 'boolean' },
              /** What the sweep will walk. Returned now because the job is
               *  asynchronous and "this will take a moment" is more useful with a
               *  number attached. */
              transactions: { type: 'integer' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (_request, reply) => {
      const { id, coalesced } = enqueueRenormalize(context, {
        transactionIds: [],
        aliasKeys: [],
        full: true,
      });

      return reply.code(202).send({
        id,
        coalesced,
        transactions: context.store.transactions.countAll(),
      });
    },
  );
}

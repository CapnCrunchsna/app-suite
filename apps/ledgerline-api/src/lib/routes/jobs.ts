/**
 * `GET /api/jobs/:id` and `GET /api/jobs` (§2.3, §2.7).
 *
 * Reads only. §2.7's producers are `POST /api/jobs/renormalize` and
 * `POST /api/analysis/run`; neither is exposed here, because on this page a
 * re-normalize is never something the user asks for directly — it is a
 * consequence of a merchant correction (§4.3), enqueued by the transaction route
 * that made the correction. And the runner that would move a job out of `queued`
 * is separate work.
 *
 * So what this exists for is the sentence at the end of §6.3: corrections
 * "enqueue a coalesced re-normalize job (§2.7); the UI shows its progress rather
 * than blocking." This is what it reads to show it.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

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
}

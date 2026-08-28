/**
 * `/api/llm/*` — §2.3's provider health probe, and the two surfaces §6.8 needs
 * behind it.
 *
 * §2.3 lists one route here: "`GET /api/settings` · `PATCH` · `GET /api/llm/health`
 * — Config, analyzer thresholds, provider health probe." The other two are §9s
 * amendments, and both exist because §6.8 asks for something to be *shown* without
 * saying what serves it:
 *
 *   - `GET /api/llm/degraded-calls` — §6.8's Data section: "the degraded-LLM-call log".
 *   - `POST /api/llm/propose-merchants` — §4.2's stage has to be started by something.
 *
 * ## Why the proposal run is a route and not part of import
 *
 * §4.2 puts the LLM "only at step 7" of §4.1's chain, which runs inside an import
 * commit. §2.7 is the reason it cannot stay there: "two operations in this design
 * cannot run inside an HTTP request", and a batch of fifty descriptors through the
 * Claude CLI is seconds per call by §2.4's own account. So this enqueues §2.7's job
 * and returns its id, exactly as `POST /api/analysis/run` does, and the UI polls.
 *
 * An explicit trigger also matters for a reason §2.4 cares about more than latency:
 * with `claude-cli` selected, this route is the moment descriptors leave the
 * machine. Running it as a silent consequence of dropping a file on the import page
 * would make that a thing the app does, rather than a thing the user asks for.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { createLlmProvider, readLlmSettings } from '../llm-service.js';
import { LLM_PROPOSAL_JOB } from '../job-runner.js';

export function registerLlmRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get(
    '/api/llm/health',
    {
      schema: {
        summary: 'Spec 6.8’s Test Connection, against the configured provider',
        operationId: 'getLlmHealth',
        description:
          'Probes whichever provider spec 2.4 is currently configured. `none` answers ' +
          '`ok: false` with "LLM disabled" rather than a green tick, because there is nothing ' +
          'to connect to and a tick would teach the button to mean nothing. Ollama’s answer ' +
          'distinguishes "not running" from "running but the model is not pulled" and names ' +
          'the fix. Never cached — a remembered "ok" is the one answer this must not give.',
        tags: ['llm'],
        response: { 200: ref('LlmHealth'), ...errorResponses },
      },
    },
    async () => {
      // Uncached deliberately: see the description. `createLlmProvider` reads the
      // settings row on every call, so a provider changed a second ago is the one
      // probed rather than the one this process booted with.
      const provider = createLlmProvider(context, { uncached: true });
      const health = await provider.health();

      return {
        providerId: provider.id,
        ok: health.ok,
        detail: health.detail,
        model: health.model ?? null,
        sendsDataOffMachine: provider.sendsDataOffMachine,
        capabilities: provider.capabilities(),
      };
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    '/api/llm/degraded-calls',
    {
      schema: {
        summary: 'Spec 6.8’s degraded-LLM-call log',
        operationId: 'listDegradedCalls',
        description:
          'Every call that fell back to the deterministic path, newest first. Spec 2.4: ' +
          '"a run of degraded calls is how a user discovers Ollama has been down for a week ' +
          'while the app quietly carried on working." The list is capped and `total` is not, ' +
          'so a page can say "50 of 412" rather than implying 50 is all there was.',
        tags: ['llm'],
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
        },
        response: { 200: ref('DegradedCallLog'), ...errorResponses },
      },
    },
    async (request) => ({
      entries: context.store.llm.listDegraded(request.query.limit ?? 50),
      total: context.store.llm.countDegraded(),
    }),
  );

  /**
   * §4.2's stage, started.
   *
   * Returns a job id rather than the result, per §2.7. The response also carries
   * the provider that will run it, because with `none` configured the honest thing
   * to tell the page is "this will do nothing" before it spends thirty seconds
   * polling a job to discover the same.
   */
  app.post(
    '/api/llm/propose-merchants',
    {
      schema: {
        summary: 'Ask the configured provider about unresolved descriptors (spec 4.2)',
        operationId: 'proposeMerchants',
        description:
          'Batches spec 4.1 step 7’s unresolved descriptors, ~50 per call, as descriptor ' +
          'strings only — no amounts, no dates, no account numbers, and nothing on spec 2.4’s ' +
          'P2P filter list. At or above 0.85 a proposal writes a `source = "llm"` alias and ' +
          'applies provisionally; below it, or wherever it would disturb a settled recurring ' +
          'series, it goes to the review queue and applies to nothing. Enqueues spec 2.7’s job ' +
          'and returns its id.',
        tags: ['llm'],
        response: {
          202: {
            type: 'object',
            required: ['jobId', 'providerId', 'willDoNothing'],
            properties: {
              jobId: { type: 'string' },
              providerId: { type: 'string' },
              /** True with `none` configured. Said up front rather than discovered
               *  by polling a job that succeeds having done nothing. */
              willDoNothing: { type: 'boolean' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (_request, reply) => {
      const settings = readLlmSettings(context);
      const { job } = context.store.jobs.enqueueCoalesced({
        kind: LLM_PROPOSAL_JOB,
        mergePayload: () => JSON.stringify({}),
        message: 'asking about unresolved descriptors',
      });
      context.jobRunner.schedule();

      return reply.code(202).send({
        jobId: job.id,
        providerId: settings.providerId,
        willDoNothing: settings.providerId === 'none',
      });
    },
  );
}

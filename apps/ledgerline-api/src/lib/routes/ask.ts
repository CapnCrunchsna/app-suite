/**
 * `POST /api/ask` — §2.3's Q&A route.
 *
 * §2.3 states the whole contract in one line: "Q&A. `409` with a machine-readable
 * reason when provider is `none`."
 *
 * ## Why `none` is a 409 and not an empty answer
 *
 * Every other degradation in this system returns the deterministic answer, because
 * there always is one — §2.4's whole design is that a provider only ever *improves*
 * on something already computed. Ask is the one feature with no deterministic half:
 * nothing but a model turns a sentence into one of §6.7's six queries. So there is
 * no fallback to return, and the honest status is "this cannot be done in the state
 * you have configured" rather than a 200 carrying nothing.
 *
 * 409 rather than 501 or 400 for the same reason: the request is well formed and the
 * feature exists — the *conflict* is with a setting, and the setting is one the user
 * can change. The error code says which one, so §6.7's page can link straight to it
 * rather than parsing prose.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { runAsk } from '../ask/ask-service.js';
import { readLlmSettings } from '../llm-service.js';

export function registerAskRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.post<{ Body: { question: string } }>(
    '/api/ask',
    {
      schema: {
        summary: 'Ask a question about the ledger (spec 6.7)',
        operationId: 'ask',
        description:
          'Not text-to-SQL. The model chooses one of six validated query functions, the ' +
          'function runs deterministically, and the model then writes prose over what it ' +
          'returned — with every numeric token in that prose checked against the result ' +
          'before it is shown. Row-level queries send the provider a count, the totals and ' +
          'at most twenty redacted descriptors; the rows themselves never leave. Answers ' +
          '`409 llm_disabled` when no provider is configured, because choosing a query is ' +
          'the one step with no deterministic equivalent.',
        tags: ['llm'],
        body: {
          type: 'object',
          required: ['question'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
        response: { 200: ref('AskResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const settings = readLlmSettings(context);

      if (settings.providerId === 'none') {
        // The machine-readable half is `error`; the prose is for a page that has
        // nowhere better to put it. §6.7 wants "a clear explanation and a link to
        // Settings", and the link is the page's to render — this says which setting.
        return reply.code(409).send({
          error: 'llm_disabled',
          message:
            'Ask needs an LLM provider, and none is configured. Unlike the rest of Ledgerline ' +
            'there is no deterministic answer here — nothing but a model turns a question into ' +
            'a query. Choose Ollama in Settings to keep everything on this machine.',
        });
      }

      return runAsk(context, { question: request.body.question });
    },
  );
}

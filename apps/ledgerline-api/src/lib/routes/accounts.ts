/**
 * `/api/accounts` — §2.3's account CRUD, plus §6.2's coverage bar and merge.
 *
 * Deletion is not exposed. §6.2's destructive action is *archive*, and §3.2's
 * `ON DELETE RESTRICT` would refuse an account with imports anyway; offering a
 * DELETE that only ever works on empty accounts is an endpoint that teaches the
 * wrong model. The merge below archives its source for the same reason.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ACCOUNT_TYPES, ref } from './schemas.js';
import { resolveAnalyzerConfig } from '../analysis-service.js';
import type { LedgerlineContext } from '../context.js';
import { runTransferLinking } from '../transfer-service.js';

const accountSchema = ref('Account');

export function registerAccountRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get(
    '/api/accounts',
    {
      schema: {
        summary: 'List accounts',
        operationId: 'listAccounts',
        tags: ['accounts'],
        response: {
          200: { type: 'array', items: accountSchema },
          ...errorResponses,
        },
      },
    },
    async () => context.store.accounts.list(),
  );

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id',
    {
      schema: {
        summary: 'Get one account',
        operationId: 'getAccount',
        tags: ['accounts'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: accountSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const account = context.store.accounts.get(request.params.id);
      if (!account) return reply.code(404).send({ error: 'not_found', message: 'no such account' });
      return account;
    },
  );

  app.post<{
    Body: {
      displayName: string;
      accountType: (typeof ACCOUNT_TYPES)[number];
      institution?: string | null;
      last4?: string | null;
    };
  }>(
    '/api/accounts',
    {
      schema: {
        summary: 'Create an account',
        operationId: 'createAccount',
        tags: ['accounts'],
        body: {
          type: 'object',
          required: ['displayName', 'accountType'],
          properties: {
            displayName: { type: 'string', minLength: 1 },
            accountType: { type: 'string', enum: ACCOUNT_TYPES },
            institution: { type: ['string', 'null'] },
            last4: { type: ['string', 'null'] },
          },
        },
        response: { 201: accountSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(context.store.accounts.create(request.body)),
  );

  app.patch<{
    Params: { id: string };
    Body: {
      displayName?: string;
      institution?: string | null;
      accountType?: (typeof ACCOUNT_TYPES)[number];
      last4?: string | null;
      isActive?: boolean;
    };
  }>(
    '/api/accounts/:id',
    {
      schema: {
        summary: 'Update an account',
        operationId: 'updateAccount',
        description: 'Archiving is `isActive: false` — see spec 6.2.',
        tags: ['accounts'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            displayName: { type: 'string', minLength: 1 },
            institution: { type: ['string', 'null'] },
            accountType: { type: 'string', enum: ACCOUNT_TYPES },
            last4: { type: ['string', 'null'] },
            isActive: { type: 'boolean' },
          },
        },
        response: { 200: accountSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.accounts.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such account' });
      }
      return context.store.accounts.update(request.params.id, request.body);
    },
  );

  /**
   * §6.2's coverage bar, sourced exactly where that section says: statement
   * periods, never transaction dates (§7.2).
   *
   * The `unmatchedTransferCount` rides along because §6.2 asks the page to say
   * where coverage is incomplete, and §2.6's "What this cannot do" names the
   * other half of incompleteness: "A transfer to an account not in the system has
   * no counterpart and will never link, so it counts as spend." A month can be
   * fully covered and still be missing the account the money went to.
   */
  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/coverage',
    {
      schema: {
        summary: 'Per-month statement coverage for spec 6.2’s coverage bar',
        operationId: 'getAccountCoverage',
        description:
          'A month is covered when a single committed import’s `[period_start, period_end]` ' +
          'spans it (spec 7.2). Derived from statements rather than from transaction dates: an ' +
          'account can be covered for a month in which nothing was spent, and reading that as a ' +
          'missing statement is what turns a quiet month into a lapsed subscription.',
        tags: ['accounts'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('AccountCoverage'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.accounts.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such account' });
      }

      const coverage = context.store.accounts.coverage(request.params.id);
      return {
        ...coverage,
        // §7.4: the keyword list is config, hashed into `config_hash`, and
        // `data` may not reach the lib that holds it — so the composition root
        // carries it across, exactly as it does the analyzer thresholds.
        unmatchedTransferCount: context.store.transactions.countUnlinkedTransferDebits(
          request.params.id,
          resolveAnalyzerConfig(context).transfers.keywords,
        ),
      };
    },
  );

  /**
   * §6.2's merge: "merge two accounts", which in practice is one account imported
   * twice under two names.
   *
   * The source is folded into `:id` and then archived. Not deleted: §3.2 RESTRICTs
   * that behind `transaction_source` and `tombstone`, and archive is §6.2's own
   * destructive action for accounts — so the row survives as the explanation for
   * why its imports now belong somewhere else.
   *
   * Re-running the link pass afterwards is not housekeeping. Two accounts that
   * were really one may have had "transfers" between them, and money moved from an
   * account to itself is not a transfer — leaving those linked would keep real
   * spending out of every total on the strength of a duplicate the user has just
   * finished repairing.
   */
  app.post<{ Params: { id: string }; Body: { sourceAccountId: string } }>(
    '/api/accounts/:id/merge',
    {
      schema: {
        summary: 'Merge another account into this one',
        operationId: 'mergeAccount',
        description:
          'Re-points transactions, imports, series and finding evidence, then archives the ' +
          'source (spec 6.2). **Re-points history; does not deduplicate it.** Spec 3.3’s ' +
          '`dedupe_key` hashes the account id, so the same charge in two accounts has two keys ' +
          'and the merge rule cannot see them as one row — delete the redundant import ' +
          'afterwards, which spec 3.3 already does exactly.',
        tags: ['accounts'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          required: ['sourceAccountId'],
          properties: { sourceAccountId: { type: 'string', minLength: 1 } },
        },
        response: { 200: ref('AccountMergeResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { sourceAccountId } = request.body;

      if (!context.store.accounts.get(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such account' });
      }
      if (!context.store.accounts.get(sourceAccountId)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such source account' });
      }
      if (id === sourceAccountId) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'an account cannot be merged into itself',
        });
      }

      const merged = context.store.accounts.merge(id, sourceAccountId);
      context.store.transfers.repointRules(sourceAccountId, id);
      const selfLinksRemoved = context.store.transfers.deleteSelfLinks();
      runTransferLinking(context);

      return { ...merged, selfLinksRemoved };
    },
  );
}

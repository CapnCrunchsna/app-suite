/**
 * `/api/transactions` — filter, search and paginate (§2.3, §6.3).
 *
 * The query is a typed object all the way down: this handler converts strings
 * into a `TransactionQuery` and the repository turns that into SQL. No fragment
 * of a query, no column name and no sort expression crosses the HTTP boundary,
 * which is the same rule §3.4 states for the repository and for the same reason.
 */

import type { FastifyInstance } from 'fastify';

import type { TransactionQuery, TransactionSort } from '@metrum/ledgerline-data';

import { errorResponses } from './errors.js';
import type { LedgerlineContext } from '../context.js';

const SORTS: readonly TransactionSort[] = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];

interface TransactionQueryString {
  accountIds?: string;
  merchantIds?: string;
  categoryIds?: string;
  from?: string;
  to?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  isPending?: boolean;
  hasFinding?: boolean;
  includeInternalTransfers?: boolean;
  includeExcluded?: boolean;
  q?: string;
  sort?: TransactionSort;
  limit?: number;
  offset?: number;
}

const csv = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === ''
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

export function registerTransactionRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get<{ Querystring: TransactionQueryString }>(
    '/api/transactions',
    {
      schema: {
        summary: 'Filter, search and paginate transactions',
        description:
          'Internal transfers are excluded unless asked for — a credit-card payment is not ' +
          'spending (spec 6.3). `hasFinding` comes from `finding_evidence` (spec 2.3).',
        tags: ['transactions'],
        querystring: {
          type: 'object',
          properties: {
            accountIds: { type: 'string', description: 'Comma-separated account ids' },
            merchantIds: { type: 'string', description: 'Comma-separated merchant ids' },
            categoryIds: { type: 'string', description: 'Comma-separated category ids' },
            from: { type: 'string', description: 'Inclusive ISO date' },
            to: { type: 'string', description: 'Inclusive ISO date' },
            minAmountCents: { type: 'integer' },
            maxAmountCents: { type: 'integer' },
            isPending: { type: 'boolean' },
            hasFinding: { type: 'boolean' },
            includeInternalTransfers: { type: 'boolean', default: false },
            includeExcluded: { type: 'boolean', default: false },
            q: { type: 'string', description: 'Full-text across raw and normalized descriptors' },
            sort: { type: 'string', enum: SORTS as unknown as string[], default: 'date_desc' },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query;
      const range =
        q.from && q.to ? { from: q.from, to: q.to } : undefined;

      const query: TransactionQuery = {
        accountIds: csv(q.accountIds),
        merchantIds: csv(q.merchantIds),
        categoryIds: csv(q.categoryIds),
        dateRange: range,
        minAmountCents: q.minAmountCents,
        maxAmountCents: q.maxAmountCents,
        isPending: q.isPending,
        hasFinding: q.hasFinding,
        includeInternalTransfers: q.includeInternalTransfers,
        includeExcluded: q.includeExcluded,
        text: q.q,
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
      };

      return context.store.transactions.search(query);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id',
    {
      schema: {
        summary: 'One transaction, with the imports that cover it',
        description: 'The covering imports are spec 6.3’s row expander.',
        tags: ['transactions'],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: errorResponses,
      },
    },
    async (request, reply) => {
      const transaction = context.store.transactions.get(request.params.id);
      if (!transaction) {
        return reply.code(404).send({ error: 'not_found', message: 'no such transaction' });
      }
      return {
        transaction,
        coveringImports: context.store.imports.listImportsForTransaction(transaction.id),
      };
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      merchantId?: string | null;
      categoryId?: string | null;
      isInternalTransfer?: boolean;
      isExcluded?: boolean;
    };
  }>(
    '/api/transactions/:id',
    {
      schema: {
        summary: 'Assign merchant or category, mark internal transfer, exclude',
        tags: ['transactions'],
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            merchantId: { type: ['string', 'null'] },
            categoryId: { type: ['string', 'null'] },
            isInternalTransfer: { type: 'boolean' },
            isExcluded: { type: 'boolean' },
          },
        },
        response: errorResponses,
      },
    },
    async (request, reply) => {
      if (!context.store.transactions.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such transaction' });
      }
      // A hand assignment is a `user` decision, which §4.3 makes permanent and
      // higher-precedence than anything a rule or a model later proposes.
      return context.store.transactions.update(request.params.id, {
        ...request.body,
        categorySource: request.body.categoryId !== undefined ? 'user' : undefined,
      });
    }
  );
}

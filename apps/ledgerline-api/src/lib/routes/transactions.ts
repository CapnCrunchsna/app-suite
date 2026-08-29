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
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';
import { enqueueRenormalize, writeUserMerchantAlias } from '../merchant-corrections.js';

const SORTS: readonly TransactionSort[] = ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'];

/**
 * How long the `ids` query string may be — about 220 UUIDs.
 *
 * The repository takes any number of ids for one bound parameter, so this bound
 * is HTTP's and not SQLite's: Node caps a request's whole header block, request
 * line included, at 16 KB by default, and a URL that trips it fails as a socket
 * error with no route ever entered and nothing useful in the log. A declared
 * `maxLength` turns that into the 400 the schema gives every other malformed
 * query. 8 KB leaves the rest of the header block room it will never need on
 * loopback.
 *
 * The caller's job is to stay well under it — §6.4's page caps each card's
 * evidence long before this — and this is the backstop that says so out loud.
 */
const MAX_IDS_QUERY_LENGTH = 8192;

interface TransactionQueryString {
  ids?: string;
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

/** The body half of `POST /api/transactions/bulk`. Field names match the query
 *  string above, because they select the same set. */
interface TransactionFilterBody {
  ids?: string[];
  accountIds?: string[];
  merchantIds?: string[];
  categoryIds?: string[];
  descriptorsNormalized?: string[];
  from?: string;
  to?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  isPending?: boolean;
  hasFinding?: boolean;
  includeInternalTransfers?: boolean;
  includeExcluded?: boolean;
  q?: string;
}

interface TransactionBulkChange {
  merchantId?: string | null;
  categoryId?: string | null;
  isInternalTransfer?: boolean;
  isExcluded?: boolean;
}

const csv = (value: string | undefined): string[] | undefined =>
  value === undefined || value.trim() === ''
    ? undefined
    : value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');

const nonEmpty = (value: string[] | undefined): string[] | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

/** Both request shapes reduce to the one repository filter. Written once so the
 *  dry-run count, the apply, and the table the user is reading cannot disagree. */
function toQuery(input: TransactionFilterBody): TransactionQuery {
  return {
    // Not through `nonEmpty`: the repository reads an empty `ids` as "match
    // nothing", and collapsing it to `undefined` here would turn a request for
    // zero specific rows into a request for the whole table.
    ids: input.ids,
    accountIds: nonEmpty(input.accountIds),
    merchantIds: nonEmpty(input.merchantIds),
    categoryIds: nonEmpty(input.categoryIds),
    descriptorsNormalized: nonEmpty(input.descriptorsNormalized),
    dateRange: input.from && input.to ? { from: input.from, to: input.to } : undefined,
    minAmountCents: input.minAmountCents,
    maxAmountCents: input.maxAmountCents,
    isPending: input.isPending,
    hasFinding: input.hasFinding,
    includeInternalTransfers: input.includeInternalTransfers,
    includeExcluded: input.includeExcluded,
    text: input.q,
  };
}

export function registerTransactionRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get<{ Querystring: TransactionQueryString }>(
    '/api/transactions',
    {
      schema: {
        summary: 'Filter, search and paginate transactions',
        operationId: 'listTransactions',
        description:
          'Internal transfers are excluded unless asked for — a credit-card payment is not ' +
          'spending (spec 6.3). `hasFinding` comes from `finding_evidence` (spec 2.3).',
        tags: ['transactions'],
        querystring: {
          type: 'object',
          properties: {
            ids: {
              type: 'string',
              maxLength: MAX_IDS_QUERY_LENGTH,
              description:
                'Comma-separated transaction ids — exactly these rows, in the requested sort ' +
                "order. Backs spec 6.4's inline evidence: a finding's charges are one request, " +
                'not one per cited row. Present but empty matches nothing.',
            },
            accountIds: {
              type: 'string',
              description: 'Comma-separated account ids',
            },
            merchantIds: {
              type: 'string',
              description: 'Comma-separated merchant ids',
            },
            categoryIds: {
              type: 'string',
              description: 'Comma-separated category ids',
            },
            from: { type: 'string', description: 'Inclusive ISO date' },
            to: { type: 'string', description: 'Inclusive ISO date' },
            minAmountCents: { type: 'integer' },
            maxAmountCents: { type: 'integer' },
            isPending: { type: 'boolean' },
            hasFinding: { type: 'boolean' },
            includeInternalTransfers: { type: 'boolean', default: false },
            includeExcluded: { type: 'boolean', default: false },
            q: {
              type: 'string',
              description: 'Full-text across raw and normalized descriptors',
            },
            sort: {
              type: 'string',
              enum: SORTS as unknown as string[],
              default: 'date_desc',
            },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
        response: { 200: ref('TransactionPage'), ...errorResponses },
      },
    },
    async (request) => {
      const q = request.query;

      const query: TransactionQuery = {
        ...toQuery({
          // A present-but-empty `ids` is an empty set, not an absent filter.
          // `csv('')` is `undefined`, and letting that mean "no id filter" would
          // answer "give me these zero rows" with every row in the account.
          ids: q.ids === undefined ? undefined : (csv(q.ids) ?? []),
          accountIds: csv(q.accountIds),
          merchantIds: csv(q.merchantIds),
          categoryIds: csv(q.categoryIds),
          from: q.from,
          to: q.to,
          minAmountCents: q.minAmountCents,
          maxAmountCents: q.maxAmountCents,
          isPending: q.isPending,
          hasFinding: q.hasFinding,
          includeInternalTransfers: q.includeInternalTransfers,
          includeExcluded: q.includeExcluded,
          q: q.q,
        }),
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
      };

      return context.store.transactions.search(query);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/transactions/:id',
    {
      schema: {
        summary: 'One transaction, with the imports that cover it',
        operationId: 'getTransaction',
        description:
          'The covering imports and the verbatim line are spec 6.3’s row expander. `rawText` ' +
          'is the statement line as printed, never trimmed or re-encoded (spec 2.5).',
        tags: ['transactions'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('TransactionDetail'), ...errorResponses },
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
        rawText: transaction.rawRowId
          ? (context.store.imports.getRawRow(transaction.rawRowId)?.rawText ?? null)
          : null,
        sources: context.store.imports.listSourcesForTransaction(transaction.id),
      };
    },
  );

  app.patch<{ Params: { id: string }; Body: TransactionBulkChange }>(
    '/api/transactions/:id',
    {
      schema: {
        summary: 'Assign merchant or category, mark internal transfer, exclude',
        operationId: 'updateTransaction',
        description:
          'A merchant assignment writes a `user` merchant_alias and enqueues a coalesced ' +
          're-normalize job (spec 4.3, 2.7).',
        tags: ['transactions'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: ref('TransactionBulkChange'),
        response: { 200: ref('Transaction'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const before = context.store.transactions.get(request.params.id);
      if (!before) {
        return reply.code(404).send({ error: 'not_found', message: 'no such transaction' });
      }
      // A hand assignment is a `user` decision, which §4.3 makes permanent and
      // higher-precedence than anything a rule or a model later proposes.
      const updated = context.store.transactions.update(request.params.id, {
        ...request.body,
        categorySource: request.body.categoryId !== undefined ? 'user' : undefined,
      });

      if (request.body.merchantId !== undefined && request.body.merchantId !== null) {
        writeUserMerchantAlias(context, [before.descriptionNormalized], request.body.merchantId);
        enqueueRenormalize(context, {
          transactionIds: [updated.id],
          aliasKeys: [before.descriptionNormalized],
        });
      }

      return updated;
    },
  );

  /**
   * §2.3: "Apply one change to a filter-matched set. `?dryRun=true` returns the
   * match count only — this is what backs the UI's 'apply to all 47 matching'."
   *
   * The dry run is a `COUNT(*)` and nothing else. Not a truncated apply, not a
   * transaction that rolls back: §6.3 calls this path "what makes normalization
   * converge in minutes instead of row by row", and the user clicks it to *find
   * out* whether to proceed. A dry run that could write is a dry run that will,
   * on the day the rollback is the thing that fails.
   */
  app.post<{
    Querystring: { dryRun?: boolean };
    Body: { filter: TransactionFilterBody; change: TransactionBulkChange };
  }>(
    '/api/transactions/bulk',
    {
      schema: {
        summary: 'Apply one change to a filter-matched set',
        operationId: 'bulkUpdateTransactions',
        description:
          '`?dryRun=true` returns the match count only and writes nothing — this is what backs ' +
          'spec 6.3’s "apply to all 47 matching descriptors". A real apply of a merchant writes ' +
          'one `user` merchant_alias per matched descriptor (spec 4.3) and enqueues a coalesced ' +
          're-normalize job (spec 2.7).',
        tags: ['transactions'],
        querystring: {
          type: 'object',
          properties: {
            dryRun: {
              type: 'boolean',
              default: false,
              description: 'Count the matched set and write nothing',
            },
          },
        },
        body: {
          type: 'object',
          required: ['filter'],
          properties: {
            filter: ref('TransactionFilter'),
            change: ref('TransactionBulkChange'),
          },
        },
        response: { 200: ref('TransactionBulkResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const query = toQuery(request.body.filter);
      const change = request.body.change ?? {};

      if (request.query.dryRun) {
        return {
          dryRun: true,
          matchCount: context.store.transactions.countMatching(query),
          updated: 0,
          aliasKeysWritten: [],
          renormalizeJobId: null,
          renormalizeJobCoalesced: false,
        };
      }

      if (change.merchantId !== undefined && change.merchantId !== null) {
        if (!context.store.merchants.get(change.merchantId)) {
          return reply.code(404).send({ error: 'not_found', message: 'no such merchant' });
        }
      }
      if (change.categoryId !== undefined && change.categoryId !== null) {
        if (!context.store.merchants.getCategory(change.categoryId)) {
          return reply.code(404).send({ error: 'not_found', message: 'no such category' });
        }
      }

      // The descriptors are read before the write, because a merchant assignment
      // changes which alias keys the correction covers only if it changed
      // `description_normalized` — and it does not. These are the keys §4.3's
      // alias rows are written against.
      const descriptors = context.store.transactions.listMatchingDescriptors(query);

      const applied = context.store.transactions.applyBulk(query, {
        ...change,
        categorySource: change.categoryId !== undefined ? 'user' : undefined,
      });

      let aliasKeysWritten: string[] = [];
      let renormalize: { id: string; coalesced: boolean } | null = null;

      if (change.merchantId !== undefined && change.merchantId !== null && applied.matched > 0) {
        aliasKeysWritten = writeUserMerchantAlias(context, descriptors, change.merchantId);
        renormalize = enqueueRenormalize(context, {
          transactionIds: applied.transactionIds,
          aliasKeys: aliasKeysWritten,
        });
      }

      return {
        dryRun: false,
        matchCount: applied.matched,
        updated: applied.matched,
        aliasKeysWritten,
        renormalizeJobId: renormalize?.id ?? null,
        renormalizeJobCoalesced: renormalize?.coalesced ?? false,
      };
    },
  );
}

/**
 * `GET /api/merchants` (§2.3) and the category list behind it.
 *
 * Read-only for now. §2.3 also lists `PATCH /api/merchants/:id`,
 * `POST /api/merchants/aliases` and `GET /api/merchants/review-queue`; none of
 * those is needed by §6.3, and the alias write a merchant correction *does* make
 * happens as a consequence of the transaction edit (§4.3) rather than as a call
 * the UI makes itself. Half-built endpoints teach the wrong model of who owns the
 * alias table.
 *
 * §6.3 needs both lists to populate the merchant and category filters and the two
 * inline assignment controls, and nothing more.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

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

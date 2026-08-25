/**
 * The Fastify instance (§2.3).
 *
 * "Fastify, JSON only, OpenAPI schema emitted at build time and used to generate
 * `shared/api-client`. Chosen over Express for native TS types, schema-based
 * validation and serialization out of the box, and a clean Nx build target."
 *
 * `buildServer` returns an instance without listening, which is what makes both
 * the OpenAPI emitter and the end-to-end tests possible: the schema is a
 * property of the routes, not of a running process, and a test that has to bind
 * a port to assert an import is a test that fails on a busy machine.
 */

import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';

import { SnapshotTooLargeError } from '@metrum/ledgerline-analyzers';
import { MixedDedupeKeyVersionError, ZeroAmountRowError } from '@metrum/ledgerline-data';

import { DEV_ORIGINS } from './config.js';
import type { ApiConfig } from './config.js';
import type { LedgerlineContext } from './context.js';
import { ImportNotReadyError } from './import-service.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerDataRoutes } from './routes/data.js';
import { registerFindingRoutes } from './routes/findings.js';
import { registerFormatProfileRoutes } from './routes/format-profiles.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMerchantRoutes } from './routes/merchants.js';
import { registerSeriesRoutes } from './routes/series.js';
import { registerSharedSchemas } from './routes/schemas.js';
import { registerTransactionRoutes } from './routes/transactions.js';
import { registerTransferRoutes } from './routes/transfers.js';

/** A statement CSV is small; a bank export of ten years is still under a few MB.
 *  The cap is here so a mis-drop cannot buffer an arbitrary file into memory. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export interface BuildServerOptions {
  readonly context: LedgerlineContext;
  readonly config: ApiConfig;
  readonly logger?: boolean;
}

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Ledgerline API',
    description:
      'Local statement analyzer. Binds 127.0.0.1 and has no authentication: it is a ' +
      'single-user process holding every statement its owner has imported.',
    version: '0.1.0',
  },
  tags: [
    {
      name: 'imports',
      description: 'Upload, review, commit and delete statement imports',
    },
    { name: 'accounts', description: 'Account CRUD' },
    {
      name: 'transactions',
      description: 'Filter, search and edit transactions',
    },
    { name: 'merchants', description: 'Canonical merchants and categories' },
    {
      name: 'transfers',
      description: 'Internal transfer links and the queue of pairs awaiting a decision',
    },
    { name: 'jobs', description: 'Long-running work and its progress' },
    {
      name: 'analysis',
      description: 'Analysis runs, findings and their dismissals',
    },
    { name: 'data', description: 'Backup and export' },
  ],
};

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(swagger, {
    openapi: OPENAPI_DOCUMENT,
    /**
     * Name components after their `$id`, not `def-0`.
     *
     * This is the difference between a generated client that exports
     * `Transaction` and one that exports `Def4`. The default resolver numbers
     * components in registration order, which also means inserting a schema
     * renumbers every one after it — a one-line change to a route would rewrite
     * the whole of `openapi.json` and the whole generated client, and the diff
     * that is supposed to show a contract change would show noise instead.
     */
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, index) =>
        typeof json['$id'] === 'string' ? json['$id'] : `def-${index}`,
    },
  });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  // Before any route that `$ref`s one. Fastify resolves shared schemas at
  // registration time, so a late `addSchema` fails at boot rather than silently.
  registerSharedSchemas(app);

  /**
   * The Angular dev server is a different origin from this API (`ng serve` on
   * 4200, Fastify on 4310), so the browser preflights every non-GET the
   * Transactions page makes.
   *
   * The allow-list is loopback only, and that is the whole security argument:
   * this process has no authentication and holds every statement its owner has
   * imported (§2.1), so `*` here would let any page in the browser read the lot.
   * Loopback origins can only be served by something already running on this
   * machine. `credentials` is deliberately absent — there is nothing to send.
   */
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && DEV_ORIGINS.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
  });

  app.options('/api/*', { schema: { hide: true } }, async (request, reply) =>
    reply
      .header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      .header(
        'access-control-allow-headers',
        request.headers['access-control-request-headers'] ?? 'content-type',
      )
      .header('access-control-max-age', '600')
      .code(204)
      .send(),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // These three are decisions the caller can act on, not faults. Returning 500
    // for "your table holds two dedupe key versions" would bury the one message
    // that says what to do about it.
    if (error instanceof MixedDedupeKeyVersionError) {
      return reply.code(409).send({ error: 'mixed_dedupe_key_version', message: error.message });
    }
    if (error instanceof ZeroAmountRowError) {
      return reply.code(422).send({
        error: 'zero_amount_rows',
        message: error.message,
        rowIndexes: error.rowIndexes,
      });
    }
    if (error instanceof ImportNotReadyError) {
      return reply.code(409).send({ error: 'import_not_ready', message: error.message });
    }
    // §2.2's hard ceiling. The message names the fix — scope the run to a date
    // range — and 422 rather than 500 because the request was well formed and the
    // dataset is the thing that has to change.
    if (error instanceof SnapshotTooLargeError) {
      return reply.code(422).send({ error: 'snapshot_too_large', message: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    }

    request.log.error(error);
    return reply.code(500).send({ error: 'internal', message: error.message });
  });

  app.get(
    '/api/health',
    {
      schema: {
        summary: 'Liveness, schema version, and any profile that failed to load at boot',
        operationId: 'getHealth',
        tags: ['data'],
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              schemaVersion: { type: 'integer' },
              transactions: { type: 'integer' },
              profileLoadErrors: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async () => ({
      ok: true,
      schemaVersion: options.context.store.migrations.alreadyAtVersion,
      transactions: options.context.store.transactions.countAll(),
      profileLoadErrors: options.context.profileLoadErrors,
    }),
  );

  registerImportRoutes(app, options.context);
  registerFormatProfileRoutes(app, options.context);
  registerAccountRoutes(app, options.context);
  registerTransactionRoutes(app, options.context);
  registerTransferRoutes(app, options.context);
  registerMerchantRoutes(app, options.context);
  registerJobRoutes(app, options.context);
  registerFindingRoutes(app, options.context);
  registerSeriesRoutes(app, options.context);
  registerDataRoutes(app, options.context, options.config);

  await app.ready();
  return app;
}

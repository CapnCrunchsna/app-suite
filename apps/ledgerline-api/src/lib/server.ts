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

import {
  MixedDedupeKeyVersionError,
  ZeroAmountRowError,
} from '@metrum/ledgerline-data';

import type { ApiConfig } from './config.js';
import type { LedgerlineContext } from './context.js';
import { ImportNotReadyError } from './import-service.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerDataRoutes } from './routes/data.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerTransactionRoutes } from './routes/transactions.js';

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
    { name: 'imports', description: 'Upload, review, commit and delete statement imports' },
    { name: 'accounts', description: 'Account CRUD' },
    { name: 'transactions', description: 'Filter, search and edit transactions' },
    { name: 'data', description: 'Backup and export' },
  ],
};

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(swagger, { openapi: OPENAPI_DOCUMENT });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES } });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // These three are decisions the caller can act on, not faults. Returning 500
    // for "your table holds two dedupe key versions" would bury the one message
    // that says what to do about it.
    if (error instanceof MixedDedupeKeyVersionError) {
      return reply.code(409).send({ error: 'mixed_dedupe_key_version', message: error.message });
    }
    if (error instanceof ZeroAmountRowError) {
      return reply
        .code(422)
        .send({ error: 'zero_amount_rows', message: error.message, rowIndexes: error.rowIndexes });
    }
    if (error instanceof ImportNotReadyError) {
      return reply.code(409).send({ error: 'import_not_ready', message: error.message });
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
    })
  );

  registerImportRoutes(app, options.context);
  registerAccountRoutes(app, options.context);
  registerTransactionRoutes(app, options.context);
  registerDataRoutes(app, options.context, options.config);

  await app.ready();
  return app;
}

/**
 * `/api/accounts` — §2.3's account CRUD.
 *
 * Deletion is not exposed. §6.2's destructive action is *archive*, and §3.2's
 * `ON DELETE RESTRICT` would refuse an account with imports anyway; offering a
 * DELETE that only ever works on empty accounts is an endpoint that teaches the
 * wrong model.
 */

import type { FastifyInstance } from 'fastify';

import { errorResponses } from './errors.js';
import { ACCOUNT_TYPES, ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

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
}

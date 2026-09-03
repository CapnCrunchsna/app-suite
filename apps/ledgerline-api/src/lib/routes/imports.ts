/**
 * `/api/imports` — §2.3's import lifecycle, and the only route group that
 * writes to `transaction`.
 *
 * The shape follows §2.5's review-before-commit rule exactly: `POST` stages and
 * parses but commits nothing, `GET` returns what the reviewer has to see,
 * `PATCH` confirms the account or re-parses under a different profile, and
 * `POST /commit` is the one call that lands rows. `DELETE` removes only the
 * transactions this import is the last remaining source for (§3.3).
 */

import type { FastifyInstance } from 'fastify';

import type { CommitResolution } from '@metrum/ledgerline-data';
import { decodeStatementText, parseCsvWithProfile } from '@metrum/ledgerline-parsing';

import { errorResponses } from './errors.js';
import { RESOLUTIONS, ref } from './schemas.js';
import { toFormatProfile } from '../context.js';
import type { LedgerlineContext } from '../context.js';
import { commitStagedImport, reviewImport, stageUpload } from '../import-service.js';

export function registerImportRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.post(
    '/api/imports',
    {
      schema: {
        summary: 'Upload one or more statement files',
        operationId: 'uploadImports',
        description:
          'Stages and parses; commits nothing. A byte-identical re-upload returns the existing ' +
          'import untouched (spec 3.3, idempotency layer one).',
        tags: ['imports'],
        consumes: ['multipart/form-data'],
        response: { 200: ref('UploadResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: 'expected multipart/form-data',
        });
      }

      const staged = [];
      for await (const part of request.files()) {
        const bytes = new Uint8Array(await part.toBuffer());
        staged.push(await stageUpload(context, { filename: part.filename, bytes }));
      }

      if (staged.length === 0) {
        return reply.code(400).send({ error: 'no_files', message: 'no files in the request' });
      }
      return { imports: staged };
    },
  );

  app.get(
    '/api/imports',
    {
      schema: {
        summary: 'Import history',
        operationId: 'listImports',
        tags: ['imports'],
        response: {
          200: { type: 'array', items: ref('StatementImport') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.imports.list(),
  );

  app.get<{ Params: { id: string } }>(
    '/api/imports/:id',
    {
      schema: {
        summary: 'Staged parse result for review',
        operationId: 'getImport',
        description:
          'Rows with their disposition, the exact duplicates the merge rule will absorb, the ' +
          'near-duplicates needing a three-way choice, unparsed rows, and the balance verdict ' +
          '(spec 6.1). The plan is null until an account is confirmed.',
        tags: ['imports'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('ImportReview'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.imports.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      }
      return reviewImport(context, request.params.id);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { accountId?: string; formatProfileId?: string; reparse?: boolean };
  }>(
    '/api/imports/:id',
    {
      schema: {
        summary: 'Confirm the account, override the profile, or re-parse',
        operationId: 'updateImport',
        description: 'Refused once the import is committed (spec 6.1).',
        tags: ['imports'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            formatProfileId: { type: 'string' },
            reparse: { type: 'boolean' },
          },
        },
        response: { 200: ref('ImportReview'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const record = context.store.imports.get(request.params.id);
      if (!record) return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      if (record.status === 'committed') {
        return reply.code(409).send({
          error: 'already_committed',
          message: 'a committed import cannot be re-mapped or re-parsed (spec 6.1)',
        });
      }

      const { accountId, formatProfileId, reparse } = request.body;

      if (accountId && !context.store.accounts.get(accountId)) {
        return reply.code(400).send({ error: 'bad_account', message: 'no such account' });
      }

      const profileId = formatProfileId ?? record.formatProfileId;
      const shouldReparse =
        reparse === true ||
        (formatProfileId !== undefined && formatProfileId !== record.formatProfileId);

      if (shouldReparse) {
        if (!profileId) {
          return reply.code(400).send({
            error: 'no_profile',
            message: 're-parse needs a formatProfileId',
          });
        }
        const profileRecord = context.store.formatProfiles.get(profileId);
        if (!profileRecord) {
          return reply.code(400).send({ error: 'no_profile', message: 'no such format profile' });
        }

        const text = decodeStatementText(context.store.imports.readFileBytes(record.id));
        const parsed = parseCsvWithProfile({
          text,
          profile: toFormatProfile(profileRecord),
        });

        context.store.imports.replaceRawRows(
          record.id,
          [
            ...parsed.rows.map((row) => ({
              rowIndex: row.rowIndex,
              rawText: row.rawText,
              parsedJson: JSON.stringify(row),
              parseStatus: 'ok' as const,
              parseSource: row.parseSource,
            })),
            ...parsed.errors.map((row) => ({
              rowIndex: row.rowIndex,
              rawText: row.rawText,
              parsedJson: JSON.stringify({ errors: row.errors }),
              parseStatus: 'error' as const,
              parseSource: row.parseSource,
            })),
          ].sort((a, b) => a.rowIndex - b.rowIndex),
          {
            accountId: accountId ?? record.accountId,
            formatProfileId: profileId,
            periodStart: parsed.periodStart,
            periodEnd: parsed.periodEnd,
            status: 'staged',
            parser: parsed.parser,
            parserVersion: parsed.parserVersion,
            errorDetail: null,
            diagnosticsJson: JSON.stringify({
              warnings: parsed.warnings,
              balanceCheck: parsed.balanceCheck,
            }),
          },
        );
        return reviewImport(context, record.id);
      }

      context.store.imports.update(record.id, {
        accountId: accountId ?? record.accountId,
        formatProfileId: profileId,
      });
      return reviewImport(context, record.id);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      resolutions?: CommitResolution[];
      dropRowIndexes?: number[];
      allowZeroAmountRows?: boolean;
    };
  }>(
    '/api/imports/:id/commit',
    {
      schema: {
        summary: 'Commit a staged import',
        operationId: 'commitImport',
        description:
          'Idempotent. Drops any row named in `dropRowIndexes`, then applies the multiset merge ' +
          'rule, the near-duplicate resolutions and refund pairing — all inside one transaction, ' +
          'so a partial import never lands (spec 3.3, 2.5).',
        tags: ['imports'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            resolutions: {
              type: 'array',
              items: {
                type: 'object',
                required: ['rowIndex', 'existingTransactionId', 'resolution'],
                properties: {
                  rowIndex: { type: 'integer' },
                  existingTransactionId: { type: 'string' },
                  resolution: { type: 'string', enum: RESOLUTIONS },
                },
              },
            },
            dropRowIndexes: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'Rows not to insert at all. For a duplicate *within one file*, which spec 3.3’s ' +
                'merge rule cannot resolve because it compares against what is already stored. ' +
                'Never inferred: spec 3.3 keeps both by default, because over-counting is visible ' +
                'and a lost transaction is not.',
            },
            allowZeroAmountRows: {
              type: 'boolean',
              description:
                'Store $0 rows as trial authorizations. Without it a non-pending $0 row is ' +
                'refused as a probable misparse (spec 3.2).',
            },
          },
        },
        response: { 200: ref('CommitResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.imports.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      }
      return commitStagedImport(context, request.params.id, request.body ?? {});
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/imports/:id',
    {
      schema: {
        summary: 'Delete an import',
        operationId: 'deleteImport',
        description:
          'Removes only the transactions this import is the last remaining source for. Deleting ' +
          'the first of two overlapping imports keeps the rows the second still contains (spec 3.3).',
        tags: ['imports'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        response: { 200: ref('DeleteImportResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!context.store.imports.get(request.params.id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      }
      return context.store.imports.delete(request.params.id);
    },
  );
}

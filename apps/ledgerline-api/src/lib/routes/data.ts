/**
 * `/api/data/backup` and `/api/data/export` (§2.3).
 *
 * These are here now, before there is data worth losing, which is the only time
 * a backup endpoint is cheap to write. Backup is a consistent copy of the whole
 * database; export is the portable form — the two are not substitutes, because a
 * `.sqlite` file is only useful to this app and a JSON dump cannot be restored
 * into one.
 *
 * `DELETE /api/data` (wipe) is deliberately not built here. It is the one
 * irreversible operation in §2.3, and it belongs with the Settings UI that
 * confirms it rather than as an endpoint that exists before anything can
 * confirm it.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { formatCents } from '@metrum/ledgerline-domain';

import { errorResponses } from './errors.js';
import type { ApiConfig } from '../config.js';
import type { LedgerlineContext } from '../context.js';

const EXPORT_COLUMNS = [
  'id',
  'accountId',
  'effectiveDate',
  'transactionDate',
  'postedDate',
  'amountCents',
  'amount',
  'currency',
  'descriptionRaw',
  'descriptionNormalized',
  'merchantId',
  'categoryId',
  'isPending',
  'isInternalTransfer',
  'isExcluded',
  'refundPairId',
  'dedupeKey',
  'dedupeKeyVersion',
  'occurrenceIndex',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function registerDataRoutes(
  app: FastifyInstance,
  context: LedgerlineContext,
  config: ApiConfig
): void {
  app.post(
    '/api/data/backup',
    {
      schema: {
        summary: 'Write a consistent copy of the database',
        description:
          'Uses SQLite’s online backup rather than a file copy: under WAL the `.sqlite` file ' +
          'alone is not the whole database, so copying it while the API is running can miss the ' +
          'most recent commits.',
        tags: ['data'],
        response: {
          ...errorResponses,
          200: {
            type: 'object',
            properties: { path: { type: 'string' }, createdAt: { type: 'string' } },
          },
        },
      },
    },
    async (_request, reply) => {
      if (config.databaseFile === ':memory:') {
        return reply.code(409).send({
          error: 'not_backable',
          message: 'this instance runs in memory and has nothing on disk to back up',
        });
      }

      mkdirSync(config.backupDir, { recursive: true });
      const createdAt = new Date().toISOString();
      const path = join(config.backupDir, `ledgerline-${createdAt.replace(/[:.]/g, '-')}.sqlite`);
      await context.store.backup(path);
      return { path, createdAt };
    }
  );

  app.post<{ Querystring: { format?: 'json' | 'csv' } }>(
    '/api/data/export',
    {
      schema: {
        summary: 'Export every transaction as JSON or CSV',
        description:
          'Money is exported twice on purpose: `amountCents` is the value, and `amount` is the ' +
          'rendered form for a human reading the file. Only the first is ever read back.',
        tags: ['data'],
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
        },
      },
    },
    async (request, reply) => {
      const rows: Record<string, unknown>[] = [];
      const pageSize = 1000;

      for (let offset = 0; ; offset += pageSize) {
        const page = context.store.transactions.search({
          includeInternalTransfers: true,
          includeExcluded: true,
          sort: 'date_asc',
          limit: pageSize,
          offset,
        });
        for (const row of page.rows) {
          rows.push({ ...row.transaction, amount: formatCents(row.transaction.amountCents) });
        }
        if (offset + pageSize >= page.total) break;
      }

      if (request.query.format === 'csv') {
        const header = EXPORT_COLUMNS.join(',');
        const body = rows
          .map((row) => EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(','))
          .join('\n');
        return reply.type('text/csv; charset=utf-8').send(`${header}\n${body}\n`);
      }

      return {
        exportedAt: new Date().toISOString(),
        accounts: context.store.accounts.list(),
        transactions: rows,
      };
    }
  );
}

/**
 * `/api/data/backup` and `/api/data/export` (§2.3).
 *
 * These are here now, before there is data worth losing, which is the only time
 * a backup endpoint is cheap to write. Backup is a consistent copy of the whole
 * database; export is the portable form — the two are not substitutes, because a
 * `.sqlite` file is only useful to this app and a JSON dump cannot be restored
 * into one.
 *
 * `DELETE /api/data` (wipe) is here now, because §6.8's Settings page exists to
 * confirm it — which is the condition this file previously deferred it on. It is
 * still the one irreversible operation in §2.3, so it is not merely confirmed: it
 * **takes a backup first** and returns the path. See the route.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { formatCents } from '@metrum/ledgerline-domain';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import type { ApiConfig } from '../config.js';
import { seedReferenceData } from '../context.js';
import type { LedgerlineContext } from '../context.js';

/** Typed in full, deliberately. A single-word confirmation is one autocomplete away. */
const WIPE_PHRASE = 'DELETE EVERYTHING';

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
  config: ApiConfig,
): void {
  app.post(
    '/api/data/backup',
    {
      schema: {
        summary: 'Write a consistent copy of the database',
        operationId: 'backupData',
        description:
          'Uses SQLite’s online backup rather than a file copy: under WAL the `.sqlite` file ' +
          'alone is not the whole database, so copying it while the API is running can miss the ' +
          'most recent commits.',
        tags: ['data'],
        response: {
          ...errorResponses,
          200: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              createdAt: { type: 'string' },
            },
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
    },
  );

  /**
   * §2.3's wipe, and the reason it is recoverable rather than merely confirmed.
   *
   * A typed confirmation stops an accidental click; it does nothing about a
   * deliberate click someone regrets ten seconds later. Taking a backup first turns
   * the one irreversible operation in this API into a recoverable one, and it costs a
   * file copy of a database that is about to be emptied anyway. The path comes back in
   * the response, so the answer to "where did it go" is on screen rather than in a
   * folder the user has to know to look in.
   *
   * §7.4's thresholds survive — see `LedgerlineStore.wipe`. Clearing your statements
   * should not clear an afternoon of tuning §5 against them.
   */
  app.delete<{ Body: { confirm?: string } }>(
    '/api/data',
    {
      schema: {
        summary: 'Delete every transaction, import, finding and series',
        operationId: 'wipeData',
        description:
          'Irreversible, and therefore backed up first: the response carries the path of a ' +
          'copy taken immediately before the delete. Requires the exact confirmation phrase. ' +
          'Reference data (spec 4 aliases, spec 5 categories, format profiles) is re-seeded, ' +
          'and spec 7.4 threshold overrides are kept — this clears data, not configuration.',
        tags: ['data'],
        body: {
          type: 'object',
          required: ['confirm'],
          properties: {
            confirm: { type: 'string', description: 'Must be exactly: DELETE EVERYTHING' },
          },
        },
        response: { 200: ref('WipeResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      if (request.body?.confirm !== WIPE_PHRASE) {
        return reply.code(422).send({
          error: 'not_confirmed',
          message: `confirm must be exactly "${WIPE_PHRASE}"`,
        });
      }

      // Backup before delete, always — and refuse the whole operation if the backup
      // fails, because the entire point of taking one is that it exists afterwards.
      let backupPath: string | null = null;
      if (config.databaseFile !== ':memory:') {
        try {
          mkdirSync(config.backupDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          backupPath = join(config.backupDir, `ledgerline-before-wipe-${stamp}.sqlite`);
          await context.store.backup(backupPath);
        } catch (cause) {
          return reply.code(500).send({
            error: 'backup_failed',
            message: `nothing was deleted: the safety backup could not be written (${
              (cause as Error).message
            })`,
          });
        }
      }

      const deleted = context.store.wipe();
      // A wiped database is a fresh install, not an empty one: without this the next
      // import builds a provisional merchant for every descriptor §4 already knows.
      seedReferenceData(context.store, config.profilesDir ?? null);

      return {
        backupPath,
        rowsDeleted: Object.values(deleted).reduce((total, n) => total + n, 0),
        deletedByTable: deleted,
      };
    },
  );

  app.post<{ Querystring: { format?: 'json' | 'csv' } }>(
    '/api/data/export',
    {
      schema: {
        summary: 'Export every transaction as JSON or CSV',
        operationId: 'exportData',
        description:
          'Money is exported twice on purpose: `amountCents` is the value, and `amount` is the ' +
          'rendered form for a human reading the file. Only the first is ever read back.',
        tags: ['data'],
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          },
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
          rows.push({
            ...row.transaction,
            amount: formatCents(row.transaction.amountCents),
          });
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
    },
  );
}

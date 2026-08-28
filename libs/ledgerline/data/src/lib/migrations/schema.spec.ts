/**
 * The schema invariants §3.1 and §3.2 state, asserted against a freshly migrated
 * database rather than against the migration text.
 *
 * §3.1 asks for one of these by name — "there is a migration test that asserts
 * every table has them" — after noting that the design session claimed the three
 * audit columns and then omitted them from half the tables. The rest are here
 * because §3.2 opens with "None of these are optional", and an index that
 * nobody checks for is one careless `CREATE TABLE` away from not existing.
 *
 * Deliberately raw SQL: this file tests the *schema*, so it must not go through
 * the repository layer that the schema is supposed to constrain.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { applyMigrations, MIGRATIONS } from './runner.js';
import { fixedClock } from '../clock.js';
import { openDatabase } from '../database.js';
import type { Database } from '../database.js';

/** Every table in §3.1's list, plus `schema_migrations`. */
const SPEC_TABLES = [
  'account',
  'format_profile',
  'statement_import',
  'raw_row',
  'transaction',
  'transaction_source',
  'merchant_canonical',
  'merchant_alias',
  'category',
  'recurring_series',
  'transfer_link',
  'transfer_rule',
  'finding',
  'finding_evidence',
  'finding_state',
  'dismissal_rule',
  'analysis_run',
  'job',
  'llm_cache',
  // §9s: §6.8 names both of these as things Settings shows and §3.1 lists
  // neither, because the spec describes the feature and stops short of the row.
  'llm_degraded_call',
  'llm_proposal',
  'tombstone',
  'settings',
  'schema_migrations',
] as const;

interface TableRow {
  name: string;
}
interface ColumnRow {
  name: string;
}
interface IndexRow {
  name: string;
  unique: number;
}
interface IndexColumnRow {
  name: string | null;
}

function tableNames(db: Database): string[] {
  return db
    .prepare<[], TableRow>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`
    )
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database, table: string): string[] {
  return db
    .prepare<[], ColumnRow>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

/** The columns of every index on `table`, as `unique:col,col` strings. */
function indexShapes(db: Database, table: string): string[] {
  return db
    .prepare<[], IndexRow>(`SELECT name, "unique" FROM pragma_index_list('${table}')`)
    .all()
    .map((index) => {
      const columns = db
        .prepare<[], IndexColumnRow>(`SELECT name FROM pragma_index_info('${index.name}')`)
        .all()
        // An expression index (abs(amount_cents)) reports a NULL column name;
        // pragma_index_xinfo does not name the expression either, so the
        // expression is checked separately below via the index SQL.
        .map((column) => column.name ?? '<expr>');
      return `${index.unique ? 'unique' : 'index'}:${columns.join(',')}`;
    });
}

function seedAccount(db: Database, id = 'acct-1', currency = 'USD'): string {
  db.prepare(
    `INSERT INTO account (id, display_name, institution, account_type, last4, currency, is_active, created_at, updated_at)
     VALUES (?, 'Checking', 'Northgate', 'checking', '4821', ?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, currency);
  return id;
}

function insertTransaction(db: Database, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'txn-1',
    account_id: 'acct-1',
    raw_row_id: null,
    posted_date: '2026-01-03',
    transaction_date: '2026-01-03',
    effective_date: '2026-01-03',
    amount_cents: -1875,
    balance_cents: null,
    currency: 'USD',
    description_raw: 'SQ *BLUE BOTTLE',
    description_normalized: 'BLUE BOTTLE',
    merchant_id: null,
    category_id: null,
    category_source: null,
    is_pending: 0,
    is_internal_transfer: 0,
    transfer_pair_id: null,
    refund_pair_id: null,
    is_excluded: 0,
    allows_zero_amount: 0,
    dedupe_key: 'key-1',
    dedupe_key_version: 'collapse_v1',
    occurrence_index: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO "transaction" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((c) => (row as Record<string, unknown>)[c]));
}

describe('schema', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase({ filename: ':memory:' });
    applyMigrations(db, fixedClock());
  });

  afterEach(() => {
    db.close();
  });

  describe('migration runner', () => {
    it('applies every migration and records it in schema_migrations', () => {
      const applied = db
        .prepare<[], { version: number; name: string }>(
          'SELECT version, name FROM schema_migrations ORDER BY version'
        )
        .all();

      expect(applied).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    });

    it('is idempotent — a second boot applies nothing', () => {
      const outcome = applyMigrations(db, fixedClock());

      expect(outcome.applied).toEqual([]);
      expect(outcome.alreadyAtVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    });
  });

  describe('§3.1 conventions', () => {
    it('creates every table §3.1 lists, and no others', () => {
      expect(tableNames(db)).toEqual([...SPEC_TABLES].sort());
    });

    // The test §3.1 asks for by name. No exemptions, including for
    // schema_migrations — an allow-list of one is how an allow-list of six
    // starts, and the whole point of the rule is that an Elasticsearch
    // watermark re-index (§3.4) can read `updated_at` off anything.
    it.each([...SPEC_TABLES])('%s has id, created_at and updated_at', (table) => {
      expect(columnNames(db, table)).toEqual(
        expect.arrayContaining(['id', 'created_at', 'updated_at'])
      );
    });

    it('has no REAL column holding money', () => {
      const moneyColumns = db
        .prepare<[], { tbl: string; name: string; type: string }>(
          `SELECT m.name AS tbl, c.name AS name, c.type AS type
             FROM sqlite_master AS m
             JOIN pragma_table_info(m.name) AS c
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`
        )
        .all()
        .filter((column) => column.name.endsWith('_cents'));

      expect(moneyColumns.length).toBeGreaterThan(0);
      for (const column of moneyColumns) {
        expect(`${column.tbl}.${column.name}:${column.type}`).toBe(
          `${column.tbl}.${column.name}:INTEGER`
        );
      }
    });
  });

  describe('§3.2 indexes', () => {
    it('indexes (account_id, dedupe_key) on transaction', () => {
      // The difference between a 200 ms import and a four-minute one: the merge
      // rule counts existing rows per key for every incoming row.
      expect(indexShapes(db, 'transaction')).toContain('index:account_id,dedupe_key');
    });

    it('makes (account_id, dedupe_key, occurrence_index) UNIQUE on transaction', () => {
      expect(indexShapes(db, 'transaction')).toContain(
        'unique:account_id,dedupe_key,occurrence_index'
      );
    });

    it('indexes (account_id, effective_date) and (merchant_id, effective_date)', () => {
      const shapes = indexShapes(db, 'transaction');
      expect(shapes).toContain('index:account_id,effective_date');
      expect(shapes).toContain('index:merchant_id,effective_date');
    });

    it('indexes (abs(amount_cents), effective_date) for transfer bucketing', () => {
      const sql = db
        .prepare<[], { sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transaction' AND sql IS NOT NULL`
        )
        .all()
        .map((row) => row.sql.replace(/\s+/g, ' '));

      expect(sql).toContainEqual(
        expect.stringContaining('(abs(amount_cents), effective_date)')
      );
    });

    it('makes (alias_key, match_type) UNIQUE on merchant_alias', () => {
      expect(indexShapes(db, 'merchant_alias')).toContain('unique:alias_key,match_type');
    });

    it('makes (rule_id, subject_type, subject_id) UNIQUE on finding', () => {
      expect(indexShapes(db, 'finding')).toContain('unique:rule_id,subject_type,subject_id');
    });

    it('indexes both directions of finding_evidence', () => {
      const shapes = indexShapes(db, 'finding_evidence');
      expect(shapes).toContain('index:transaction_id');
      expect(shapes).toContain('index:finding_id');
    });

    it('indexes import_id on transaction_source and raw_row', () => {
      expect(indexShapes(db, 'transaction_source')).toContain('index:import_id');
      expect(indexShapes(db, 'raw_row')).toContainEqual(expect.stringContaining('index:import_id'));
    });

    it('makes file_sha256 UNIQUE on statement_import and header_signature UNIQUE on format_profile', () => {
      expect(indexShapes(db, 'statement_import')).toContain('unique:file_sha256');
      expect(indexShapes(db, 'format_profile')).toContain('unique:header_signature');
    });
  });

  describe('§3.2 constraints', () => {
    it('rejects a zero-amount row that is neither pending nor explicitly allowed', () => {
      seedAccount(db);
      expect(() => insertTransaction(db, { amount_cents: 0 })).toThrow(/CHECK constraint/i);
    });

    it('accepts a zero-amount row that is pending, or flagged as a trial authorization', () => {
      seedAccount(db);
      expect(() =>
        insertTransaction(db, { id: 'txn-p', amount_cents: 0, is_pending: 1, dedupe_key: 'k-p' })
      ).not.toThrow();
      expect(() =>
        insertTransaction(db, {
          id: 'txn-z',
          amount_cents: 0,
          allows_zero_amount: 1,
          dedupe_key: 'k-z',
        })
      ).not.toThrow();
    });

    it('rejects a second row with the same (account_id, dedupe_key, occurrence_index)', () => {
      seedAccount(db);
      insertTransaction(db);
      expect(() => insertTransaction(db, { id: 'txn-2' })).toThrow(/UNIQUE constraint/i);
    });

    it('accepts two rows sharing a dedupe_key at different occurrence_index', () => {
      // Two genuine identical $4.75 charges on one day. This is the row the
      // naive "skip anything whose key exists" rule loses (§3.3).
      seedAccount(db);
      insertTransaction(db, { id: 'txn-a', amount_cents: -475, occurrence_index: 0 });
      expect(() =>
        insertTransaction(db, { id: 'txn-b', amount_cents: -475, occurrence_index: 1 })
      ).not.toThrow();
    });

    it('rejects a transaction whose currency differs from its account', () => {
      seedAccount(db);
      expect(() => insertTransaction(db, { currency: 'EUR' })).toThrow(
        /currency must equal account\.currency/
      );
    });

    it('rejects an effective_date that is not COALESCE(transaction_date, posted_date)', () => {
      seedAccount(db);
      expect(() =>
        insertTransaction(db, { transaction_date: '2026-01-03', effective_date: '2026-01-05' })
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        insertTransaction(db, {
          transaction_date: null,
          posted_date: null,
          effective_date: '2026-01-05',
        })
      ).toThrow(/CHECK constraint/i);
    });

    it('enforces foreign keys, and RESTRICT rather than CASCADE', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

      seedAccount(db);
      insertTransaction(db);

      expect(() => db.prepare('DELETE FROM account WHERE id = ?').run('acct-1')).toThrow(
        /FOREIGN KEY constraint/i
      );
      expect(
        db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM "transaction"').get()?.n
      ).toBe(1);
    });
  });
});

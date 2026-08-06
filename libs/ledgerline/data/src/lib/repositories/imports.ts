/**
 * Statement imports, their raw rows, and their deletion (§3.1, §3.3, §6.1).
 *
 * Two things here are load-bearing:
 *
 * **Layer one of idempotency.** `file_sha256` is UNIQUE, and `stage()` returns
 * the existing import for a byte-identical file rather than inserting a second
 * one. §3.3: "Re-uploading a byte-identical file is a no-op that returns the
 * existing import. This covers the common case: you re-drag the same folder."
 *
 * **Last-remaining-source deletion.** Because `transaction_source` is
 * many-to-many, `delete()` removes only the transactions this import is the
 * last source for. §3.3: "Deleting the first of two overlapping imports must not
 * delete rows the second one legitimately contains — the design session's
 * 'removes only its rows' would have done exactly that, and the surviving
 * import's `rows_duplicate` count would have become a lie."
 */

import type { ParseSource, ParseStatus } from '@metrum/ledgerline-domain';

import { newStamp } from './stamp.js';
import type { TombstoneRepository } from './tombstones.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toRawRow, toStatementImport } from '../records.js';
import type {
  ImportStatus,
  RawRowRecord,
  RawRowRow,
  StatementImportRecord,
  StatementImportRow,
} from '../records.js';

export interface StagedRawRow {
  readonly rowIndex: number;
  readonly rawText: string;
  readonly parsedJson: string | null;
  readonly parseStatus: ParseStatus;
  readonly parseSource: ParseSource;
}

export interface StageImportInput {
  readonly sourceFilename: string;
  readonly fileSha256: string;
  readonly fileBytes: Uint8Array;
  readonly accountId?: string | null;
  readonly formatProfileId?: string | null;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly rowsParsed?: number;
  readonly status: ImportStatus;
  readonly parser?: string | null;
  readonly parserVersion?: string | null;
  readonly errorDetail?: string | null;
  readonly diagnosticsJson?: string | null;
  readonly rawRows?: readonly StagedRawRow[];
}

export interface StageImportResult {
  readonly import: StatementImportRecord;
  /** False when a byte-identical file was already present — §3.3 layer one. */
  readonly created: boolean;
}

export interface ImportPatch {
  readonly accountId?: string | null;
  readonly formatProfileId?: string | null;
  readonly status?: ImportStatus;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly rowsParsed?: number;
  readonly rowsInserted?: number;
  readonly rowsDuplicate?: number;
  readonly parser?: string | null;
  readonly parserVersion?: string | null;
  readonly errorDetail?: string | null;
  readonly diagnosticsJson?: string | null;
  readonly importedAt?: string | null;
}

export interface DeleteImportResult {
  readonly deletedTransactionIds: readonly string[];
  readonly retainedTransactionIds: readonly string[];
}

const SELECT = `SELECT id, account_id, source_filename, file_sha256, length(file_bytes) AS file_size_bytes,
                       format_profile_id, period_start, period_end, rows_parsed, rows_inserted,
                       rows_duplicate, status, parser, parser_version, error_detail,
                       diagnostics_json, imported_at, created_at, updated_at
                  FROM statement_import`;

export class ImportRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly tombstones: TombstoneRepository
  ) {}

  /**
   * Store the file and its parse, or return what a byte-identical upload
   * produced last time. The whole thing is one transaction: an import whose
   * `raw_row` rows only half landed is exactly the partial state §2.5 says never
   * happens.
   */
  stage(input: StageImportInput): StageImportResult {
    const existing = this.findByFileSha256(input.fileSha256);
    if (existing) return { import: existing, created: false };

    const stamp = newStamp(this.clock);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO statement_import
             (id, account_id, source_filename, file_sha256, file_bytes, format_profile_id,
              period_start, period_end, rows_parsed, rows_inserted, rows_duplicate, status,
              parser, parser_version, error_detail, diagnostics_json, imported_at,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          stamp.id,
          input.accountId ?? null,
          input.sourceFilename,
          input.fileSha256,
          input.fileBytes,
          input.formatProfileId ?? null,
          input.periodStart ?? null,
          input.periodEnd ?? null,
          input.rowsParsed ?? input.rawRows?.length ?? 0,
          input.status,
          input.parser ?? null,
          input.parserVersion ?? null,
          input.errorDetail ?? null,
          input.diagnosticsJson ?? null,
          stamp.createdAt,
          stamp.updatedAt
        );

      this.insertRawRows(stamp.id, input.rawRows ?? []);
    })();

    return { import: this.getOrThrow(stamp.id), created: true };
  }

  private insertRawRows(importId: string, rows: readonly StagedRawRow[]): void {
    const insert = this.db.prepare(
      `INSERT INTO raw_row (id, import_id, row_index, raw_text, parsed_json, parse_status, parse_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      const stamp = newStamp(this.clock);
      insert.run(
        stamp.id,
        importId,
        row.rowIndex,
        row.rawText,
        row.parsedJson,
        row.parseStatus,
        row.parseSource,
        stamp.createdAt,
        stamp.updatedAt
      );
    }
  }

  /**
   * Re-parse (§6.1, `PATCH /api/imports/:id`). Refused on a committed import,
   * because the rows it produced are already in `transaction` and there is no
   * meaningful way to reconcile a different parse against them.
   */
  replaceRawRows(importId: string, rows: readonly StagedRawRow[], patch: ImportPatch): StatementImportRecord {
    const current = this.getOrThrow(importId);
    if (current.status === 'committed') {
      throw new Error(`import ${importId} is committed; re-parse is refused (spec 6.1)`);
    }

    this.db.transaction(() => {
      const doomed = this.db
        .prepare<[string], { id: string }>('SELECT id FROM raw_row WHERE import_id = ?')
        .all(importId)
        .map((row) => row.id);

      this.db.prepare('DELETE FROM raw_row WHERE import_id = ?').run(importId);
      this.tombstones.recordMany('raw_row', doomed);
      this.insertRawRows(importId, rows);
      this.applyPatch(importId, { ...patch, rowsParsed: patch.rowsParsed ?? rows.length });
    })();

    return this.getOrThrow(importId);
  }

  findByFileSha256(fileSha256: string): StatementImportRecord | null {
    const row = this.db
      .prepare<[string], StatementImportRow>(`${SELECT} WHERE file_sha256 = ?`)
      .get(fileSha256);
    return row ? toStatementImport(row) : null;
  }

  get(id: string): StatementImportRecord | null {
    const row = this.db.prepare<[string], StatementImportRow>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toStatementImport(row) : null;
  }

  getOrThrow(id: string): StatementImportRecord {
    const record = this.get(id);
    if (!record) throw new Error(`no import ${id}`);
    return record;
  }

  list(): StatementImportRecord[] {
    return this.db
      .prepare<[], StatementImportRow>(`${SELECT} ORDER BY created_at DESC, id DESC`)
      .all()
      .map(toStatementImport);
  }

  /** The original bytes, for re-parse under a different column mapping (§6.1). */
  readFileBytes(id: string): Uint8Array {
    const row = this.db
      .prepare<[string], { file_bytes: Buffer }>('SELECT file_bytes FROM statement_import WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`no import ${id}`);
    return new Uint8Array(row.file_bytes);
  }

  listRawRows(importId: string): RawRowRecord[] {
    return this.db
      .prepare<[string], RawRowRow>(
        `SELECT id, import_id, row_index, raw_text, parsed_json, parse_status, parse_source
           FROM raw_row WHERE import_id = ? ORDER BY row_index`
      )
      .all(importId)
      .map(toRawRow);
  }

  update(id: string, patch: ImportPatch): StatementImportRecord {
    this.applyPatch(id, patch);
    return this.getOrThrow(id);
  }

  private applyPatch(id: string, patch: ImportPatch): void {
    const current = this.getOrThrow(id);
    const pick = <T>(next: T | undefined, fallback: T): T => (next === undefined ? fallback : next);

    this.db
      .prepare(
        `UPDATE statement_import
            SET account_id = ?, format_profile_id = ?, status = ?, period_start = ?, period_end = ?,
                rows_parsed = ?, rows_inserted = ?, rows_duplicate = ?, parser = ?, parser_version = ?,
                error_detail = ?, diagnostics_json = ?, imported_at = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        pick(patch.accountId, current.accountId),
        pick(patch.formatProfileId, current.formatProfileId),
        pick(patch.status, current.status),
        pick(patch.periodStart, current.periodStart),
        pick(patch.periodEnd, current.periodEnd),
        pick(patch.rowsParsed, current.rowsParsed),
        pick(patch.rowsInserted, current.rowsInserted),
        pick(patch.rowsDuplicate, current.rowsDuplicate),
        pick(patch.parser, current.parser),
        pick(patch.parserVersion, current.parserVersion),
        pick(patch.errorDetail, current.errorDetail),
        pick(patch.diagnosticsJson, current.diagnosticsJson),
        pick(patch.importedAt, current.importedAt),
        this.clock.now(),
        id
      );
  }

  /**
   * Record that this import covers this transaction.
   *
   * Called for rows the commit *inserted* and for rows the merge rule
   * *absorbed*, which is the half that is easy to forget and impossible to
   * recover: without a source row for an absorbed duplicate, deleting the
   * earlier import would take the transaction with it even though the later
   * statement legitimately contains it (§3.3).
   */
  linkSource(transactionId: string, importId: string, rawRowId: string | null): void {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO transaction_source (id, transaction_id, import_id, raw_row_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (transaction_id, import_id) DO UPDATE SET
           raw_row_id = excluded.raw_row_id,
           updated_at = excluded.updated_at`
      )
      .run(stamp.id, transactionId, importId, rawRowId, stamp.createdAt, stamp.updatedAt);
  }

  /**
   * Move every source of one transaction onto another.
   *
   * The near-duplicate `replace` resolution supersedes a row rather than
   * deleting a fact: the statements that covered the pending charge still cover
   * the posted one it settled into. Dropping their sources would make the
   * replacing import the only source, and deleting that import would then remove
   * a transaction two statements still contain.
   */
  moveSources(fromTransactionId: string, toTransactionId: string): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE OR REPLACE transaction_source
            SET transaction_id = ?, updated_at = ?
          WHERE transaction_id = ?`
      )
      .run(toTransactionId, now, fromTransactionId);
  }

  countSources(transactionId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM transaction_source WHERE transaction_id = ?'
        )
        .get(transactionId)?.n ?? 0
    );
  }

  /** Which imports cover a transaction — §6.3's row expander. */
  listImportsForTransaction(transactionId: string): StatementImportRecord[] {
    return this.db
      .prepare<[string], StatementImportRow>(
        `${SELECT} WHERE id IN (SELECT import_id FROM transaction_source WHERE transaction_id = ?)
          ORDER BY created_at`
      )
      .all(transactionId)
      .map(toStatementImport);
  }

  /**
   * §3.3's import deletion, in one transaction.
   *
   * A transaction is removed only when this import is its **last remaining**
   * source. Everything else is re-pointed rather than orphaned: a surviving
   * transaction whose `raw_row_id` belonged to this import is moved onto the raw
   * row of another import that covers it, so §6.3's verbatim line survives the
   * deletion of one of two overlapping statements.
   */
  delete(id: string): DeleteImportResult {
    const record = this.getOrThrow(id);

    return this.db.transaction((): DeleteImportResult => {
      const covered = this.db
        .prepare<[string], { transaction_id: string }>(
          'SELECT transaction_id FROM transaction_source WHERE import_id = ?'
        )
        .all(id)
        .map((row) => row.transaction_id);

      const lastSource = new Set(
        this.db
          .prepare<[string, string], { transaction_id: string }>(
            `SELECT ts.transaction_id
               FROM transaction_source AS ts
              WHERE ts.import_id = ?
                AND NOT EXISTS (SELECT 1 FROM transaction_source AS other
                                 WHERE other.transaction_id = ts.transaction_id
                                   AND other.import_id <> ?)`
          )
          .all(id, id)
          .map((row) => row.transaction_id)
      );

      const retained = covered.filter((transactionId) => !lastSource.has(transactionId));

      // Re-point the survivors' verbatim line before this import's raw rows go.
      const repoint = this.db.prepare(
        `UPDATE "transaction"
            SET raw_row_id = (SELECT ts.raw_row_id
                                FROM transaction_source AS ts
                               WHERE ts.transaction_id = "transaction".id
                                 AND ts.import_id <> ?
                                 AND ts.raw_row_id IS NOT NULL
                               ORDER BY ts.created_at
                               LIMIT 1),
                updated_at = ?
          WHERE id = ?
            AND raw_row_id IN (SELECT id FROM raw_row WHERE import_id = ?)`
      );
      const now = this.clock.now();
      for (const transactionId of retained) {
        repoint.run(id, now, transactionId, id);
      }

      this.db.prepare('DELETE FROM transaction_source WHERE import_id = ?').run(id);

      const deleteEvidence = this.db.prepare('DELETE FROM finding_evidence WHERE transaction_id = ?');
      const deleteTransaction = this.db.prepare('DELETE FROM "transaction" WHERE id = ?');
      for (const transactionId of lastSource) {
        deleteEvidence.run(transactionId);
        deleteTransaction.run(transactionId);
      }

      const doomedRawRows = this.db
        .prepare<[string], { id: string }>('SELECT id FROM raw_row WHERE import_id = ?')
        .all(id)
        .map((row) => row.id);

      this.db.prepare('DELETE FROM raw_row WHERE import_id = ?').run(id);
      this.db.prepare('DELETE FROM statement_import WHERE id = ?').run(record.id);

      this.tombstones.recordMany('transaction', [...lastSource]);
      this.tombstones.recordMany('raw_row', doomedRawRows);
      this.tombstones.record('statement_import', record.id);

      return { deletedTransactionIds: [...lastSource], retainedTransactionIds: retained };
    })();
  }
}

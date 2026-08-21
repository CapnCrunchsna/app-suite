/**
 * Transactions — the read and write paths over §3.1's `transaction` table.
 *
 * Every method here is a **named intent** (§3.4). No caller passes a query
 * string, a fragment of one, or a column name; filters arrive as a typed object
 * and are turned into SQL in this file. That is the whole reason the later
 * Elasticsearch move is "mechanical instead of a rewrite" — these method bodies
 * are the entire surface that has to be rewritten against ES, and the sort keys
 * and text-search shape are chosen from fixed allow-lists so there is nothing to
 * translate that isn't enumerated here.
 */

import { addDaysIso } from '@metrum/ledgerline-domain';
import type { Currency, DateRange } from '@metrum/ledgerline-domain';

import { newStamp, asInt } from './stamp.js';
import type { TombstoneRepository } from './tombstones.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toTransaction } from '../records.js';
import type { ProvenanceSource, TransactionRecord, TransactionRow } from '../records.js';

export interface NewTransaction {
  readonly accountId: string;
  readonly rawRowId: string | null;
  readonly postedDate: string | null;
  readonly transactionDate: string | null;
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly currency: Currency;
  readonly descriptionRaw: string;
  readonly descriptionNormalized: string;
  readonly merchantId: string | null;
  readonly categoryId?: string | null;
  readonly categorySource?: ProvenanceSource | null;
  readonly isPending: boolean;
  readonly allowsZeroAmount?: boolean;
  readonly dedupeKey: string;
  readonly dedupeKeyVersion: string;
  readonly occurrenceIndex: number;
}

export interface TransactionPatch {
  readonly merchantId?: string | null;
  readonly categoryId?: string | null;
  readonly categorySource?: ProvenanceSource | null;
  readonly isInternalTransfer?: boolean;
  readonly isExcluded?: boolean;
  readonly transferPairId?: string | null;
  readonly refundPairId?: string | null;
}

export type TransactionSort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

export interface TransactionQuery {
  readonly accountIds?: readonly string[];
  readonly dateRange?: DateRange;
  readonly minAmountCents?: number;
  readonly maxAmountCents?: number;
  readonly merchantIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  /**
   * Exact match on `description_normalized` — §6.3's "apply to all 47 matching
   * descriptors".
   *
   * Exact and not `LIKE`, unlike `text` below. The dry-run count and the apply
   * that follows it have to select the same set, and a substring filter makes
   * that promise depend on nothing having been typed into the search box in
   * between. A user who is told "47 matching" and gets 51 updated has been lied
   * to about a permanent, precedence-topping correction (§4.3).
   */
  readonly descriptorsNormalized?: readonly string[];
  readonly isPending?: boolean;
  readonly hasFinding?: boolean;
  /** §6.3: the internal-transfer toggle is **off by default** — a credit-card
   *  payment is not spending, and showing it by default double-counts on screen
   *  what §2.6 was built to keep out of the totals. */
  readonly includeInternalTransfers?: boolean;
  readonly includeExcluded?: boolean;
  /** Full-text across raw and normalized descriptors (§6.3). */
  readonly text?: string;
  readonly sort?: TransactionSort;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TransactionSearchRow {
  readonly transaction: TransactionRecord;
  /** §2.3: "Includes `hasFinding` via `finding_evidence`." */
  readonly hasFinding: boolean;
}

export interface TransactionPage {
  readonly rows: readonly TransactionSearchRow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * What one bulk correction changed (§2.3's `POST /api/transactions/bulk`).
 *
 * `transactionIds` is returned rather than only a count because §4.3's
 * re-normalize job is incremental — "only transactions whose current
 * `description_normalized` falls in the affected alias key-space are
 * re-resolved" — and that job's payload is exactly this set.
 */
export interface BulkApplyResult {
  readonly matched: number;
  readonly transactionIds: readonly string[];
}

export interface MerchantDebits {
  readonly merchantId: string | null;
  readonly merchantName: string;
  readonly transactions: readonly TransactionRecord[];
}

export interface MonthlyCategoryTotal {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly totalCents: number;
  readonly transactionCount: number;
}

export interface NearDuplicateWindow {
  readonly accountId: string;
  readonly effectiveDate: string;
  readonly amountCents: number;
  /** Rows sharing this key are the merge rule's business, never a near-dup. */
  readonly dedupeKey: string;
  readonly excludeTransactionIds?: readonly string[];
}

/** §3.3's window: `|Δ effective_date| ≤ 3` days. */
export const NEAR_DUPLICATE_DAYS = 3;
/** §3.3: "an amount within ±$2 **or** ±3%". */
export const NEAR_DUPLICATE_ABS_CENTS = 200;
export const NEAR_DUPLICATE_PERCENT = 3;

const COLUMNS = `id, account_id, raw_row_id, posted_date, transaction_date, effective_date,
                 amount_cents, balance_cents, currency, description_raw, description_normalized,
                 merchant_id, category_id, category_source, is_pending, is_internal_transfer,
                 transfer_pair_id, refund_pair_id, is_excluded, allows_zero_amount,
                 dedupe_key, dedupe_key_version, occurrence_index, created_at, updated_at`;

const SELECT = `SELECT ${COLUMNS} FROM "transaction"`;

/** A fixed map, so a sort key can never reach SQL uninterpreted. */
const SORT_SQL: Readonly<Record<TransactionSort, string>> = {
  date_desc: 'effective_date DESC, id DESC',
  date_asc: 'effective_date ASC, id ASC',
  amount_desc: 'amount_cents DESC, id DESC',
  amount_asc: 'amount_cents ASC, id ASC',
};

/** `%` and `_` are wildcards; a merchant name containing one must not become a
 *  pattern. `\` is the escape character declared in the LIKE clause. */
function likeTerm(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class TransactionRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly tombstones: TombstoneRepository,
  ) {}

  insert(input: NewTransaction): TransactionRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO "transaction"
           (id, account_id, raw_row_id, posted_date, transaction_date, effective_date,
            amount_cents, balance_cents, currency, description_raw, description_normalized,
            merchant_id, category_id, category_source, is_pending, is_internal_transfer,
            transfer_pair_id, refund_pair_id, is_excluded, allows_zero_amount,
            dedupe_key, dedupe_key_version, occurrence_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp.id,
        input.accountId,
        input.rawRowId,
        input.postedDate,
        input.transactionDate,
        input.effectiveDate,
        input.amountCents,
        input.balanceCents,
        input.currency,
        input.descriptionRaw,
        input.descriptionNormalized,
        input.merchantId,
        input.categoryId ?? null,
        input.categorySource ?? null,
        asInt(input.isPending),
        asInt(input.allowsZeroAmount ?? false),
        input.dedupeKey,
        input.dedupeKeyVersion,
        input.occurrenceIndex,
        stamp.createdAt,
        stamp.updatedAt,
      );
    return this.getOrThrow(stamp.id);
  }

  get(id: string): TransactionRecord | null {
    const row = this.db.prepare<[string], TransactionRow>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toTransaction(row) : null;
  }

  getOrThrow(id: string): TransactionRecord {
    const record = this.get(id);
    if (!record) throw new Error(`no transaction ${id}`);
    return record;
  }

  update(id: string, patch: TransactionPatch): TransactionRecord {
    const current = this.getOrThrow(id);
    const pick = <T>(next: T | undefined, fallback: T): T => (next === undefined ? fallback : next);

    this.db
      .prepare(
        `UPDATE "transaction"
            SET merchant_id = ?, category_id = ?, category_source = ?, is_internal_transfer = ?,
                is_excluded = ?, transfer_pair_id = ?, refund_pair_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        pick(patch.merchantId, current.merchantId),
        pick(patch.categoryId, current.categoryId),
        pick(patch.categorySource, current.categorySource),
        asInt(pick(patch.isInternalTransfer, current.isInternalTransfer)),
        asInt(pick(patch.isExcluded, current.isExcluded)),
        pick(patch.transferPairId, current.transferPairId),
        pick(patch.refundPairId, current.refundPairId),
        this.clock.now(),
        id,
      );
    return this.getOrThrow(id);
  }

  /**
   * Remove a row and everything that RESTRICT would otherwise block, writing a
   * tombstone (§3.4). Used by the near-duplicate `replace` resolution, where a
   * pending row is superseded by the posted row that settled it (§2.5).
   */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM finding_evidence WHERE transaction_id = ?').run(id);
      this.db.prepare('DELETE FROM transaction_source WHERE transaction_id = ?').run(id);
      this.db.prepare('DELETE FROM "transaction" WHERE id = ?').run(id);
      this.tombstones.record('transaction', id);
    })();
  }

  // ------------------------------------------------------- the merge rule ---

  /**
   * How many rows the account already holds under each key.
   *
   * This is the query §3.2's first index exists for: "The merge rule counts
   * existing rows per key for every incoming row. Without it, a 500-row import
   * is 500 table scans." One statement for the whole file rather than one per
   * row, so the index is used once per distinct key.
   */
  countByDedupeKey(accountId: string, dedupeKeys: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (dedupeKeys.length === 0) return counts;

    const statement = this.db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM "transaction" WHERE account_id = ? AND dedupe_key = ?`,
    );
    for (const key of new Set(dedupeKeys)) {
      counts.set(key, statement.get(accountId, key)?.n ?? 0);
    }
    return counts;
  }

  /**
   * The next free `occurrence_index` for a key.
   *
   * `MAX(...) + 1` rather than `COUNT(...)`: an import deleted under §3.3 leaves
   * a hole, and a count-derived index would collide with a surviving row and
   * trip the UNIQUE constraint on a re-import that is otherwise correct.
   */
  nextOccurrenceIndex(accountId: string, dedupeKey: string): number {
    const row = this.db
      .prepare<[string, string], { highest: number | null }>(
        'SELECT MAX(occurrence_index) AS highest FROM "transaction" WHERE account_id = ? AND dedupe_key = ?',
      )
      .get(accountId, dedupeKey);
    return (row?.highest ?? -1) + 1;
  }

  listByDedupeKey(accountId: string, dedupeKey: string): TransactionRecord[] {
    return this.db
      .prepare<[string, string], TransactionRow>(
        `${SELECT} WHERE account_id = ? AND dedupe_key = ? ORDER BY occurrence_index`,
      )
      .all(accountId, dedupeKey)
      .map(toTransaction);
  }

  /**
   * §3.3: "Imports refuse to run while the table contains mixed
   * `dedupe_key_version` values." Returns every version present, so the caller
   * can name them in the refusal.
   */
  distinctDedupeKeyVersions(): string[] {
    return this.db
      .prepare<[], { dedupe_key_version: string }>(
        'SELECT DISTINCT dedupe_key_version FROM "transaction" ORDER BY dedupe_key_version',
      )
      .all()
      .map((row) => row.dedupe_key_version);
  }

  /**
   * §3.3's near-duplicate candidates: same account, `|Δ effective_date| ≤ 3`
   * days, amount within ±$2 **or** ±3%. The `collapse_v1(description_raw)`
   * equality is applied by the caller, which is where the frozen collapse lives.
   *
   * Rows sharing the incoming row's `dedupe_key` are excluded. The merge rule
   * has already reasoned about those exactly; this pass exists for the three
   * cases in §3.3 that produce rows with *different* keys that are nonetheless
   * the same transaction. Including them would flag two genuine identical $4.75
   * charges as near-duplicates of each other.
   *
   * All-integer arithmetic: `|Δ| * 100 ≤ 3 * max(|a|, |b|)` is the ±3% test
   * without a float, per §3.1's money rule.
   */
  findNearDuplicateCandidates(window: NearDuplicateWindow): TransactionRecord[] {
    const excluded = window.excludeTransactionIds ?? [];
    const placeholders = excluded.map(() => '?').join(', ');

    const sql = `${SELECT}
       WHERE account_id = ?
         AND dedupe_key <> ?
         AND effective_date >= ?
         AND effective_date <= ?
         AND (ABS(amount_cents - ?) <= ${NEAR_DUPLICATE_ABS_CENTS}
              OR ABS(amount_cents - ?) * 100 <= ${NEAR_DUPLICATE_PERCENT} * MAX(ABS(amount_cents), ABS(?)))
         ${excluded.length > 0 ? `AND id NOT IN (${placeholders})` : ''}
       ORDER BY effective_date, id`;

    return this.db
      .prepare<unknown[], TransactionRow>(sql)
      .all(
        window.accountId,
        window.dedupeKey,
        addDaysIso(window.effectiveDate, -NEAR_DUPLICATE_DAYS),
        addDaysIso(window.effectiveDate, NEAR_DUPLICATE_DAYS),
        window.amountCents,
        window.amountCents,
        window.amountCents,
        ...excluded,
      )
      .map(toTransaction);
  }

  /**
   * §3.3's refund pairing candidates: same account, same canonical merchant,
   * equal absolute amount, opposite sign, credit within 90 days of the debit,
   * neither side already paired.
   *
   * Pending rows are excluded on both sides. A pending authorization has not
   * settled, so "reversed" is not yet a fact about it; when it posts, the posted
   * row is what pairs.
   */
  findRefundCounterpart(input: {
    readonly accountId: string;
    readonly merchantId: string;
    readonly amountCents: number;
    readonly effectiveDate: string;
    readonly excludeTransactionId: string;
    readonly windowDays: number;
  }): TransactionRecord | null {
    const isDebit = input.amountCents < 0;
    // Money leaves before it comes back: the credit is always the later side.
    const from = isDebit ? input.effectiveDate : addDaysIso(input.effectiveDate, -input.windowDays);
    const to = isDebit ? addDaysIso(input.effectiveDate, input.windowDays) : input.effectiveDate;

    const row = this.db
      .prepare<[string, string, number, string, string, string], TransactionRow>(
        `${SELECT}
          WHERE account_id = ?
            AND merchant_id = ?
            AND amount_cents = ?
            AND refund_pair_id IS NULL
            AND is_pending = 0
            AND effective_date >= ?
            AND effective_date <= ?
            AND id <> ?
          ORDER BY effective_date ${isDebit ? 'ASC' : 'DESC'}, id
          LIMIT 1`,
      )
      .get(
        input.accountId,
        input.merchantId,
        -input.amountCents,
        from,
        to,
        input.excludeTransactionId,
      );

    return row ? toTransaction(row) : null;
  }

  /** Both rows of a reversal carry the same `refund_pair_id` (§3.3). */
  linkRefundPair(debitId: string, creditId: string, pairId: string): void {
    const now = this.clock.now();
    const statement = this.db.prepare(
      'UPDATE "transaction" SET refund_pair_id = ?, updated_at = ? WHERE id = ?',
    );
    statement.run(pairId, now, debitId);
    statement.run(pairId, now, creditId);
  }

  // ------------------------------------------------------------ read paths ---

  /**
   * §6.3's filter set as one SQL predicate, shared by every read that takes a
   * `TransactionQuery`.
   *
   * Built once rather than per method on purpose. `search` shows the user a
   * count, `countMatching` is what the bulk dry-run promises, and `applyBulk` is
   * what actually writes — three callers that must agree exactly. Duplicating
   * the clause is how "apply to all 47 matching" comes to update 51 rows.
   */
  private buildFilter(query: TransactionQuery): {
    clause: string;
    params: unknown[];
  } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.accountIds?.length) {
      where.push(`t.account_id IN (${query.accountIds.map(() => '?').join(', ')})`);
      params.push(...query.accountIds);
    }
    if (query.dateRange) {
      where.push('t.effective_date >= ? AND t.effective_date <= ?');
      params.push(query.dateRange.from, query.dateRange.to);
    }
    if (query.minAmountCents !== undefined) {
      where.push('t.amount_cents >= ?');
      params.push(query.minAmountCents);
    }
    if (query.maxAmountCents !== undefined) {
      where.push('t.amount_cents <= ?');
      params.push(query.maxAmountCents);
    }
    if (query.merchantIds?.length) {
      where.push(`t.merchant_id IN (${query.merchantIds.map(() => '?').join(', ')})`);
      params.push(...query.merchantIds);
    }
    if (query.categoryIds?.length) {
      where.push(`t.category_id IN (${query.categoryIds.map(() => '?').join(', ')})`);
      params.push(...query.categoryIds);
    }
    if (query.descriptorsNormalized?.length) {
      where.push(
        `t.description_normalized IN (${query.descriptorsNormalized.map(() => '?').join(', ')})`,
      );
      params.push(...query.descriptorsNormalized);
    }
    if (query.isPending !== undefined) {
      where.push('t.is_pending = ?');
      params.push(asInt(query.isPending));
    }
    if (!query.includeInternalTransfers) {
      where.push('t.is_internal_transfer = 0');
    }
    if (!query.includeExcluded) {
      where.push('t.is_excluded = 0');
    }
    if (query.text) {
      where.push(
        `(t.description_raw LIKE ? ESCAPE '\\' OR t.description_normalized LIKE ? ESCAPE '\\')`,
      );
      params.push(likeTerm(query.text), likeTerm(query.text));
    }
    if (query.hasFinding !== undefined) {
      where.push(
        `${query.hasFinding ? 'EXISTS' : 'NOT EXISTS'} (SELECT 1 FROM finding_evidence AS fe WHERE fe.transaction_id = t.id)`,
      );
    }

    return {
      clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }

  search(query: TransactionQuery): TransactionPage {
    const { clause, params } = this.buildFilter(query);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);

    const total =
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM "transaction" AS t ${clause}`)
        .get(...params)?.n ?? 0;

    const rows = this.db
      .prepare<unknown[], TransactionRow & { has_finding: number }>(
        `SELECT ${COLUMNS.split(',')
          .map((column) => `t.${column.trim()}`)
          .join(', ')},
                EXISTS (SELECT 1 FROM finding_evidence AS fe WHERE fe.transaction_id = t.id) AS has_finding
           FROM "transaction" AS t
           ${clause}
          ORDER BY ${SORT_SQL[query.sort ?? 'date_desc']}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map((row) => ({
        transaction: toTransaction(row),
        hasFinding: row.has_finding === 1,
      }));

    return { rows, total, limit, offset };
  }

  /**
   * How many rows a filter matches, without hydrating one.
   *
   * §2.3: "`?dryRun=true` returns the match count only — this is what backs the
   * UI's 'apply to all 47 matching'." The count is the whole answer, so this is
   * `COUNT(*)` and not `search().total`: the paged variant also selects and maps
   * a page of rows nobody asked for.
   */
  countMatching(query: TransactionQuery): number {
    const { clause, params } = this.buildFilter(query);
    return (
      this.db
        .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM "transaction" AS t ${clause}`)
        .get(...params)?.n ?? 0
    );
  }

  /**
   * The distinct `description_normalized` values a filter covers.
   *
   * §4.3's alias rows are keyed on the normalized descriptor, not on a
   * transaction — "fixing `SPOTIFYUSA` once retroactively merges four years of
   * charges into one series." A bulk merchant correction over a filter that
   * happens to span two spellings therefore has to write two aliases, and this is
   * how the caller learns there were two.
   */
  listMatchingDescriptors(query: TransactionQuery): string[] {
    const { clause, params } = this.buildFilter(query);
    return this.db
      .prepare<unknown[], { description_normalized: string }>(
        `SELECT DISTINCT t.description_normalized
           FROM "transaction" AS t ${clause}
          ORDER BY t.description_normalized`,
      )
      .all(...params)
      .map((row) => row.description_normalized);
  }

  /**
   * Apply one change to every row a filter matches (§2.3, §6.3).
   *
   * Two properties this owes its caller. The ids are collected **inside** the
   * same transaction as the writes, so the set that gets updated is the set that
   * gets reported — no second evaluation of the filter, and nothing observable
   * between the two halves. And only the columns the patch actually names are
   * written: `update` above reads-then-writes every column, which for a bulk
   * merchant assignment would rewrite `is_excluded` and `category_source` on
   * hundreds of rows to the values they already had, and would clobber a
   * concurrent edit on any column the caller never mentioned.
   */
  applyBulk(query: TransactionQuery, patch: TransactionPatch): BulkApplyResult {
    const assignments: string[] = [];
    const values: unknown[] = [];

    // A fixed column map, for the same reason SORT_SQL is one: no caller string
    // reaches SQL uninterpreted (§3.4).
    if (patch.merchantId !== undefined) {
      assignments.push('merchant_id = ?');
      values.push(patch.merchantId);
    }
    if (patch.categoryId !== undefined) {
      assignments.push('category_id = ?');
      values.push(patch.categoryId);
    }
    if (patch.categorySource !== undefined) {
      assignments.push('category_source = ?');
      values.push(patch.categorySource);
    }
    if (patch.isInternalTransfer !== undefined) {
      assignments.push('is_internal_transfer = ?');
      values.push(asInt(patch.isInternalTransfer));
    }
    if (patch.isExcluded !== undefined) {
      assignments.push('is_excluded = ?');
      values.push(asInt(patch.isExcluded));
    }
    if (patch.transferPairId !== undefined) {
      assignments.push('transfer_pair_id = ?');
      values.push(patch.transferPairId);
    }
    if (patch.refundPairId !== undefined) {
      assignments.push('refund_pair_id = ?');
      values.push(patch.refundPairId);
    }

    const { clause, params } = this.buildFilter(query);

    return this.db.transaction(() => {
      const ids = this.db
        .prepare<unknown[], { id: string }>(`SELECT t.id FROM "transaction" AS t ${clause}`)
        .all(...params)
        .map((row) => row.id);

      // An empty patch is a legal no-op — the caller may have sent a change that
      // reduced to nothing — but `SET updated_at = ?` alone would still stamp
      // every matched row as edited.
      if (assignments.length > 0 && ids.length > 0) {
        const statement = this.db.prepare(
          `UPDATE "transaction" SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`,
        );
        const now = this.clock.now();
        for (const id of ids) statement.run(...values, now, id);
      }

      return { matched: ids.length, transactionIds: ids };
    })();
  }

  /**
   * §2.6's "What this cannot do", counted per account for §6.2.
   *
   * "A transfer to an account not in the system has no counterpart and will never
   * link, so it counts as spend. The Accounts page says so where coverage is
   * incomplete; there is no algorithmic fix, only importing the other side." This
   * is the number that lets the page say it: transfer-worded debits carrying no
   * link at all.
   *
   * The keywords arrive as an argument rather than living here, and that is §7.4
   * doing its job across a boundary — they are `config.transfers.keywords` in
   * `analyzers`, hashed into `config_hash`, and `type:data-access` may not import
   * that lib. A copy in this file would be a second list to keep in step, which
   * is precisely the failure §7.4's "no analyzer reads a module-level constant"
   * exists to prevent.
   *
   * A `rejected` link still counts the row as unmatched: the user has said that
   * *pair* is not a transfer, which leaves the question of where the money went
   * exactly where it was.
   */
  countUnlinkedTransferDebits(accountId: string, keywords: readonly string[]): number {
    if (keywords.length === 0) return 0;

    const matches = keywords.map(() => `t.description_normalized LIKE ? ESCAPE '\\'`).join(' OR ');

    return (
      this.db
        .prepare<unknown[], { n: number }>(
          `SELECT COUNT(*) AS n
             FROM "transaction" AS t
            WHERE t.account_id = ?
              AND t.amount_cents < 0
              AND t.is_pending = 0
              AND t.is_excluded = 0
              AND (${matches})
              AND NOT EXISTS (
                    SELECT 1 FROM transfer_link AS l
                     WHERE l.debit_transaction_id = t.id AND l.state <> 'rejected')`,
        )
        .get(accountId, ...keywords.map(likeTerm))?.n ?? 0
    );
  }

  countForAccount(accountId: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM "transaction" WHERE account_id = ?',
        )
        .get(accountId)?.n ?? 0
    );
  }

  countAll(): number {
    return (
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM "transaction"').get()?.n ?? 0
    );
  }

  /**
   * §3.4 names this method. Debits only, grouped by canonical merchant, over a
   * closed date range.
   *
   * Pending rows, internal transfers and excluded rows are out: §2.5 says
   * pending rows are "excluded from every analyzer and every total", and a
   * credit-card payment counted as spend is the failure §2.6 exists to prevent.
   */
  listDebitsByMerchant(range: DateRange): MerchantDebits[] {
    const rows = this.db
      .prepare<[string, string], TransactionRow & { merchant_name: string | null }>(
        `SELECT ${COLUMNS.split(',')
          .map((column) => `t.${column.trim()}`)
          .join(', ')},
                m.canonical_name AS merchant_name
           FROM "transaction" AS t
           LEFT JOIN merchant_canonical AS m ON m.id = t.merchant_id
          WHERE t.amount_cents < 0
            AND t.is_pending = 0
            AND t.is_internal_transfer = 0
            AND t.is_excluded = 0
            AND t.effective_date >= ?
            AND t.effective_date <= ?
          ORDER BY m.canonical_name, t.effective_date, t.id`,
      )
      .all(range.from, range.to);

    const grouped = new Map<
      string,
      {
        merchantId: string | null;
        merchantName: string;
        transactions: TransactionRecord[];
      }
    >();
    for (const row of rows) {
      const key = row.merchant_id ?? ` unresolved:${row.description_normalized}`;
      let bucket = grouped.get(key);
      if (!bucket) {
        bucket = {
          merchantId: row.merchant_id,
          merchantName: row.merchant_name ?? row.description_normalized,
          transactions: [],
        };
        grouped.set(key, bucket);
      }
      bucket.transactions.push(toTransaction(row));
    }
    return [...grouped.values()];
  }

  /**
   * §3.4 names this method too. Signed integer cents summed per calendar month
   * and category — `SUM` over an INTEGER column, so there is no float in the
   * aggregate any more than there is in the column (§3.1).
   */
  monthlyCategoryTotals(range: DateRange): MonthlyCategoryTotal[] {
    return this.db
      .prepare<
        [string, string],
        {
          month: string;
          category_id: string | null;
          category_name: string | null;
          total_cents: number;
          transaction_count: number;
        }
      >(
        `SELECT substr(t.effective_date, 1, 7) AS month,
                t.category_id AS category_id,
                c.name AS category_name,
                SUM(t.amount_cents) AS total_cents,
                COUNT(*) AS transaction_count
           FROM "transaction" AS t
           LEFT JOIN category AS c ON c.id = t.category_id
          WHERE t.is_pending = 0
            AND t.is_internal_transfer = 0
            AND t.is_excluded = 0
            AND t.effective_date >= ?
            AND t.effective_date <= ?
          GROUP BY month, t.category_id
          ORDER BY month, c.name`,
      )
      .all(range.from, range.to)
      .map((row) => ({
        month: row.month,
        categoryId: row.category_id,
        categoryName: row.category_name,
        totalCents: row.total_cents,
        transactionCount: row.transaction_count,
      }));
  }
}

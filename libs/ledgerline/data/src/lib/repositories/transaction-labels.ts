/**
 * §7.6's ground truth, per transaction (§3.1, migration 008, §9ab).
 *
 * §9z's `finding_label` records whether a finding that fired was right — precision.
 * This records what *should* be found, against the rows, which is the only way to
 * measure what was missed. §7.6 asks for exactly this and calls it "the expected
 * findings written down".
 *
 * ## Null is a third value everywhere, and it carries the whole design
 *
 * `is_fee = NULL` means nobody looked. `is_fee = 0` means somebody looked and said
 * no. A recall figure computed without that distinction would treat every unexamined
 * row as evidence the rules are right, which is precisely backwards — the unexamined
 * rows are where a miss hides.
 */

import { newStamp, asInt } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

/** Where a judgement came from. Kept apart because they are different evidence —
 *  see migration 008. */
export type LabelOrigin = 'review' | 'correction';

/** The assertions a single row can carry. `undefined` leaves a field alone on a
 *  write; `null` clears it back to "not asserted". */
export interface TransactionLabelInput {
  readonly transactionId: string;
  readonly expectedMerchantId?: string | null;
  readonly isRecurring?: boolean | null;
  readonly isFee?: boolean | null;
  readonly isTransfer?: boolean | null;
  readonly isOutlier?: boolean | null;
  readonly note?: string | null;
  /** What §4.1's chain had concluded when the judgement was made. */
  readonly chainMerchantId: string | null;
  readonly chainDescriptionNormalized: string;
  readonly origin: LabelOrigin;
}

export interface TransactionLabelRecord {
  readonly id: string;
  readonly transactionId: string;
  readonly expectedMerchantId: string | null;
  readonly isRecurring: boolean | null;
  readonly isFee: boolean | null;
  readonly isTransfer: boolean | null;
  readonly isOutlier: boolean | null;
  readonly note: string | null;
  readonly chainMerchantId: string | null;
  readonly chainDescriptionNormalized: string;
  readonly origin: LabelOrigin;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** How far the pass has got, which is the one number that makes an afternoon of this
 *  feel finite. */
export interface LabelProgress {
  readonly labelled: number;
  readonly fromReview: number;
  readonly fromCorrection: number;
  readonly total: number;
}

interface LabelRow {
  id: string;
  transaction_id: string;
  expected_merchant_id: string | null;
  is_recurring: number | null;
  is_fee: number | null;
  is_transfer: number | null;
  is_outlier: number | null;
  note: string | null;
  chain_merchant_id: string | null;
  chain_description_normalized: string;
  origin: LabelOrigin;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, transaction_id, expected_merchant_id, is_recurring, is_fee,
                       is_transfer, is_outlier, note, chain_merchant_id,
                       chain_description_normalized, origin, created_at, updated_at
                  FROM transaction_label`;

const asBool = (value: number | null): boolean | null => (value === null ? null : value === 1);

function toLabel(row: LabelRow): TransactionLabelRecord {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    expectedMerchantId: row.expected_merchant_id,
    isRecurring: asBool(row.is_recurring),
    isFee: asBool(row.is_fee),
    isTransfer: asBool(row.is_transfer),
    isOutlier: asBool(row.is_outlier),
    note: row.note,
    chainMerchantId: row.chain_merchant_id,
    chainDescriptionNormalized: row.chain_description_normalized,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `undefined` leaves a column alone; `null` clears it. The three-way distinction has
 *  to survive all the way to the SQL or a partial write silently erases an assertion
 *  the labeller made ten rows ago. */
const flag = (value: boolean | null | undefined, current: number | null): number | null =>
  value === undefined ? current : value === null ? null : asInt(value);

export class TransactionLabelRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock
  ) {}

  get(transactionId: string): TransactionLabelRecord | null {
    const row = this.db
      .prepare<[string], LabelRow>(`${SELECT} WHERE transaction_id = ?`)
      .get(transactionId);
    return row ? toLabel(row) : null;
  }

  /** Every judgement, for the scorecard and for §2.3's export. */
  list(): TransactionLabelRecord[] {
    return this.db
      .prepare<[], LabelRow>(`${SELECT} ORDER BY updated_at DESC`)
      .all()
      .map(toLabel);
  }

  byTransactionIds(ids: readonly string[]): Map<string, TransactionLabelRecord> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare<string[], LabelRow>(`${SELECT} WHERE transaction_id IN (${holes})`)
      .all(...ids);
    return new Map(rows.map((row) => [row.transaction_id, toLabel(row)]));
  }

  /**
   * Write or amend one judgement.
   *
   * A merge rather than a replace, because the pass is incremental: someone marking a
   * row as a fee on Tuesday has not thereby retracted the merchant they corrected on
   * Monday. Only the fields present in the input move.
   *
   * `origin` is *not* merged — a deliberate review always wins over a correction's
   * side effect, because a row somebody actually looked at is better evidence than
   * one inferred from an edit, and the scorecard separates the two.
   */
  put(input: TransactionLabelInput): TransactionLabelRecord {
    const existing = this.db
      .prepare<[string], LabelRow>(`${SELECT} WHERE transaction_id = ?`)
      .get(input.transactionId);

    const stamp = newStamp(this.clock);

    if (existing) {
      this.db
        .prepare(
          `UPDATE transaction_label
              SET expected_merchant_id = ?, is_recurring = ?, is_fee = ?, is_transfer = ?,
                  is_outlier = ?, note = ?, chain_merchant_id = ?,
                  chain_description_normalized = ?, origin = ?, updated_at = ?
            WHERE transaction_id = ?`
        )
        .run(
          input.expectedMerchantId === undefined
            ? existing.expected_merchant_id
            : input.expectedMerchantId,
          flag(input.isRecurring, existing.is_recurring),
          flag(input.isFee, existing.is_fee),
          flag(input.isTransfer, existing.is_transfer),
          flag(input.isOutlier, existing.is_outlier),
          input.note === undefined ? existing.note : input.note,
          // The chain's answer is re-captured on every write, because the point of
          // it is what the machine said when this judgement was last true.
          input.chainMerchantId,
          input.chainDescriptionNormalized,
          existing.origin === 'review' ? 'review' : input.origin,
          stamp.updatedAt,
          input.transactionId
        );
      return this.get(input.transactionId) as TransactionLabelRecord;
    }

    this.db
      .prepare(
        `INSERT INTO transaction_label
           (id, transaction_id, expected_merchant_id, is_recurring, is_fee, is_transfer,
            is_outlier, note, chain_merchant_id, chain_description_normalized, origin,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stamp.id,
        input.transactionId,
        input.expectedMerchantId ?? null,
        flag(input.isRecurring, null),
        flag(input.isFee, null),
        flag(input.isTransfer, null),
        flag(input.isOutlier, null),
        input.note ?? null,
        input.chainMerchantId,
        input.chainDescriptionNormalized,
        input.origin,
        stamp.createdAt,
        stamp.updatedAt
      );

    return this.get(input.transactionId) as TransactionLabelRecord;
  }

  remove(transactionId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM transaction_label WHERE transaction_id = ?')
        .run(transactionId).changes > 0
    );
  }

  progress(): LabelProgress {
    const counts = this.db
      .prepare<[], { origin: LabelOrigin; n: number }>(
        'SELECT origin, COUNT(*) AS n FROM transaction_label GROUP BY origin'
      )
      .all();
    const total =
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM "transaction"').get()?.n ?? 0;

    const fromReview = counts.find((row) => row.origin === 'review')?.n ?? 0;
    const fromCorrection = counts.find((row) => row.origin === 'correction')?.n ?? 0;

    return { labelled: fromReview + fromCorrection, fromReview, fromCorrection, total };
  }
}

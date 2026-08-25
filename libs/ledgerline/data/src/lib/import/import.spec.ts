/**
 * §3.3, exercised.
 *
 * Both idempotency layers, the multiset merge rule and each of the two naive
 * alternatives it exists to reject, the near-duplicate pass and its three-way
 * resolution, refund pairing, last-remaining-source deletion, and the two
 * refusals (mixed key versions, unexplained $0 rows).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { collapseV1 } from '@metrum/ledgerline-domain';
import { dedupeKey } from '@metrum/ledgerline-domain/node';

import { MixedDedupeKeyVersionError, ZeroAmountRowError } from './commit.js';
import type { CommitImportResult, CommitResolution } from './commit.js';
import type { IncomingRow } from './plan.js';
import { fixedClock } from '../clock.js';
import { LedgerlineStore } from '../store.js';

interface RowSpec {
  readonly date: string;
  readonly amountCents: number;
  readonly description: string;
  readonly pending?: boolean;
  readonly merchantId?: string | null;
}

/** A file's bytes stand in for its identity: same name and same rows is the
 *  same file, which is what §3.3's layer one keys on. */
function fileContent(filename: string, rows: readonly RowSpec[]): string {
  return `${filename}\n${rows.map((r) => `${r.date},${r.amountCents},${r.description},${r.pending ?? false}`).join('\n')}`;
}

function openStore(): LedgerlineStore {
  return LedgerlineStore.open({ filename: ':memory:', clock: fixedClock() });
}

interface ImportOptions {
  readonly resolutions?: readonly CommitResolution[];
  readonly allowZeroAmountRows?: boolean;
  readonly commit?: boolean;
}

/** Stage a file, then commit it — the composition root's job, in miniature. */
function importFile(
  store: LedgerlineStore,
  accountId: string,
  filename: string,
  rows: readonly RowSpec[],
  options: ImportOptions = {}
): { importId: string; created: boolean; result: CommitImportResult | null } {
  const content = fileContent(filename, rows);
  const bytes = new TextEncoder().encode(content);

  const staged = store.imports.stage({
    sourceFilename: filename,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    fileBytes: bytes,
    accountId,
    status: 'staged',
    parser: 'test',
    parserVersion: '1.0.0',
    rawRows: rows.map((row, index) => ({
      rowIndex: index,
      rawText: `${row.date},${row.amountCents},${row.description}`,
      parsedJson: JSON.stringify(row),
      parseStatus: 'ok' as const,
      parseSource: 'csv' as const,
    })),
  });

  // Layer one: a byte-identical file is a no-op that returns the existing
  // import. Nothing is re-parsed and nothing is re-committed.
  if (!staged.created) {
    return { importId: staged.import.id, created: false, result: null };
  }

  const rawRows = store.imports.listRawRows(staged.import.id);
  const incoming: IncomingRow[] = rows.map((row, index) => ({
    rowIndex: index,
    rawRowId: rawRows[index].id,
    transactionDate: row.date,
    postedDate: row.date,
    effectiveDate: row.date,
    amountCents: row.amountCents,
    balanceCents: null,
    currency: 'USD',
    descriptionRaw: row.description,
    descriptionNormalized: collapseV1(row.description),
    merchantId: row.merchantId ?? null,
    categoryId: null,
    categorySource: null,
    isPending: row.pending ?? false,
  }));

  if (options.commit === false) {
    return { importId: staged.import.id, created: true, result: null };
  }

  const result = store.commitImport({
    importId: staged.import.id,
    accountId,
    rows: incoming,
    resolutions: options.resolutions,
    allowZeroAmountRows: options.allowZeroAmountRows,
  });

  return { importId: staged.import.id, created: true, result };
}

const JANUARY: readonly RowSpec[] = [
  { date: '2026-01-03', amountCents: -1875, description: 'SQ *BLUE BOTTLE COFFE 415-555-0111 CA' },
  { date: '2026-01-05', amountCents: -1549, description: 'NETFLIX.COM 866-579-7172 CA' },
  { date: '2026-01-12', amountCents: -6499, description: 'AMZN Mktp US*2R4XY1234' },
];

describe('import', () => {
  let store: LedgerlineStore;
  let accountId: string;

  beforeEach(() => {
    store = openStore();
    accountId = store.accounts.create({
      displayName: 'Northgate Checking',
      institution: 'Northgate Bank',
      accountType: 'checking',
      last4: '4821',
    }).id;
  });

  afterEach(() => {
    store.close();
  });

  describe('layer one — file identity', () => {
    it('returns the existing import for a byte-identical file and writes nothing', () => {
      const first = importFile(store, accountId, 'jan.csv', JANUARY);
      expect(first.result?.rowsInserted).toBe(3);

      const second = importFile(store, accountId, 'jan.csv', JANUARY);

      expect(second.created).toBe(false);
      expect(second.importId).toBe(first.importId);
      expect(store.imports.list()).toHaveLength(1);
      expect(store.transactions.countAll()).toBe(3);
    });

    it('makes a re-committed import a no-op rather than a second insert', () => {
      const first = importFile(store, accountId, 'jan.csv', JANUARY);
      const again = store.commitImport({ importId: first.importId, accountId, rows: [] });

      expect(again.alreadyCommitted).toBe(true);
      expect(store.transactions.countAll()).toBe(3);
    });
  });

  describe('layer two — the multiset merge rule', () => {
    it('inserts zero rows when the same rows arrive in a differently-named file', () => {
      importFile(store, accountId, 'jan.csv', JANUARY);
      const reissued = importFile(store, accountId, 'jan-reissued.csv', JANUARY);

      expect(reissued.result?.rowsInserted).toBe(0);
      expect(reissued.result?.rowsDuplicate).toBe(3);
      expect(store.transactions.countAll()).toBe(3);
    });

    it('inserts only the new rows of a strict superset', () => {
      importFile(store, accountId, 'jan.csv', JANUARY);

      const extended = importFile(store, accountId, 'jan-feb.csv', [
        ...JANUARY,
        { date: '2026-02-05', amountCents: -1549, description: 'NETFLIX.COM 866-579-7172 CA' },
      ]);

      expect(extended.result?.rowsInserted).toBe(1);
      expect(extended.result?.rowsDuplicate).toBe(3);
      expect(store.transactions.countAll()).toBe(4);
    });

    it('converges to zero extra inserts across two overlapping exports', () => {
      // §3.3: "Convergence holds for exact re-import, for a strict superset, and
      // for any two overlapping exports."
      const first = JANUARY.slice(0, 2);
      const second = JANUARY.slice(1);

      importFile(store, accountId, 'export-a.csv', first);
      const overlap = importFile(store, accountId, 'export-b.csv', second);

      expect(overlap.result?.rowsInserted).toBe(1);
      expect(store.transactions.countAll()).toBe(3);

      const third = importFile(store, accountId, 'export-c.csv', JANUARY);
      expect(third.result?.rowsInserted).toBe(0);
      expect(store.transactions.countAll()).toBe(3);
    });

    it('keeps both of two genuine identical charges, and still merges on re-import', () => {
      // The row the naive "skip anything whose key exists" rule loses: two
      // coffees at $4.75 on one day are one dedupe key and two transactions.
      const twoCoffees: RowSpec[] = [
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
      ];

      const first = importFile(store, accountId, 'coffee.csv', twoCoffees);
      expect(first.result?.rowsInserted).toBe(2);

      const key = dedupeKey({
        accountId,
        effectiveDate: '2026-01-08',
        amountCents: -475,
        descriptionRaw: 'BLUE BOTTLE COFFEE',
      });
      expect(store.transactions.listByDedupeKey(accountId, key).map((t) => t.occurrenceIndex)).toEqual([
        0, 1,
      ]);

      const again = importFile(store, accountId, 'coffee-reissued.csv', twoCoffees);
      expect(again.result?.rowsInserted).toBe(0);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('inserts the difference when the incoming file has more of one key than the account', () => {
      importFile(store, accountId, 'one-coffee.csv', [
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
      ]);

      const two = importFile(store, accountId, 'two-coffees.csv', [
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
      ]);

      expect(two.result?.rowsInserted).toBe(1);
      expect(two.result?.rowsDuplicate).toBe(1);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('treats the same charge in two months as two keys', () => {
      // Date scoping is what makes a year-to-date export merge cleanly against
      // twelve monthly statements.
      importFile(store, accountId, 'jan.csv', [
        { date: '2026-01-05', amountCents: -999, description: 'SPOTIFY USA' },
      ]);
      const february = importFile(store, accountId, 'feb.csv', [
        { date: '2026-02-05', amountCents: -999, description: 'SPOTIFY USA' },
      ]);

      expect(february.result?.rowsInserted).toBe(1);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('hashes punctuation variants of one descriptor to the same key', () => {
      // The reason `collapse_v1` substitutes rather than deletes (§3.3, §9).
      importFile(store, accountId, 'a.csv', [
        { date: '2026-01-14', amountCents: -1499, description: 'AMAZON - PRIME' },
      ]);
      const variant = importFile(store, accountId, 'b.csv', [
        { date: '2026-01-14', amountCents: -1499, description: 'AMAZON PRIME' },
      ]);

      expect(variant.result?.rowsInserted).toBe(0);
      expect(store.transactions.countAll()).toBe(1);
    });

    it('reuses freed occurrence indexes without colliding after a deletion', () => {
      const first = importFile(store, accountId, 'coffee.csv', [
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
      ]);

      const key = dedupeKey({
        accountId,
        effectiveDate: '2026-01-08',
        amountCents: -475,
        descriptionRaw: 'BLUE BOTTLE COFFEE',
      });
      store.transactions.delete(store.transactions.listByDedupeKey(accountId, key)[0].id);
      expect(first.result?.rowsInserted).toBe(2);

      // One row left, at occurrence_index 1. A count-derived next index would be
      // 1 and would collide; MAX + 1 gives 2.
      const again = importFile(store, accountId, 'coffee-again.csv', [
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
        { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
      ]);

      expect(again.result?.rowsInserted).toBe(1);
      expect(store.transactions.listByDedupeKey(accountId, key).map((t) => t.occurrenceIndex)).toEqual([
        1, 2,
      ]);
    });
  });

  describe('the near-duplicate pass', () => {
    const pendingCharge: RowSpec = {
      date: '2026-01-10',
      amountCents: -5000,
      description: 'TST* THE PLANT CAFE #0042',
      pending: true,
    };
    /** $51.50 against a $50.00 authorization: inside §3.3's ±$2 band. */
    const postedCharge: RowSpec = {
      date: '2026-01-12',
      amountCents: -5150,
      description: 'TST* THE PLANT CAFE #0042',
    };

    it('does not flag two rows that share a dedupe key', () => {
      // Same-key rows are the merge rule's business. Flagging them here would
      // turn two genuine identical charges into a review-screen decision.
      const { importId } = importFile(
        store,
        accountId,
        'coffee.csv',
        [
          { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
          { date: '2026-01-08', amountCents: -475, description: 'BLUE BOTTLE COFFEE' },
        ],
        { commit: false }
      );
      expect(importId).toBeTruthy();

      const plan = store.planImport(accountId, [
        {
          rowIndex: 0,
          rawRowId: store.imports.listRawRows(importId)[0].id,
          transactionDate: '2026-01-08',
          postedDate: '2026-01-08',
          effectiveDate: '2026-01-08',
          amountCents: -475,
          balanceCents: null,
          currency: 'USD',
          descriptionRaw: 'BLUE BOTTLE COFFEE',
          descriptionNormalized: 'BLUE BOTTLE COFFEE',
          merchantId: null,
          categoryId: null,
          categorySource: null,
          isPending: false,
        },
      ]);

      expect(plan.nearDuplicates).toEqual([]);
    });

    it('defaults pending-to-posted to replace, and supersedes the pending row', () => {
      importFile(store, accountId, 'mid-cycle.csv', [pendingCharge]);
      const settled = importFile(store, accountId, 'settled.csv', [postedCharge]);

      expect(settled.result?.rowsReplaced).toBe(1);
      expect(store.transactions.countAll()).toBe(1);

      const [row] = store.transactions.search({ includeInternalTransfers: true }).rows;
      expect(row.transaction.amountCents).toBe(-5150);
      expect(row.transaction.isPending).toBe(false);
      expect(store.tombstones.countFor('transaction')).toBe(1);
    });

    it('carries the superseded row’s sources onto the row that replaced it', () => {
      // Otherwise the replacing import becomes the only source, and deleting it
      // would remove a transaction the earlier statement still covers.
      const original = importFile(store, accountId, 'mid-cycle.csv', [pendingCharge]);
      importFile(store, accountId, 'settled.csv', [postedCharge]);

      const [row] = store.transactions.search({}).rows;
      const covering = store.imports.listImportsForTransaction(row.transaction.id);

      expect(covering.map((i) => i.id)).toContain(original.importId);
      expect(covering).toHaveLength(2);
    });

    it('defaults an amount correction to keep both, so the over-count is visible', () => {
      // §3.3: "over-counting is visible and losing a real transaction is not."
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);
      const corrected = importFile(store, accountId, 'corrected.csv', [
        { date: '2026-01-20', amountCents: -10435, description: 'TRADER JOES 0198' },
      ]);

      expect(corrected.result?.rowsInserted).toBe(1);
      expect(corrected.result?.rowsReplaced).toBe(0);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('surfaces the choice on the plan rather than resolving it', () => {
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);

      const plan = store.planImport(accountId, [
        {
          rowIndex: 0,
          rawRowId: 'raw-x',
          transactionDate: '2026-01-21',
          postedDate: '2026-01-21',
          effectiveDate: '2026-01-21',
          amountCents: -10435,
          balanceCents: null,
          currency: 'USD',
          descriptionRaw: 'TRADER JOES 0198',
          descriptionNormalized: 'TRADER JOES',
          merchantId: null,
          categoryId: null,
          categorySource: null,
          isPending: false,
        },
      ]);

      expect(plan.nearDuplicates).toHaveLength(1);
      expect(plan.nearDuplicates[0]).toMatchObject({
        dayGap: 1,
        amountDeltaCents: 18,
        pendingToPosted: false,
        defaultResolution: 'keep_both',
      });
    });

    it('honours an explicit replace', () => {
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);
      const existingId = store.transactions.search({}).rows[0].transaction.id;

      const corrected = importFile(
        store,
        accountId,
        'corrected.csv',
        [{ date: '2026-01-20', amountCents: -10435, description: 'TRADER JOES 0198' }],
        { resolutions: [{ rowIndex: 0, existingTransactionId: existingId, resolution: 'replace' }] }
      );

      expect(corrected.result?.rowsReplaced).toBe(1);
      expect(store.transactions.countAll()).toBe(1);
      expect(store.transactions.search({}).rows[0].transaction.amountCents).toBe(-10435);
    });

    it('honours an explicit skip and counts it as a duplicate', () => {
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);
      const existingId = store.transactions.search({}).rows[0].transaction.id;

      const corrected = importFile(
        store,
        accountId,
        'corrected.csv',
        [{ date: '2026-01-20', amountCents: -10435, description: 'TRADER JOES 0198' }],
        { resolutions: [{ rowIndex: 0, existingTransactionId: existingId, resolution: 'skip' }] }
      );

      expect(corrected.result?.rowsInserted).toBe(0);
      expect(corrected.result?.rowsSkippedAsNearDuplicate).toBe(1);
      expect(corrected.result?.rowsDuplicate).toBe(1);
      expect(store.transactions.countAll()).toBe(1);
    });

    it('ignores a resolution naming a transaction the recomputed plan no longer sees', () => {
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);

      const stale = importFile(
        store,
        accountId,
        'corrected.csv',
        [{ date: '2026-01-20', amountCents: -10435, description: 'TRADER JOES 0198' }],
        {
          resolutions: [
            { rowIndex: 0, existingTransactionId: 'a-row-from-another-session', resolution: 'replace' },
          ],
        }
      );

      // Falls back to the default rather than deleting a row nobody chose.
      expect(stale.result?.rowsReplaced).toBe(0);
      expect(store.transactions.countAll()).toBe(2);
    });

    // ---------------------------------------------------------------------
    // A gap in §3.3, pinned rather than papered over.
    //
    // That section names "a pending charge that later posts" as one of the three
    // cases the near-duplicate pass exists to cover, and illustrates it with
    // "$50.00 on the 10th becomes $59.00 on the 12th once a tip settles". Its
    // stated predicate — "an amount within ±$2 **or** ±3%" — cannot catch that
    // example: an 18% tip is neither. The predicate is what is implemented,
    // because it is what §3.3 and the build brief both specify verbatim, and
    // widening it is a calibration decision under §7.6 rather than a bug fix.
    //
    // The consequence is bounded and visible in exactly the direction §3.3
    // prefers: the settled charge lands as a second row, so a tipped restaurant
    // meal over-counts until the pending row ages out. Over-counting is visible;
    // losing a real transaction is not.
    it('does not catch a tipped restaurant charge — §3.3’s own example is outside §3.3’s predicate', () => {
      importFile(store, accountId, 'mid-cycle.csv', [pendingCharge]);
      const tipped = importFile(store, accountId, 'settled.csv', [
        { date: '2026-01-12', amountCents: -5900, description: 'TST* THE PLANT CAFE #0042' },
      ]);

      expect(tipped.result?.rowsReplaced).toBe(0);
      expect(tipped.result?.rowsInserted).toBe(1);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('does not match outside the ±3 day window', () => {
      importFile(store, accountId, 'first.csv', [
        { date: '2026-01-20', amountCents: -10453, description: 'TRADER JOES 0198' },
      ]);
      const later = importFile(store, accountId, 'later.csv', [
        { date: '2026-01-24', amountCents: -10435, description: 'TRADER JOES 0198' },
      ]);

      expect(later.result?.rowsInserted).toBe(1);
      expect(store.transactions.countAll()).toBe(2);
    });
  });

  describe('refund pairing', () => {
    let adobeId: string;

    beforeEach(() => {
      adobeId = store.merchants.getOrCreateProvisional('ADOBE CREATIVE').id;
    });

    it('links a debit to its reversal and keeps both rows', () => {
      // §3.3: "A $59.00 debit followed by a $59.00 credit at the same merchant
      // is a reversal, and both rows are real."
      const result = importFile(store, accountId, 'refund.csv', [
        { date: '2026-01-18', amountCents: -5999, description: 'ADOBE *ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-01-25', amountCents: 5999, description: 'ADOBE *ADOBE REFUND', merchantId: adobeId },
      ]);

      expect(result.result?.rowsInserted).toBe(2);
      expect(result.result?.refundPairsLinked).toBe(1);

      const rows = store.transactions.search({ sort: 'date_asc' }).rows.map((r) => r.transaction);
      expect(rows).toHaveLength(2);
      expect(rows[0].refundPairId).not.toBeNull();
      expect(rows[0].refundPairId).toBe(rows[1].refundPairId);
    });

    it('pairs one-to-one — two debits and one credit make one pair', () => {
      const result = importFile(store, accountId, 'refund.csv', [
        { date: '2026-01-18', amountCents: -5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-01-19', amountCents: -5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-01-25', amountCents: 5999, description: 'ADOBE CREATIVE REFUND', merchantId: adobeId },
      ]);

      expect(result.result?.refundPairsLinked).toBe(1);
      const paired = store.transactions
        .search({ sort: 'date_asc' })
        .rows.filter((r) => r.transaction.refundPairId !== null);
      expect(paired).toHaveLength(2);
    });

    it('does not pair across merchants', () => {
      const otherId = store.merchants.getOrCreateProvisional('NETFLIX').id;
      const result = importFile(store, accountId, 'refund.csv', [
        { date: '2026-01-18', amountCents: -5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-01-25', amountCents: 5999, description: 'NETFLIX REFUND', merchantId: otherId },
      ]);

      expect(result.result?.refundPairsLinked).toBe(0);
    });

    it('does not pair a credit that precedes its debit', () => {
      const result = importFile(store, accountId, 'refund.csv', [
        { date: '2026-01-25', amountCents: 5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-02-20', amountCents: -5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
      ]);

      expect(result.result?.refundPairsLinked).toBe(0);
    });

    it('does not pair beyond the 90-day window', () => {
      const result = importFile(store, accountId, 'refund.csv', [
        { date: '2026-01-18', amountCents: -5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
        { date: '2026-06-01', amountCents: 5999, description: 'ADOBE CREATIVE', merchantId: adobeId },
      ]);

      expect(result.result?.refundPairsLinked).toBe(0);
    });
  });

  describe('import deletion', () => {
    it('removes only the transactions this import is the last source for', () => {
      // §3.3: "Deleting the first of two overlapping imports must not delete
      // rows the second one legitimately contains."
      const first = importFile(store, accountId, 'export-a.csv', JANUARY.slice(0, 2));
      importFile(store, accountId, 'export-b.csv', JANUARY.slice(1));

      expect(store.transactions.countAll()).toBe(3);

      const deletion = store.imports.delete(first.importId);

      expect(deletion.deletedTransactionIds).toHaveLength(1);
      expect(deletion.retainedTransactionIds).toHaveLength(1);
      expect(store.transactions.countAll()).toBe(2);
    });

    it('re-points a retained row’s verbatim line onto a surviving import', () => {
      const first = importFile(store, accountId, 'export-a.csv', JANUARY.slice(0, 2));
      importFile(store, accountId, 'export-b.csv', JANUARY.slice(1));

      const shared = store.transactions.search({ text: 'NETFLIX' }).rows[0].transaction;
      const rawRowBefore = shared.rawRowId;

      store.imports.delete(first.importId);

      const after = store.transactions.getOrThrow(shared.id);
      expect(after.rawRowId).not.toBeNull();
      expect(after.rawRowId).not.toBe(rawRowBefore);
    });

    it('writes tombstones for everything it removed', () => {
      const first = importFile(store, accountId, 'export-a.csv', JANUARY.slice(0, 2));
      importFile(store, accountId, 'export-b.csv', JANUARY.slice(1));

      store.imports.delete(first.importId);

      const tombstoned = store.tombstones.listSince('2000-01-01T00:00:00.000Z');
      expect(tombstoned.filter((t) => t.entityType === 'transaction')).toHaveLength(1);
      expect(tombstoned.filter((t) => t.entityType === 'statement_import')).toHaveLength(1);
      expect(tombstoned.filter((t) => t.entityType === 'raw_row')).toHaveLength(2);
    });

    it('lets the same file be re-imported after its import is deleted', () => {
      const first = importFile(store, accountId, 'jan.csv', JANUARY);
      store.imports.delete(first.importId);

      expect(store.transactions.countAll()).toBe(0);

      const again = importFile(store, accountId, 'jan.csv', JANUARY);
      expect(again.created).toBe(true);
      expect(again.result?.rowsInserted).toBe(3);
    });
  });

  describe('refusals', () => {
    it('refuses to import while the table holds mixed dedupe_key_version values', () => {
      importFile(store, accountId, 'jan.csv', JANUARY);

      store.db
        .prepare(`UPDATE "transaction" SET dedupe_key_version = 'collapse_v2' WHERE occurrence_index = 0 LIMIT 1`)
        .run();

      expect(() => importFile(store, accountId, 'feb.csv', JANUARY)).toThrow(
        MixedDedupeKeyVersionError
      );
    });

    it('refuses an unexplained $0 row, and names the rows', () => {
      expect(() =>
        importFile(store, accountId, 'trial.csv', [
          { date: '2026-01-22', amountCents: 0, description: 'TRIAL PERIOD HULU' },
        ])
      ).toThrow(ZeroAmountRowError);

      expect(store.transactions.countAll()).toBe(0);
    });

    it('stores a $0 row when the reviewer allows it, flagged as a trial authorization', () => {
      const result = importFile(
        store,
        accountId,
        'trial.csv',
        [{ date: '2026-01-22', amountCents: 0, description: 'TRIAL PERIOD HULU' }],
        { allowZeroAmountRows: true }
      );

      expect(result.result?.rowsInserted).toBe(1);
      expect(store.transactions.search({}).rows[0].transaction.allowsZeroAmount).toBe(true);
    });

    it('stores a pending $0 row without an explicit allowance', () => {
      const result = importFile(store, accountId, 'trial.csv', [
        { date: '2026-01-22', amountCents: 0, description: 'TRIAL PERIOD HULU', pending: true },
      ]);

      expect(result.result?.rowsInserted).toBe(1);
    });

    it('leaves nothing behind when a commit fails partway', () => {
      // §2.5: "Transactional commit of the whole import. Partial imports never
      // land." The second row violates the currency trigger.
      const { importId } = importFile(store, accountId, 'bad.csv', JANUARY, { commit: false });
      const rawRows = store.imports.listRawRows(importId);

      const rows: IncomingRow[] = JANUARY.map((row, index) => ({
        rowIndex: index,
        rawRowId: rawRows[index].id,
        transactionDate: row.date,
        postedDate: row.date,
        effectiveDate: row.date,
        amountCents: row.amountCents,
        balanceCents: null,
        currency: index === 1 ? ('EUR' as 'USD') : 'USD',
        descriptionRaw: row.description,
        descriptionNormalized: collapseV1(row.description),
        merchantId: null,
        categoryId: null,
        categorySource: null,
        isPending: false,
      }));

      expect(() => store.commitImport({ importId, accountId, rows })).toThrow(/currency/);
      expect(store.transactions.countAll()).toBe(0);
      expect(store.imports.getOrThrow(importId).status).toBe('staged');
    });
  });
});

/**
 * The commit — §2.5's `dedupe → store` stages, in one transaction.
 *
 * "Transactional commit of the whole import. Partial imports never land." That
 * is the reason everything below happens inside a single `db.transaction`,
 * including the refund pairing and the supersession of replaced rows: a commit
 * that inserted rows and then failed to link them would leave a month of spend
 * that looks right and reconciles against nothing.
 *
 * Three guards run before any write, because each of them describes a database
 * that must not be written to at all rather than a row that must be skipped.
 */

import { DEDUPE_KEY_VERSION } from '@metrum/ledgerline-domain';

import { planImport } from './plan.js';
import type { ImportPlan, IncomingRow, NearDuplicateResolution } from './plan.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import type { ImportRepository } from '../repositories/imports.js';
import type { TransactionRepository } from '../repositories/transactions.js';

/** §3.3: "credit within 90 days of the debit". */
export const REFUND_WINDOW_DAYS = 90;

/**
 * §3.3: "Imports refuse to run while the table contains mixed
 * `dedupe_key_version` values."
 *
 * The refusal is the whole safety mechanism for a future `collapse_v2`. Half the
 * table keyed one way and half the other means the merge rule compares counts
 * across two different notions of identity, and every overlapping import after
 * that silently re-inserts rows it should have absorbed.
 */
export class MixedDedupeKeyVersionError extends Error {
  constructor(readonly versions: readonly string[]) {
    super(
      `refusing to import: transaction holds mixed dedupe_key_version values (${versions.join(', ')}). ` +
        `Recompute every key in one migration before importing again (spec 3.3).`
    );
    this.name = 'MixedDedupeKeyVersionError';
  }
}

/**
 * §3.2: "A zero-amount row is a parse failure, not a transaction — except for
 * trial authorizations (§5.6), which are stored with `is_pending` or an explicit
 * `$0` allowance flag."
 *
 * The allowance is a reviewer decision carried on the commit request, never
 * inferred: a $0 row is far more often a misparsed amount column than a trial,
 * and §2.5 warns that a misparsed amount column "poisons every downstream
 * finding, and it is very hard to notice after the fact."
 */
export class ZeroAmountRowError extends Error {
  constructor(readonly rowIndexes: readonly number[]) {
    super(
      `refusing to import: ${rowIndexes.length} row(s) parsed to $0.00 and are not pending ` +
        `(rows ${rowIndexes.join(', ')}). Set allowZeroAmountRows to store them as trial ` +
        `authorizations, or fix the column mapping (spec 3.2).`
    );
    this.name = 'ZeroAmountRowError';
  }
}

export class ImportNotCommittableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportNotCommittableError';
  }
}

export interface CommitResolution {
  readonly rowIndex: number;
  readonly existingTransactionId: string;
  readonly resolution: NearDuplicateResolution;
}

export interface CommitImportInput {
  readonly importId: string;
  readonly accountId: string;
  readonly rows: readonly IncomingRow[];
  /** Per-row near-duplicate decisions from the review screen (§2.3). Anything
   *  unresolved takes the plan's default. */
  readonly resolutions?: readonly CommitResolution[];
  readonly allowZeroAmountRows?: boolean;
  readonly refundWindowDays?: number;
}

export interface CommitImportResult {
  readonly importId: string;
  readonly rowsParsed: number;
  readonly rowsInserted: number;
  /** What the review screen shows as "18 of 52 rows already present" (§3.3):
   *  merge-rule absorptions plus near-duplicates the reviewer chose to skip. */
  readonly rowsDuplicate: number;
  readonly rowsMerged: number;
  readonly rowsSkippedAsNearDuplicate: number;
  readonly rowsReplaced: number;
  readonly refundPairsLinked: number;
  readonly insertedTransactionIds: readonly string[];
  /** True when this import was already committed; the numbers are the ones the
   *  first commit produced. `POST /api/imports/:id/commit` is idempotent (§2.3). */
  readonly alreadyCommitted: boolean;
}

export interface CommitDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly imports: ImportRepository;
  readonly transactions: TransactionRepository;
}

export function commitImport(deps: CommitDeps, input: CommitImportInput): CommitImportResult {
  const record = deps.imports.getOrThrow(input.importId);

  if (record.status === 'committed') {
    return {
      importId: record.id,
      rowsParsed: record.rowsParsed,
      rowsInserted: record.rowsInserted,
      rowsDuplicate: record.rowsDuplicate,
      rowsMerged: record.rowsDuplicate,
      rowsSkippedAsNearDuplicate: 0,
      rowsReplaced: 0,
      refundPairsLinked: 0,
      insertedTransactionIds: [],
      alreadyCommitted: true,
    };
  }

  const versions = deps.transactions.distinctDedupeKeyVersions();
  if (versions.length > 1) throw new MixedDedupeKeyVersionError(versions);
  if (versions.length === 1 && versions[0] !== DEDUPE_KEY_VERSION) {
    throw new MixedDedupeKeyVersionError([...versions, DEDUPE_KEY_VERSION]);
  }

  if (!input.allowZeroAmountRows) {
    const zeroRows = input.rows.filter((row) => row.amountCents === 0 && !row.isPending);
    if (zeroRows.length > 0) {
      throw new ZeroAmountRowError(zeroRows.map((row) => row.rowIndex));
    }
  }

  return deps.db.transaction((): CommitImportResult => {
    const plan = planImport(deps.transactions, input.accountId, input.rows);
    const rowsByIndex = new Map(input.rows.map((row) => [row.rowIndex, row]));

    const resolutions = resolveNearDuplicates(plan, input.resolutions ?? []);
    const insertedTransactionIds: string[] = [];
    const supersededIds = new Set<string>();
    let rowsSkippedAsNearDuplicate = 0;
    let rowsReplaced = 0;

    for (const planned of plan.inserts) {
      const row = rowsByIndex.get(planned.rowIndex);
      if (!row) continue;

      const decision = resolutions.get(planned.rowIndex);

      if (decision?.resolution === 'skip') {
        rowsSkippedAsNearDuplicate += 1;
        continue;
      }

      const inserted = deps.transactions.insert({
        accountId: input.accountId,
        rawRowId: row.rawRowId,
        postedDate: row.postedDate,
        transactionDate: row.transactionDate,
        effectiveDate: row.effectiveDate,
        amountCents: row.amountCents,
        balanceCents: row.balanceCents,
        currency: row.currency,
        descriptionRaw: row.descriptionRaw,
        descriptionNormalized: row.descriptionNormalized,
        merchantId: row.merchantId,
        isPending: row.isPending,
        allowsZeroAmount: row.amountCents === 0 && !row.isPending,
        dedupeKey: planned.dedupeKey,
        dedupeKeyVersion: DEDUPE_KEY_VERSION,
        occurrenceIndex: planned.occurrenceIndex,
      });

      insertedTransactionIds.push(inserted.id);
      deps.imports.linkSource(inserted.id, input.importId, row.rawRowId);

      // §2.5: "When a later import produces a posted row that matches a pending
      // one, the pending row is superseded rather than kept." The superseded
      // row's sources move first — the statements that carried the pending
      // charge still cover the posted transaction it became.
      if (decision?.resolution === 'replace' && !supersededIds.has(decision.existingTransactionId)) {
        deps.imports.moveSources(decision.existingTransactionId, inserted.id);
        deps.transactions.delete(decision.existingTransactionId);
        supersededIds.add(decision.existingTransactionId);
        rowsReplaced += 1;
      }
    }

    // The merge rule's absorbed rows. This import covers them too, and recording
    // that is what makes §3.3's last-remaining-source deletion correct.
    for (const merge of plan.merged) {
      const row = rowsByIndex.get(merge.rowIndex);
      deps.imports.linkSource(merge.existingTransactionId, input.importId, row?.rawRowId ?? null);
    }

    const refundPairsLinked = linkRefunds(
      deps,
      input.accountId,
      insertedTransactionIds,
      input.refundWindowDays ?? REFUND_WINDOW_DAYS
    );

    const rowsInserted = insertedTransactionIds.length;
    const rowsDuplicate = plan.merged.length + rowsSkippedAsNearDuplicate;

    deps.imports.update(input.importId, {
      accountId: input.accountId,
      status: 'committed',
      rowsParsed: plan.rowsParsed,
      rowsInserted,
      rowsDuplicate,
      importedAt: deps.clock.now(),
    });

    return {
      importId: input.importId,
      rowsParsed: plan.rowsParsed,
      rowsInserted,
      rowsDuplicate,
      rowsMerged: plan.merged.length,
      rowsSkippedAsNearDuplicate,
      rowsReplaced,
      refundPairsLinked,
      insertedTransactionIds,
      alreadyCommitted: false,
    };
  })();
}

interface ResolvedNearDuplicate {
  readonly existingTransactionId: string;
  readonly resolution: NearDuplicateResolution;
}

/**
 * Apply the reviewer's choices over the plan's defaults.
 *
 * A resolution naming a row or an existing transaction the recomputed plan no
 * longer sees is dropped rather than honoured. The store can change between the
 * review screen and the commit, and acting on a stale instruction to *replace* a
 * row that is no longer the near-duplicate would delete a transaction nobody
 * chose to delete.
 */
function resolveNearDuplicates(
  plan: ImportPlan,
  requested: readonly CommitResolution[]
): Map<number, ResolvedNearDuplicate> {
  const requestedByRow = new Map(requested.map((choice) => [choice.rowIndex, choice]));
  const resolved = new Map<number, ResolvedNearDuplicate>();

  for (const candidate of plan.nearDuplicates) {
    const choice = requestedByRow.get(candidate.rowIndex);
    const honoured =
      choice && choice.existingTransactionId === candidate.existingTransactionId
        ? choice.resolution
        : candidate.defaultResolution;

    resolved.set(candidate.rowIndex, {
      existingTransactionId: candidate.existingTransactionId,
      resolution: honoured,
    });
  }

  return resolved;
}

/**
 * §3.3's refund pairing: "A $59.00 debit followed by a $59.00 credit at the same
 * merchant is a reversal, and both rows are real."
 *
 * Both rows stay; they are linked by a shared `refund_pair_id` so every analyzer
 * can net them out — "a refunded charge is not spend, not an outlier, and not an
 * occurrence in a recurring series." This is a different relation from
 * `transfer_pair_id`, which is cross-account (§2.6).
 *
 * One-to-one, and greedy by nearest date within the window: two $59 charges at
 * one merchant followed by one $59 credit must produce one pair, not two.
 */
function linkRefunds(
  deps: CommitDeps,
  accountId: string,
  insertedTransactionIds: readonly string[],
  windowDays: number
): number {
  const paired = new Set<string>();
  let linked = 0;

  for (const id of insertedTransactionIds) {
    if (paired.has(id)) continue;

    const row = deps.transactions.get(id);
    if (!row || row.merchantId === null || row.isPending || row.refundPairId !== null) continue;
    if (row.amountCents === 0) continue;

    const counterpart = deps.transactions.findRefundCounterpart({
      accountId,
      merchantId: row.merchantId,
      amountCents: row.amountCents,
      effectiveDate: row.effectiveDate,
      excludeTransactionId: row.id,
      windowDays,
    });
    if (!counterpart || paired.has(counterpart.id)) continue;

    const debitId = row.amountCents < 0 ? row.id : counterpart.id;
    const creditId = row.amountCents < 0 ? counterpart.id : row.id;

    deps.transactions.linkRefundPair(debitId, creditId, deps.clock.newId());
    paired.add(row.id);
    paired.add(counterpart.id);
    linked += 1;
  }

  return linked;
}

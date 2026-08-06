/**
 * The import plan — §3.3's merge rule and near-duplicate pass, as a pure
 * decision over the current contents of the store.
 *
 * Planning is separated from committing because §2.5 requires the review screen
 * to show "parsed rows, flagged duplicates, near-duplicates, and any warnings
 * *before* anything enters the transaction table", and §6.1 requires the
 * near-duplicate choice to be made against the rows it will actually be applied
 * to. `GET /api/imports/:id` and `POST /api/imports/:id/commit` therefore call
 * the same function; the commit recomputes rather than trusting a plan the
 * client round-tripped, because the store can change in between.
 */

import { collapseV1, dedupeKey, daysBetweenIso } from '@metrum/ledgerline-domain';
import type { Currency } from '@metrum/ledgerline-domain';

import type { TransactionRepository } from '../repositories/transactions.js';
import type { TransactionRecord } from '../records.js';

/**
 * One parsed row, already normalized by the composition root.
 *
 * `descriptionNormalized` and `merchantId` come from the §4 chain, which `data`
 * may not reach (§2.2). `descriptionRaw` is the verbatim descriptor and is what
 * the frozen `collapse_v1` is applied to — never the normalized form. §3.3 is
 * explicit that keying off the growing §4 chain would "silently double a month
 * of spend" the next time the prefix table grows.
 */
export interface IncomingRow {
  readonly rowIndex: number;
  readonly rawRowId: string;
  readonly transactionDate: string | null;
  readonly postedDate: string | null;
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly balanceCents: number | null;
  readonly currency: Currency;
  readonly descriptionRaw: string;
  readonly descriptionNormalized: string;
  readonly merchantId: string | null;
  readonly isPending: boolean;
}

/** §3.3: "*replace the existing row · keep both · skip this row*". */
export type NearDuplicateResolution = 'replace' | 'keep_both' | 'skip';

export interface PlannedInsert {
  readonly rowIndex: number;
  readonly dedupeKey: string;
  readonly occurrenceIndex: number;
}

/** A row the merge rule absorbed: the account already holds it. */
export interface PlannedMerge {
  readonly rowIndex: number;
  readonly dedupeKey: string;
  /** The row it merges into, so the import is recorded as one of its sources. */
  readonly existingTransactionId: string;
}

export interface NearDuplicate {
  readonly rowIndex: number;
  readonly existingTransactionId: string;
  readonly existing: TransactionRecord;
  readonly dayGap: number;
  readonly amountDeltaCents: number;
  /** The one case §3.3 defaults to *replace*. */
  readonly pendingToPosted: boolean;
  readonly defaultResolution: NearDuplicateResolution;
}

export interface ImportPlan {
  readonly accountId: string;
  readonly rowsParsed: number;
  readonly inserts: readonly PlannedInsert[];
  readonly merged: readonly PlannedMerge[];
  readonly nearDuplicates: readonly NearDuplicate[];
  /** Keyed by `rowIndex`. */
  readonly dedupeKeys: ReadonlyMap<number, string>;
}

export function planImport(
  transactions: TransactionRepository,
  accountId: string,
  rows: readonly IncomingRow[]
): ImportPlan {
  const keys = new Map<number, string>();
  const byKey = new Map<string, IncomingRow[]>();

  for (const row of rows) {
    const key = dedupeKey({
      accountId,
      effectiveDate: row.effectiveDate,
      amountCents: row.amountCents,
      descriptionRaw: row.descriptionRaw,
    });
    keys.set(row.rowIndex, key);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const existingCounts = transactions.countByDedupeKey(accountId, [...byKey.keys()]);

  const inserts: PlannedInsert[] = [];
  const merged: PlannedMerge[] = [];

  for (const [key, incoming] of byKey) {
    const existingCount = existingCounts.get(key) ?? 0;

    // §3.3's multiset merge rule: insert
    // `max(0, count_in_incoming_file − count_already_in_account)`.
    //
    // Neither naive alternative is available. Skipping every row whose key
    // exists loses the second of two genuine identical charges — two coffees on
    // one day are one key and two real transactions. Inserting everything
    // double-counts the overlap between two statements that both cover a month.
    const absorbed = Math.min(existingCount, incoming.length);
    const existingRows = absorbed > 0 ? transactions.listByDedupeKey(accountId, key) : [];

    // Which incoming rows are absorbed is arbitrary — they are identical under
    // the key by construction. Taking the earliest in file order keeps the
    // pairing with the existing occurrences stable and reproducible.
    for (let i = 0; i < absorbed; i += 1) {
      merged.push({
        rowIndex: incoming[i].rowIndex,
        dedupeKey: key,
        existingTransactionId: existingRows[i].id,
      });
    }

    let occurrenceIndex = transactions.nextOccurrenceIndex(accountId, key);
    for (let i = absorbed; i < incoming.length; i += 1) {
      inserts.push({ rowIndex: incoming[i].rowIndex, dedupeKey: key, occurrenceIndex });
      occurrenceIndex += 1;
    }
  }

  inserts.sort((a, b) => a.rowIndex - b.rowIndex);
  merged.sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    accountId,
    rowsParsed: rows.length,
    inserts,
    merged,
    nearDuplicates: findNearDuplicates(transactions, accountId, rows, inserts, keys),
    dedupeKeys: keys,
  };
}

/**
 * §3.3's near-duplicate pass, which "runs **after** the merge".
 *
 * The merge rule can only see rows that hash the same. Three real cases produce
 * rows with *different* keys that are nonetheless the same transaction: a
 * statement re-issued with a corrected amount, a pending charge that later posts
 * at a different date and amount, and the same month exported in two formats
 * where `effective_date` differs by a day. No count comparison will ever see
 * them.
 *
 * Nothing here is resolved automatically. Each match becomes an explicit
 * three-way choice on the review screen, with a default: pending-to-posted
 * defaults to *replace*, everything else to *keep both*, "because over-counting
 * is visible and losing a real transaction is not."
 */
function findNearDuplicates(
  transactions: TransactionRepository,
  accountId: string,
  rows: readonly IncomingRow[],
  inserts: readonly PlannedInsert[],
  keys: ReadonlyMap<number, string>
): NearDuplicate[] {
  const byIndex = new Map(rows.map((row) => [row.rowIndex, row]));
  const claimed = new Set<string>();
  const found: NearDuplicate[] = [];

  for (const planned of inserts) {
    const row = byIndex.get(planned.rowIndex);
    if (!row) continue;

    const candidates = transactions.findNearDuplicateCandidates({
      accountId,
      effectiveDate: row.effectiveDate,
      amountCents: row.amountCents,
      dedupeKey: keys.get(row.rowIndex) as string,
      excludeTransactionIds: [...claimed],
    });

    // The descriptor test is the frozen collapse, applied to the *raw*
    // descriptor on both sides. Doing it here rather than in SQL keeps
    // `collapse_v1` in the one file that is allowed to define it.
    const collapsed = collapseV1(row.descriptionRaw);
    const match = candidates.find((candidate) => collapseV1(candidate.descriptionRaw) === collapsed);
    if (!match) continue;

    claimed.add(match.id);

    const pendingToPosted = match.isPending && !row.isPending;
    found.push({
      rowIndex: row.rowIndex,
      existingTransactionId: match.id,
      existing: match,
      dayGap: daysBetweenIso(match.effectiveDate, row.effectiveDate),
      amountDeltaCents: row.amountCents - match.amountCents,
      pendingToPosted,
      defaultResolution: pendingToPosted ? 'replace' : 'keep_both',
    });
  }

  return found;
}

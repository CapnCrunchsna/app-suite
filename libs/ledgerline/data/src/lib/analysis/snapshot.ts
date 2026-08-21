/**
 * The one snapshot a run reads (§2.2), loaded from the store.
 *
 * §2.2 makes "**one snapshot per run, not one per analyzer**" a condition of the
 * whole pure-function design — "nine independent loads would be nine times the
 * query cost and nine times the peak memory" — and that condition is this file's
 * to keep. Four queries, no per-rule reload, and the row count the caller feeds
 * into `analysis_run`.
 *
 * ## Why the shape is restated rather than imported
 *
 * `type:data-access` may depend on `type:domain` and nothing else (§2.2), so this
 * lib cannot import `@metrum/ledgerline-analyzers` — and the analyzers cannot
 * import this one. The two shapes meet structurally in `apps/ledgerline-api`,
 * which is the composition root and the only place they are allowed to (§2.1:
 * "libs compute; the app persists"). That is the same arrangement `data` already
 * has with the parser's format profile, and it is a boundary doing its job rather
 * than a duplication to remove: `analyzers/src/lib/snapshot.ts` documents at
 * length that what analysis reads is a *strict subset* of what the table stores,
 * and this file is the projection that produces exactly that subset.
 *
 * ## Coverage is statement periods, never transaction dates
 *
 * §7.2: a month is covered when a committed import's `[period_start, period_end]`
 * spans it. An account can be covered for March and legitimately contain no March
 * rows — the statement arrived and nothing was spent — and every liveness and
 * lapse test in §5.2 and §5.7 measures against coverage end. Deriving the periods
 * from `MIN`/`MAX(effective_date)` would turn "we have the statement and you spent
 * nothing" into "we have no statement", which reads a quiet month as a lapsed
 * subscription.
 */

import type { AccountType, Currency } from '@metrum/ledgerline-domain';

import type { Database } from '../database.js';

/** One committed import's span (§7.2). Both ends inclusive. */
export interface SnapshotCoveragePeriod {
  readonly start: string;
  readonly end: string;
}

export interface SnapshotAccount {
  readonly id: string;
  readonly displayName: string;
  readonly institution: string | null;
  readonly accountType: AccountType;
  readonly last4: string | null;
  readonly currency: Currency;
  readonly isActive: boolean;
  /** Unordered and possibly overlapping — statements overlap by design (§3.3). */
  readonly coverage: readonly SnapshotCoveragePeriod[];
}

/**
 * A transaction as analysis sees it.
 *
 * `effective_date` only. §7.1 makes it the single date every analyzer, aggregate
 * and cadence calculation uses; `posted_date` is display-only and is absent from
 * this type so no rule can reach for it by accident.
 */
export interface SnapshotTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly descriptionNormalized: string;
  /** The verbatim statement line. Carried for §2.6's `last4` signal alone —
   *  §4.1's stage 3 strips masked account numbers, so the normalized column
   *  cannot answer "does this descriptor name the other account". */
  readonly descriptionRaw: string;
  readonly merchantId: string | null;
  readonly categoryId: string | null;
  readonly isPending: boolean;
  readonly isInternalTransfer: boolean;
  readonly isExcluded: boolean;
  readonly refundPairId: string | null;
  readonly transferPairId: string | null;
}

export interface SnapshotMerchant {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly isKnownSubscription: boolean;
  readonly isTransferKind: boolean;
  readonly overlapGroup: string | null;
}

export interface SnapshotCategory {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: 'spend' | 'fee' | 'transfer' | 'income';
  readonly overlapGroup: string | null;
}

export interface Snapshot {
  readonly accounts: readonly SnapshotAccount[];
  readonly transactions: readonly SnapshotTransaction[];
  readonly merchants: readonly SnapshotMerchant[];
  readonly categories: readonly SnapshotCategory[];
}

interface AccountRow {
  id: string;
  display_name: string;
  institution: string | null;
  account_type: AccountType;
  last4: string | null;
  currency: Currency;
  is_active: number;
}

interface CoverageRow {
  account_id: string;
  period_start: string;
  period_end: string;
}

interface TransactionRow {
  id: string;
  account_id: string;
  effective_date: string;
  amount_cents: number;
  description_raw: string;
  description_normalized: string;
  merchant_id: string | null;
  category_id: string | null;
  is_pending: number;
  is_internal_transfer: number;
  is_excluded: number;
  refund_pair_id: string | null;
  transfer_pair_id: string | null;
}

interface MerchantRow {
  id: string;
  canonical_name: string;
  display_name: string;
  is_known_subscription: number;
  is_transfer_kind: number;
  overlap_group: string | null;
}

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  kind: SnapshotCategory['kind'];
  overlap_group: string | null;
}

const bool = (value: number): boolean => value === 1;

export function buildSnapshot(db: Database): Snapshot {
  return {
    accounts: loadAccounts(db),
    transactions: loadTransactions(db),
    merchants: loadMerchants(db),
    categories: loadCategories(db),
  };
}

/**
 * Every account, active or not, with the periods its committed imports cover.
 *
 * Archived accounts are included deliberately. §6.2 makes archiving
 * `isActive = false` rather than a deletion, and a subscription that was still
 * billing when the account was closed is exactly the finding worth keeping —
 * dropping the account here would silently drop its history from every rule.
 */
function loadAccounts(db: Database): SnapshotAccount[] {
  const coverage = new Map<string, SnapshotCoveragePeriod[]>();

  // `status = 'committed'` is the whole of §7.2's "a committed import": a staged
  // file has been parsed and reviewed but has put no rows in `transaction`, so
  // counting its period as covered would claim coverage for a month whose
  // statement was never accepted.
  const periods = db
    .prepare<[], CoverageRow>(
      `SELECT account_id, period_start, period_end
         FROM statement_import
        WHERE status = 'committed'
          AND account_id IS NOT NULL
          AND period_start IS NOT NULL
          AND period_end IS NOT NULL
        ORDER BY account_id, period_start`,
    )
    .all();

  for (const period of periods) {
    const existing = coverage.get(period.account_id) ?? [];
    existing.push({ start: period.period_start, end: period.period_end });
    coverage.set(period.account_id, existing);
  }

  return db
    .prepare<[], AccountRow>(
      `SELECT id, display_name, institution, account_type, last4, currency, is_active
         FROM account
        ORDER BY display_name`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      displayName: row.display_name,
      institution: row.institution,
      accountType: row.account_type,
      last4: row.last4,
      currency: row.currency,
      isActive: bool(row.is_active),
      coverage: coverage.get(row.id) ?? [],
    }));
}

/**
 * Every row, with the flags the rules filter on rather than a filter applied
 * here.
 *
 * §5.2 wants non-pending non-transfer non-refunded debits; §5.9 wants credits
 * too; §5.11 wants the small ones §5.2 discards. Deciding for them in the loader
 * would put an eligibility rule in `data`, where §7.4's config cannot reach it
 * and no analyzer test would see it. `is_pending`, `is_internal_transfer`,
 * `is_excluded`, `refund_pair_id` and `transfer_pair_id` are on the projection
 * precisely so the rules can do it themselves.
 *
 * Ordered by `(account_id, effective_date)`, which is §3.2's index for exactly
 * this load path.
 */
function loadTransactions(db: Database): SnapshotTransaction[] {
  return db
    .prepare<[], TransactionRow>(
      `SELECT id, account_id, effective_date, amount_cents, description_raw, description_normalized,
              merchant_id, category_id, is_pending, is_internal_transfer, is_excluded,
              refund_pair_id, transfer_pair_id
         FROM "transaction"
        ORDER BY account_id, effective_date, id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      accountId: row.account_id,
      effectiveDate: row.effective_date,
      amountCents: row.amount_cents,
      descriptionRaw: row.description_raw,
      descriptionNormalized: row.description_normalized,
      merchantId: row.merchant_id,
      categoryId: row.category_id,
      isPending: bool(row.is_pending),
      isInternalTransfer: bool(row.is_internal_transfer),
      isExcluded: bool(row.is_excluded),
      refundPairId: row.refund_pair_id,
      transferPairId: row.transfer_pair_id,
    }));
}

function loadMerchants(db: Database): SnapshotMerchant[] {
  return db
    .prepare<[], MerchantRow>(
      `SELECT id, canonical_name, display_name, is_known_subscription, is_transfer_kind, overlap_group
         FROM merchant_canonical
        ORDER BY canonical_name`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      displayName: row.display_name,
      isKnownSubscription: bool(row.is_known_subscription),
      isTransferKind: bool(row.is_transfer_kind),
      overlapGroup: row.overlap_group,
    }));
}

function loadCategories(db: Database): SnapshotCategory[] {
  return db
    .prepare<[], CategoryRow>(
      `SELECT id, name, parent_id, kind, overlap_group FROM category ORDER BY name`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      kind: row.kind,
      overlapGroup: row.overlap_group,
    }));
}

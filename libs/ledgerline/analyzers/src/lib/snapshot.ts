/**
 * The frozen input every rule in §5 reads.
 *
 * §2.2: "Analyzers as pure functions over a full snapshot." A heavy household is
 * six accounts × 120 months × ~80 transactions ≈ 58,000 transactions, roughly
 * 60 MB of JavaScript objects — which fits in memory with two orders of magnitude
 * to spare, and in exchange every rule is unit-testable with a literal array and
 * zero database fixtures. Two conditions from that section make the claim hold and
 * are the caller's job, not this file's: **one snapshot per run, not one per
 * analyzer**, and the row-count guard on `analysis_run`.
 *
 * ## Why these types are restated rather than imported
 *
 * `type:analyzers` may depend on `type:domain` and nothing else (§2.2), so the
 * `transaction` row shape in `data` is out of reach — and that is the right
 * outcome rather than a limitation to work around. What analysis reads is a
 * strict subset of what the table stores: no `dedupe_key`, no `raw_row_id`, no
 * `occurrence_index`, no timestamps. Naming that subset here makes the contract
 * "these are the columns a finding may depend on" checkable by the compiler, and
 * it is the same reasoning `data` uses when it restates the format profile rather
 * than importing it.
 *
 * ## Coverage is part of the snapshot, not derived from the transactions
 *
 * §7.2 defines a month as covered when a committed import's
 * `[period_start, period_end]` spans it — a fact about *statements*, not about
 * rows. An account can be covered for March and legitimately contain no March
 * transactions, and the difference matters in both directions: §5.10 and §5.11
 * refuse to compute over partial months, and every liveness test in §5.2 and §5.7
 * measures against the account's coverage end rather than the dataset maximum or
 * the wall clock. Deriving coverage from transaction dates would quietly turn "we
 * have the statement and you spent nothing" into "we have no statement".
 */

import type { AccountType, Currency } from '@metrum/ledgerline-domain';

/** One committed import's span, per §7.2. Both ends inclusive. */
export interface CoveragePeriod {
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
  /** Every committed import's `[period_start, period_end]` for this account.
   *  Unordered and possibly overlapping — statements overlap by design (§3.3). */
  readonly coverage: readonly CoveragePeriod[];
}

/**
 * A transaction as analysis sees it.
 *
 * `effectiveDate` only: §7.1 makes it the single date every analyzer, aggregate
 * and cadence calculation uses, and `posted_date` is display-only. It is not on
 * this type at all, so no rule can reach for it by accident.
 */
export interface SnapshotTransaction {
  readonly id: string;
  readonly accountId: string;
  /** ISO `YYYY-MM-DD`. Negative cents mean money leaving the account (§3.1). */
  readonly effectiveDate: string;
  readonly amountCents: number;
  readonly descriptionNormalized: string;
  readonly merchantId: string | null;
  readonly categoryId: string | null;
  readonly isPending: boolean;
  readonly isInternalTransfer: boolean;
  readonly isExcluded: boolean;
  /** Set when §3.3's commit pass linked this row to its reversal. A refunded
   *  charge is not spend, not an outlier, and not a series occurrence. */
  readonly refundPairId: string | null;
  readonly transferPairId: string | null;
}

export interface SnapshotMerchant {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly isKnownSubscription: boolean;
  readonly isTransferKind: boolean;
  /** §5.4's category-overlap rule. Curated seed data; `Restaurants` deliberately
   *  is not one. */
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

// ------------------------------------------------------------- coverage ---

/** `YYYY-MM` for an ISO date. String slicing rather than `Date`, because these
 *  are calendar labels and constructing a `Date` invites a timezone shift. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * The last day this account has a statement for — the reference point for every
 * liveness and lapse test in §5 (§7.2).
 *
 * `null` when the account has no committed import. Wall-clock time is
 * deliberately not a fallback: it would mark every series lapsed the moment
 * imports fall behind, which is the normal condition of this app rather than an
 * edge case.
 */
export function coverageEnd(account: SnapshotAccount): string | null {
  let latest: string | null = null;
  for (const period of account.coverage) {
    if (latest === null || period.end > latest) latest = period.end;
  }
  return latest;
}

/** Every `YYYY-MM` fully spanned by at least one of this account's imports.
 *  A month counts only when a single import covers its whole span — two
 *  half-month statements leave the middle unproven. */
export function coveredMonths(account: SnapshotAccount): ReadonlySet<string> {
  const months = new Set<string>();

  for (const period of account.coverage) {
    for (const month of monthsBetween(period.start, period.end)) {
      if (period.start <= `${month}-01` && period.end >= lastDayOf(month)) months.add(month);
    }
  }

  return months;
}

/**
 * §7.2: months covered for **every** account in scope.
 *
 * The intersection, not the union, and that is the whole point of the rule — a
 * month in which one of three accounts was imported has artificially low spend,
 * which makes the next complete month look like a spike. §5.10 and §5.11 restrict
 * themselves to this set and report the window they used.
 *
 * An empty account list yields an empty set rather than "all months": no accounts
 * in scope means nothing has been proven covered.
 */
export function fullyCoveredMonths(accounts: readonly SnapshotAccount[]): ReadonlySet<string> {
  if (accounts.length === 0) return new Set<string>();

  const [first, ...rest] = accounts;
  let shared = new Set(coveredMonths(first));

  for (const account of rest) {
    const months = coveredMonths(account);
    shared = new Set([...shared].filter((month) => months.has(month)));
  }

  return shared;
}

/** Inclusive `YYYY-MM` labels spanned by two ISO dates. */
function monthsBetween(start: string, end: string): string[] {
  if (start > end) return [];

  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const last = monthOf(end);

  // Bounded rather than `while (true)`: a malformed period should not spin.
  for (let guard = 0; guard < 1200; guard += 1) {
    const label = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    months.push(label);
    if (label >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

/** The last calendar day of a `YYYY-MM`, as an ISO date. */
function lastDayOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  // Day 0 of the next month is the last day of this one, in UTC.
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * Accounts (§3.1 `account`, §2.3's `/api/accounts` CRUD).
 *
 * §3.4: the repository exposes **named intent methods**, never a raw query
 * string from a caller. Everything here is a verb the API layer actually wants;
 * swapping SQLite for Elasticsearch means rewriting these bodies and nothing
 * above `data`.
 */

import type { AccountType, Currency } from '@metrum/ledgerline-domain';

import { newStamp, asInt } from './stamp.js';
import type { TombstoneRepository } from './tombstones.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toAccount } from '../records.js';
import type { AccountRecord, AccountRow } from '../records.js';

export interface NewAccount {
  readonly displayName: string;
  readonly institution?: string | null;
  readonly accountType: AccountType;
  readonly last4?: string | null;
  readonly currency?: Currency;
  readonly isActive?: boolean;
}

export interface AccountPatch {
  readonly displayName?: string;
  readonly institution?: string | null;
  readonly accountType?: AccountType;
  readonly last4?: string | null;
  readonly isActive?: boolean;
}

/** One committed import's span, as §7.2 defines coverage. Both ends inclusive. */
export interface CoveragePeriod {
  readonly importId: string;
  readonly sourceFilename: string;
  readonly start: string;
  readonly end: string;
}

/**
 * One cell of §6.2's coverage bar.
 *
 * Three states, not two, and `partial` is no longer the common one. §7.2 makes a
 * month covered only when "a committed import's `[period_start, period_end]`
 * spans it", and a profile carrying a `periodPattern` now fills those two from
 * the period the statement *declares* rather than from its first and last row —
 * so an ordinary January statement running the 3rd to the 30th spans January
 * (§9h). Until that landed, essentially every cell was `partial` (§9f), and §5.10
 * and §5.11 had no month they were willing to compute over.
 *
 * The state stays because the case does. Two half-month statements, a mid-cycle
 * export, or a bank whose preamble no profile reads yet all produce a month a
 * statement touches without spanning. Collapsing that into "missing" would be the
 * inverse of the mistake §7.2's own commentary warns about: a red cell over a
 * month whose statement is sitting in the database. Collapsing it into "covered"
 * would quietly promise §5.10 and §5.11 a complete month they are entitled to
 * refuse. `partial` is the honest third answer, and it is exactly the state those
 * two rules decline to compute over — so naming it on the bar tells the user why
 * a finding is absent.
 */
export type CoverageState = 'covered' | 'partial' | 'missing';

export interface CoverageMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly state: CoverageState;
  /**
   * §7.2, unweakened: a **single** committed import spans the whole month. Two
   * half-month statements leave the middle unproven. This is the flag every
   * analyzer's own `coveredMonths` agrees with; `state` is the presentation.
   */
  readonly covered: boolean;
  readonly transactionCount: number;
}

export interface AccountCoverage {
  readonly accountId: string;
  readonly periods: readonly CoveragePeriod[];
  /** Every month from the first statement or row to the last, so a gap is a cell
   *  rather than an absence. */
  readonly months: readonly CoverageMonth[];
  readonly coverageStart: string | null;
  /** §7.2's reference point for every liveness and lapse test in §5. */
  readonly coverageEnd: string | null;
  /** Months inside the span with no statement touching them at all. */
  readonly gapMonths: readonly string[];
  /** Months a statement touches but does not provably span. */
  readonly partialMonths: readonly string[];
  readonly transactionCount: number;
}

export interface AccountMergeResult {
  readonly targetAccountId: string;
  readonly sourceAccountId: string;
  readonly transactionsMoved: number;
  readonly importsMoved: number;
  /** Rows whose `occurrence_index` had to be renumbered because the target
   *  already held a row under the same dedupe key. */
  readonly occurrencesRenumbered: number;
  readonly seriesMoved: number;
  readonly evidenceMoved: number;
}

const SELECT = `SELECT id, display_name, institution, account_type, last4, currency, is_active, created_at, updated_at
                  FROM account`;

export class AccountRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly tombstones: TombstoneRepository
  ) {}

  create(input: NewAccount): AccountRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO account (id, display_name, institution, account_type, last4, currency, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stamp.id,
        input.displayName,
        input.institution ?? null,
        input.accountType,
        input.last4 ?? null,
        input.currency ?? 'USD',
        asInt(input.isActive ?? true),
        stamp.createdAt,
        stamp.updatedAt
      );
    return this.getOrThrow(stamp.id);
  }

  get(id: string): AccountRecord | null {
    const row = this.db.prepare<[string], AccountRow>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toAccount(row) : null;
  }

  getOrThrow(id: string): AccountRecord {
    const account = this.get(id);
    if (!account) throw new Error(`no account ${id}`);
    return account;
  }

  list(): AccountRecord[] {
    return this.db
      .prepare<[], AccountRow>(`${SELECT} ORDER BY display_name`)
      .all()
      .map(toAccount);
  }

  update(id: string, patch: AccountPatch): AccountRecord {
    const current = this.getOrThrow(id);
    this.db
      .prepare(
        `UPDATE account
            SET display_name = ?, institution = ?, account_type = ?, last4 = ?, is_active = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        patch.displayName ?? current.displayName,
        patch.institution === undefined ? current.institution : patch.institution,
        patch.accountType ?? current.accountType,
        patch.last4 === undefined ? current.last4 : patch.last4,
        asInt(patch.isActive ?? current.isActive),
        this.clock.now(),
        id
      );
    return this.getOrThrow(id);
  }

  /**
   * Deletion is RESTRICTed by every child table (§3.2), so this only succeeds on
   * an account with no imports and no transactions. That is the intended
   * behaviour: emptying an account is `DELETE /api/imports/:id` per import, and
   * §6.2's destructive action is *archive*, which is `isActive = false`.
   */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM account WHERE id = ?').run(id);
      this.tombstones.record('account', id);
    })();
  }

  // --------------------------------------------------------------- coverage ---

  /**
   * §6.2's coverage bar, and §7.2's definition of what fills a cell.
   *
   * "An account's month is **covered** when a committed import's
   * `[period_start, period_end]` spans it." Statement periods, never transaction
   * dates — an account can be covered for March and legitimately contain no
   * March rows, and deriving the bar from `MIN`/`MAX(effective_date)` would read
   * a quiet month as a missing statement. That is not a cosmetic difference:
   * every liveness test in §5.2 and §5.7 measures against `coverageEnd`, and
   * §5.10 and §5.11 refuse to compute over a partial month at all, so the bar is
   * showing the user the precondition for trusting any finding on the page.
   *
   * `status = 'committed'` is the whole of "a committed import": a staged file
   * has been parsed and reviewed but has put no rows in `transaction`, and
   * counting its period would claim coverage for a statement never accepted.
   *
   * Transaction counts ride along per month because a covered month with no rows
   * and an uncovered month with no rows look identical otherwise, and they are
   * the two cases the bar exists to tell apart.
   */
  coverage(accountId: string): AccountCoverage {
    const periods = this.db
      .prepare<
        [string],
        { import_id: string; source_filename: string; period_start: string; period_end: string }
      >(
        `SELECT id AS import_id, source_filename, period_start, period_end
           FROM statement_import
          WHERE account_id = ?
            AND status = 'committed'
            AND period_start IS NOT NULL
            AND period_end IS NOT NULL
          ORDER BY period_start, id`,
      )
      .all(accountId)
      .map((row) => ({
        importId: row.import_id,
        sourceFilename: row.source_filename,
        start: row.period_start,
        end: row.period_end,
      }));

    const rowsByMonth = new Map(
      this.db
        .prepare<[string], { month: string; n: number }>(
          `SELECT substr(effective_date, 1, 7) AS month, COUNT(*) AS n
             FROM "transaction"
            WHERE account_id = ?
            GROUP BY month`,
        )
        .all(accountId)
        .map((row) => [row.month, row.n] as const),
    );

    const covered = new Set<string>();
    const touched = new Set<string>();

    for (const period of periods) {
      for (const month of monthsBetween(period.start, period.end)) {
        touched.add(month);
        if (period.start <= `${month}-01` && period.end >= lastDayOf(month)) covered.add(month);
      }
    }

    // The span runs over statements *and* rows. A transaction outside every
    // period is exactly the thing worth seeing — it means a statement was
    // imported with a period that does not contain its own rows.
    const marks = [...touched, ...rowsByMonth.keys()].sort();

    const months: CoverageMonth[] =
      marks.length === 0
        ? []
        : monthsBetween(`${marks[0]}-01`, `${marks[marks.length - 1]}-01`).map((month) => ({
            month,
            state: covered.has(month) ? 'covered' : touched.has(month) ? 'partial' : 'missing',
            covered: covered.has(month),
            transactionCount: rowsByMonth.get(month) ?? 0,
          }));

    const ends = periods.map((period) => period.end).sort();
    const starts = periods.map((period) => period.start).sort();

    return {
      accountId,
      periods,
      months,
      coverageStart: starts[0] ?? null,
      coverageEnd: ends[ends.length - 1] ?? null,
      gapMonths: months.filter((month) => month.state === 'missing').map((month) => month.month),
      partialMonths: months
        .filter((month) => month.state === 'partial')
        .map((month) => month.month),
      transactionCount: [...rowsByMonth.values()].reduce((total, count) => total + count, 0),
    };
  }

  // ------------------------------------------------------------------ merge ---

  /**
   * §6.2's merge: fold `sourceId` into `targetId` and archive what is left.
   *
   * This is the "same account imported twice under two names" repair — usually a
   * bank that changed its export format, so the second import made a second
   * account. Which means the two very often hold *the same rows*.
   *
   * **It re-points history; it does not deduplicate it.** §3.3's `dedupe_key`
   * hashes the account id into its material, so one charge sitting in two
   * accounts has two different keys — the merge rule cannot see them as the same
   * row, and §3.2's `UNIQUE (account_id, dedupe_key, occurrence_index)` never
   * fires on the re-point. Recomputing the keys would be a rewrite of frozen key
   * material, which §3.3 permits only through a migration inside one
   * transaction. So the duplicates survive and the user deletes the redundant
   * import, which §3.3 already does precisely. Recorded in §9f.
   *
   * The renumbering below is therefore a guard rather than a routine path: it
   * costs one indexed lookup per distinct key and is what stops a future change
   * to the key material turning this method into a half-applied failure. Dropping
   * colliding rows instead would be deciding, without evidence, that two accounts
   * holding one $4.75 row each means one charge — and §3.3's rule is a multiset
   * precisely because it does not.
   *
   * The source account is archived, not deleted: §3.2 RESTRICTs the delete behind
   * `tombstone` and `transaction_source` anyway, and §6.2 makes archive the
   * destructive action for accounts.
   */
  merge(targetId: string, sourceId: string): AccountMergeResult {
    if (targetId === sourceId) throw new Error('cannot merge an account into itself');
    const target = this.getOrThrow(targetId);
    const source = this.getOrThrow(sourceId);
    if (target.currency !== source.currency) {
      // §3.2's `CHECK (currency = account.currency)` would refuse the re-point
      // row by row; refusing here says why.
      throw new Error(
        `cannot merge ${source.currency} account into a ${target.currency} one (spec 3.2)`,
      );
    }

    return this.db.transaction((): AccountMergeResult => {
      const now = this.clock.now();

      const moving = this.db
        .prepare<[string], { id: string; dedupe_key: string }>(
          'SELECT id, dedupe_key FROM "transaction" WHERE account_id = ? ORDER BY effective_date, id',
        )
        .all(sourceId);

      const nextIndex = this.db.prepare<[string, string], { highest: number | null }>(
        'SELECT MAX(occurrence_index) AS highest FROM "transaction" WHERE account_id = ? AND dedupe_key = ?',
      );
      const repoint = this.db.prepare(
        'UPDATE "transaction" SET account_id = ?, occurrence_index = ?, updated_at = ? WHERE id = ?',
      );

      // Counted forward per key rather than re-queried per row: the rows this
      // loop has already moved are in the table, so `MAX + 1` would be correct
      // either way — but one query per distinct key is the difference §3.2's
      // first index note is about.
      const taken = new Map<string, number>();
      let occurrencesRenumbered = 0;

      for (const row of moving) {
        const highest =
          taken.get(row.dedupe_key) ?? nextIndex.get(targetId, row.dedupe_key)?.highest ?? -1;
        const index = highest + 1;
        taken.set(row.dedupe_key, index);
        if (index !== 0) occurrencesRenumbered += 1;
        repoint.run(targetId, index, now, row.id);
      }

      const importsMoved = this.db
        .prepare('UPDATE statement_import SET account_id = ?, updated_at = ? WHERE account_id = ?')
        .run(targetId, now, sourceId).changes;

      // `recurring_series` and `finding_evidence` both carry an account id, and
      // a finding whose evidence points at an archived account is a finding the
      // §6.4 account filter can no longer reach.
      const seriesMoved = this.db
        .prepare('UPDATE recurring_series SET account_id = ?, updated_at = ? WHERE account_id = ?')
        .run(targetId, now, sourceId).changes;

      const evidenceMoved = this.db
        .prepare('UPDATE finding_evidence SET account_id = ?, updated_at = ? WHERE account_id = ?')
        .run(targetId, now, sourceId).changes;

      this.db
        .prepare('UPDATE account SET is_active = 0, updated_at = ? WHERE id = ?')
        .run(now, sourceId);

      return {
        targetAccountId: targetId,
        sourceAccountId: sourceId,
        transactionsMoved: moving.length,
        importsMoved,
        occurrencesRenumbered,
        seriesMoved,
        evidenceMoved,
      };
    })();
  }
}

/** Inclusive `YYYY-MM` labels spanned by two ISO dates. Bounded rather than
 *  `while (true)`: a malformed period should not spin. */
function monthsBetween(start: string, end: string): string[] {
  if (start > end) return [];

  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const last = end.slice(0, 7);

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

/** The last calendar day of a `YYYY-MM`, as an ISO date. Day 0 of the next month
 *  is the last day of this one, in UTC. */
function lastDayOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

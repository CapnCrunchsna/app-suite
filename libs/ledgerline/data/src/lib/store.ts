/**
 * `LedgerlineStore` — the single object the composition root holds.
 *
 * §2.1: "Libs compute; the app persists." This is the persist half, and it is
 * the whole of it: `apps/ledgerline-api` wires a pure parse and a pure
 * normalization into calls on this object, and nothing else in the workspace
 * imports `better-sqlite3` or knows a file on disk is involved.
 *
 * Opening it applies migrations. §3 says migrations are "applied at boot", and
 * making that a property of construction rather than a step someone remembers is
 * what stops a fresh checkout from failing against an empty database.
 */

import { randomUUID } from 'node:crypto';

import { buildSnapshot } from './analysis/snapshot.js';
import type { Snapshot } from './analysis/snapshot.js';
import { commitImport } from './import/commit.js';
import type { CommitDeps, CommitImportInput, CommitImportResult } from './import/commit.js';
import { planImport } from './import/plan.js';
import type { ImportPlan, IncomingRow } from './import/plan.js';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { backupDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { applyMigrations } from './migrations/runner.js';
import type { MigrationOutcome } from './migrations/runner.js';
import { AccountRepository } from './repositories/accounts.js';
import { AnalysisRepository } from './repositories/analysis.js';
import { FindingLabelRepository, FindingRepository } from './repositories/findings.js';
import { FormatProfileRepository } from './repositories/format-profiles.js';
import { ImportRepository } from './repositories/imports.js';
import { JobRepository } from './repositories/jobs.js';
import { LlmRepository } from './repositories/llm.js';
import { MerchantRepository } from './repositories/merchants.js';
import { SettingsRepository } from './repositories/settings.js';
import { TombstoneRepository } from './repositories/tombstones.js';
import { TransactionLabelRepository } from './repositories/transaction-labels.js';
import { TransactionRepository } from './repositories/transactions.js';
import { TransferRepository } from './repositories/transfers.js';

export interface LedgerlineStoreOptions {
  /** A path, or `:memory:`. */
  readonly filename: string;
  readonly clock?: Clock;
}

export class LedgerlineStore {
  readonly tombstones: TombstoneRepository;
  readonly accounts: AccountRepository;
  readonly formatProfiles: FormatProfileRepository;
  readonly merchants: MerchantRepository;
  readonly imports: ImportRepository;
  readonly transactions: TransactionRepository;
  readonly settings: SettingsRepository;
  readonly jobs: JobRepository;
  readonly findings: FindingRepository;
  /** §7.6’s corpus, collected from use (§9z). Separate from `findings` because a
   *  label outlives the finding it judged. */
  readonly findingLabels: FindingLabelRepository;
  /** §7.6’s other half (§9ab): what *should* be found, written against the rows,
   *  which is the only thing that can measure a miss. */
  readonly transactionLabels: TransactionLabelRepository;
  readonly analysis: AnalysisRepository;
  /** §2.6's `transfer_link` / `transfer_rule`, and the flags a live link sets. */
  readonly transfers: TransferRepository;
  /** §2.4's cache and degraded-call log, and §4.2's proposals. Rows only — what a
   *  provider is stays in the app (§2.2). */
  readonly llm: LlmRepository;
  readonly migrations: MigrationOutcome;

  private constructor(
    readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.migrations = applyMigrations(db, clock);
    this.tombstones = new TombstoneRepository(db, clock);
    this.accounts = new AccountRepository(db, clock, this.tombstones);
    this.formatProfiles = new FormatProfileRepository(db, clock);
    this.merchants = new MerchantRepository(db, clock);
    this.imports = new ImportRepository(db, clock, this.tombstones);
    this.transactions = new TransactionRepository(db, clock, this.tombstones);
    this.settings = new SettingsRepository(db, clock);
    this.jobs = new JobRepository(db, clock);
    this.findings = new FindingRepository(db, clock);
    this.findingLabels = new FindingLabelRepository(db, clock);
    this.transactionLabels = new TransactionLabelRepository(db, clock);
    this.analysis = new AnalysisRepository(db, clock, this.tombstones);
    this.transfers = new TransferRepository(db, clock);
    this.llm = new LlmRepository(db, clock);
  }

  static open(options: LedgerlineStoreOptions): LedgerlineStore {
    const clock = options.clock ?? systemClock(randomUUID);
    return new LedgerlineStore(openDatabase({ filename: options.filename }), clock);
  }

  /**
   * What `GET /api/imports/:id` shows the reviewer: which rows the merge rule
   * will insert, which it will absorb, and which near-duplicates need a decision
   * — all computed against the store as it is right now, and none of it written.
   */
  planImport(accountId: string, rows: readonly IncomingRow[]): ImportPlan {
    return planImport(this.transactions, accountId, rows);
  }

  commitImport(input: CommitImportInput): CommitImportResult {
    return commitImport(this.commitDeps(), input);
  }

  /**
   * §2.2's "**one snapshot per run, not one per analyzer**", made structural: the
   * only way to get one is to ask the store for it, and the caller passes the
   * same object to every rule.
   */
  buildSnapshot(): Snapshot {
    return buildSnapshot(this.db);
  }

  private commitDeps(): CommitDeps {
    return {
      db: this.db,
      clock: this.clock,
      imports: this.imports,
      transactions: this.transactions,
    };
  }

  /** `POST /api/data/backup` (§2.3). */
  backup(destination: string): Promise<void> {
    return backupDatabase(this.db, destination);
  }

  /**
   * `DELETE /api/data` (§2.3, §6.8) — every row of *data*, and nothing else.
   *
   * ## What survives, and why it is not everything
   *
   * `schema_migrations` stays, because a wiped database is still this schema at this
   * version and re-running §3's migrations over a live file is a different, worse
   * operation than emptying it. `settings` stays too: §7.4's thresholds are
   * *configuration*, not data — someone who has spent an afternoon tuning §5 against
   * their statements should not lose that by clearing the statements, and §6.8 files
   * the wipe under **Data** for exactly that reason. The caller re-seeds the reference
   * rows (§4's aliases, §5's categories, the format profiles) afterwards, so the app
   * comes back in the state a fresh install would be in rather than an empty one.
   *
   * ## `defer_foreign_keys`, not `foreign_keys = OFF`
   *
   * §3.2's `ON DELETE RESTRICT` constraints mean the tables can only be emptied in
   * dependency order, and getting that order wrong is a runtime error on a
   * half-emptied database. SQLite ignores a `foreign_keys` change inside a
   * transaction, so the pragma that works here is `defer_foreign_keys`: constraints
   * are checked once at COMMIT instead of per statement, which makes the order
   * irrelevant and still refuses to leave an orphan behind.
   *
   * Returns what it deleted, per table, because "are you sure?" deserves an answer
   * more specific than "done".
   */
  wipe(): Record<string, number> {
    const tables = this.db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name NOT IN ('schema_migrations', 'settings')
          ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    return this.db.transaction((): Record<string, number> => {
      this.db.pragma('defer_foreign_keys = ON');

      const deleted: Record<string, number> = {};
      for (const table of tables) {
        // The table names come from `sqlite_master`, not from a caller — §3.4's
        // "no caller string reaches SQL uninterpreted" still holds.
        deleted[table] = this.db.prepare(`DELETE FROM "${table}"`).run().changes;
      }
      return deleted;
    })();
  }

  close(): void {
    this.db.close();
  }
}

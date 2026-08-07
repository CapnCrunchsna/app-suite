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
import { FormatProfileRepository } from './repositories/format-profiles.js';
import { ImportRepository } from './repositories/imports.js';
import { JobRepository } from './repositories/jobs.js';
import { MerchantRepository } from './repositories/merchants.js';
import { SettingsRepository } from './repositories/settings.js';
import { TombstoneRepository } from './repositories/tombstones.js';
import { TransactionRepository } from './repositories/transactions.js';

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

  close(): void {
    this.db.close();
  }
}

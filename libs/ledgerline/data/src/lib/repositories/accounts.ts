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
}

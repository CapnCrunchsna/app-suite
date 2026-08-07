/**
 * Canonical merchants, their aliases, and categories (§3.1, §4.3).
 *
 * `data` never runs the §4 normalization chain — `type:data-access` may depend
 * on `type:domain` and nothing else (§2.2), so it *cannot* reach `normalize`
 * even if someone wanted it to. The composition root runs the chain and hands
 * the result here. That is deliberate: §3.3 calls the separation between the
 * frozen `collapse_v1` and the growing §4 chain "the correctness condition [...]
 * most likely to be violated by accident", and the module graph is what stops it
 * from being violated.
 */

import { newStamp, asInt } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toMerchant, toMerchantAlias } from '../records.js';
import type {
  AliasMatchKind,
  CategoryRecord,
  MerchantAliasRecord,
  MerchantAliasRow,
  MerchantRecord,
  MerchantRow,
  ProvenanceSource,
} from '../records.js';

export interface SeedMerchantInput {
  /** Seeds carry stable ids so the alias table can reference them across boots.
   *  Everything else gets a generated surrogate. */
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly isKnownSubscription?: boolean;
  readonly isTransferKind?: boolean;
  readonly website?: string | null;
  readonly defaultCategoryId?: string | null;
  readonly overlapGroup?: string | null;
}

export interface AliasInput {
  readonly aliasKey: string;
  readonly merchantId: string;
  readonly matchType: AliasMatchKind;
  readonly confidence?: number | null;
  readonly source: ProvenanceSource;
}

export interface CategoryInput {
  readonly id: string;
  readonly name: string;
  readonly kind: CategoryRecord['kind'];
  readonly parentId?: string | null;
  readonly overlapGroup?: string | null;
}

/**
 * §4.3's alias precedence, highest first: `user` → `seed` → `rule` → `llm`.
 * Lower number wins. Restated here rather than imported, because `normalize`
 * owns the identical constant and `type:data-access` may not depend on it (§2.2);
 * the two are kept in step by the boundary being the only thing between them.
 */
const SOURCE_PRECEDENCE: Readonly<Record<ProvenanceSource, number>> = {
  user: 0,
  seed: 1,
  rule: 2,
  llm: 3,
};

const SELECT_MERCHANT = `SELECT id, canonical_name, display_name, website, default_category_id,
                                is_known_subscription, is_transfer_kind, overlap_group, source
                           FROM merchant_canonical`;

const SELECT_ALIAS = `SELECT id, alias_key, merchant_id, match_type, confidence, source
                        FROM merchant_alias`;

const SELECT_CATEGORY = `SELECT id, name, parent_id, kind, overlap_group FROM category`;

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  kind: CategoryRecord['kind'];
  overlap_group: string | null;
}

function toCategory(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    kind: row.kind,
    overlapGroup: row.overlap_group,
  };
}

export class MerchantRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  get(id: string): MerchantRecord | null {
    const row = this.db.prepare<[string], MerchantRow>(`${SELECT_MERCHANT} WHERE id = ?`).get(id);
    return row ? toMerchant(row) : null;
  }

  findByCanonicalName(canonicalName: string): MerchantRecord | null {
    const row = this.db
      .prepare<[string], MerchantRow>(`${SELECT_MERCHANT} WHERE canonical_name = ?`)
      .get(canonicalName);
    return row ? toMerchant(row) : null;
  }

  list(): MerchantRecord[] {
    return this.db
      .prepare<[], MerchantRow>(`${SELECT_MERCHANT} ORDER BY canonical_name`)
      .all()
      .map(toMerchant);
  }

  /**
   * §4.1 step 7: "the cleaned string becomes a provisional merchant, marked
   * `source = 'rule'`, and joins the review queue."
   *
   * Get-or-create rather than insert, backed by the UNIQUE index on
   * `canonical_name`. Two statements from the same bank in one import session
   * produce the same cleaned descriptor many times over; without this, every
   * §5 rule would group one merchant as several.
   */
  getOrCreateProvisional(canonicalName: string): MerchantRecord {
    const existing = this.findByCanonicalName(canonicalName);
    if (existing) return existing;

    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO merchant_canonical
           (id, canonical_name, display_name, website, default_category_id,
            is_known_subscription, is_transfer_kind, overlap_group, source, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 0, 0, NULL, 'rule', ?, ?)`,
      )
      .run(stamp.id, canonicalName, canonicalName, stamp.createdAt, stamp.updatedAt);

    return this.get(stamp.id) as MerchantRecord;
  }

  upsertSeed(input: SeedMerchantInput): MerchantRecord {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO merchant_canonical
           (id, canonical_name, display_name, website, default_category_id,
            is_known_subscription, is_transfer_kind, overlap_group, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           canonical_name = excluded.canonical_name,
           display_name = excluded.display_name,
           website = excluded.website,
           default_category_id = excluded.default_category_id,
           is_known_subscription = excluded.is_known_subscription,
           is_transfer_kind = excluded.is_transfer_kind,
           overlap_group = excluded.overlap_group,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.canonicalName,
        input.displayName,
        input.website ?? null,
        input.defaultCategoryId ?? null,
        asInt(input.isKnownSubscription ?? false),
        asInt(input.isTransferKind ?? false),
        input.overlapGroup ?? null,
        now,
        now,
      );
    return this.get(input.id) as MerchantRecord;
  }

  listAliases(): MerchantAliasRecord[] {
    return this.db
      .prepare<[], MerchantAliasRow>(`${SELECT_ALIAS} ORDER BY alias_key, match_type`)
      .all()
      .map(toMerchantAlias);
  }

  /**
   * Upsert on `(alias_key, match_type)` — §3.2's UNIQUE index, which exists
   * because "two `user` aliases for one key have no defined winner".
   *
   * §4.3's precedence is enforced here rather than at the call site, because the
   * call site is where it will be forgotten: a weaker source never overwrites a
   * stronger one, so a re-seed cannot undo a user correction and a re-normalize
   * cannot undo a seed. §4.2 adds a stricter rule for one source — "the LLM
   * never overwrites an existing alias" at all, not even another model's — and
   * that is checked separately because precedence alone would let it.
   */
  upsertAlias(input: AliasInput): MerchantAliasRecord {
    const existing = this.db
      .prepare<[string, string], MerchantAliasRow>(
        `${SELECT_ALIAS} WHERE alias_key = ? AND match_type = ?`,
      )
      .get(input.aliasKey, input.matchType);

    if (existing) {
      const weaker = SOURCE_PRECEDENCE[input.source] > SOURCE_PRECEDENCE[existing.source];
      if (weaker || input.source === 'llm') return toMerchantAlias(existing);

      this.db
        .prepare(
          `UPDATE merchant_alias
              SET merchant_id = ?, confidence = ?, source = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.merchantId,
          input.confidence ?? null,
          input.source,
          this.clock.now(),
          existing.id,
        );
      return toMerchantAlias(
        this.db
          .prepare<[string], MerchantAliasRow>(`${SELECT_ALIAS} WHERE id = ?`)
          .get(existing.id) as MerchantAliasRow,
      );
    }

    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO merchant_alias
           (id, alias_key, merchant_id, match_type, confidence, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp.id,
        input.aliasKey,
        input.merchantId,
        input.matchType,
        input.confidence ?? null,
        input.source,
        stamp.createdAt,
        stamp.updatedAt,
      );

    return toMerchantAlias(
      this.db
        .prepare<[string], MerchantAliasRow>(`${SELECT_ALIAS} WHERE id = ?`)
        .get(stamp.id) as MerchantAliasRow,
    );
  }

  upsertCategory(input: CategoryInput): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO category (id, name, parent_id, kind, overlap_group, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           parent_id = excluded.parent_id,
           kind = excluded.kind,
           overlap_group = excluded.overlap_group,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.parentId ?? null,
        input.kind,
        input.overlapGroup ?? null,
        now,
        now,
      );
  }

  listCategories(): CategoryRecord[] {
    return this.db
      .prepare<[], CategoryRow>(`${SELECT_CATEGORY} ORDER BY name`)
      .all()
      .map(toCategory);
  }

  /** One category, for validating an assignment before it is written. */
  getCategory(id: string): CategoryRecord | null {
    const row = this.db.prepare<[string], CategoryRow>(`${SELECT_CATEGORY} WHERE id = ?`).get(id);
    return row ? toCategory(row) : null;
  }
}

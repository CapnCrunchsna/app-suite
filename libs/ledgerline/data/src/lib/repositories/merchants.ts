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
import type { TombstoneRepository } from './tombstones.js';
import type {
  AliasMatchKind,
  CategoryRecord,
  CategorySource,
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

/** §6.8's editor creating one. No `id`: a seed carries a stable one so aliases can
 *  reference it across boots, and nothing references a category a person invented
 *  five seconds ago. */
export interface NewCategory {
  readonly name: string;
  readonly kind: CategoryRecord['kind'];
  readonly parentId?: string | null;
  readonly overlapGroup?: string | null;
}

/**
 * A partial edit. `overlapGroup` and `parentId` are nullable *and* optional, and the
 * difference carries weight: absent means "leave it", `null` means "clear it" — which
 * for `overlapGroup` is how §5.4's category-overlap claim is withdrawn.
 */
export interface CategoryPatch {
  readonly name?: string;
  readonly kind?: CategoryRecord['kind'];
  readonly parentId?: string | null;
  readonly overlapGroup?: string | null;
}

/** What refers to a category, and therefore what §3.2's `ON DELETE RESTRICT` would
 *  refuse a deletion over. */
export interface CategoryUsage {
  readonly category: CategoryRecord;
  /** `transaction.category_id`, every row — an excluded or internal-transfer row
   *  still holds the foreign key. */
  readonly transactions: number;
  readonly merchants: number;
  readonly children: number;
}

/** What a reassignment moved, before the category it moved things off is deleted. */
export interface CategoryReassignment {
  readonly transactions: number;
  readonly merchants: number;
  readonly children: number;
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

const SELECT_CATEGORY = `SELECT id, name, parent_id, kind, overlap_group, source FROM category`;

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  kind: CategoryRecord['kind'];
  overlap_group: string | null;
  source: CategorySource;
}

function toCategory(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    kind: row.kind,
    overlapGroup: row.overlap_group,
    source: row.source,
  };
}

export class MerchantRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    /** Only the category deletes need one — §3.4's re-index cannot see a row that
     *  is simply gone. Merchants are never deleted; §9q's merge writes aliases
     *  instead, precisely so the row survives as the explanation. */
    private readonly tombstones: TombstoneRepository,
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
   * cannot undo a seed.
   *
   * ## The one place `llm` is not simply the weakest source (§9s)
   *
   * §4.2 adds a stricter rule for it — "The LLM never overwrites an existing alias
   * and never touches anything with `source = 'user'`" — and that rule, applied to
   * every source, makes §4.2's own auto-apply path unreachable. §4.1 step 7 writes
   * a `rule` alias for **every** descriptor the chain could not place, so by the
   * time §4.2 is asked about one it always already has an alias, and a blanket
   * refusal means a proposal at 0.99 confidence applies to nothing, ever.
   *
   * The distinction that resolves it is what a `rule` alias *is*. `seed` and `user`
   * are judgements — one shipped, one made by a person. A `rule` row is neither: it
   * is a cache of the chain's own deterministic output, written so a later import
   * of the same spelling lands on the same provisional merchant rather than
   * creating a second one. Overwriting it discards no decision, because nobody made
   * one; the chain would recompute the identical answer from the descriptor.
   *
   * So `llm` may replace `rule`, and nothing else — not `seed`, not `user`, and not
   * another `llm` row, which keeps a re-run idempotent and stops two models
   * trading a descriptor back and forth. §4.3's precedence is untouched for
   * *resolution*, where `rule` still outranks `llm`; this is only about who may
   * overwrite whom.
   */
  upsertAlias(input: AliasInput): MerchantAliasRecord {
    const existing = this.db
      .prepare<[string, string], MerchantAliasRow>(
        `${SELECT_ALIAS} WHERE alias_key = ? AND match_type = ?`,
      )
      .get(input.aliasKey, input.matchType);

    if (existing) {
      if (input.source === 'llm') {
        if (existing.source !== 'rule') return toMerchantAlias(existing);
      } else if (SOURCE_PRECEDENCE[input.source] > SOURCE_PRECEDENCE[existing.source]) {
        return toMerchantAlias(existing);
      }

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

  /**
   * The **seed** path: `SEED_CATEGORIES`, re-applied at every boot.
   *
   * The `WHERE source = 'seed'` on the conflict clause is the whole of migration
   * 009's argument, in one line. Without it this statement runs at every start-up
   * and overwrites the taxonomy §6.8's editor just wrote — the shipped name, the
   * shipped kind and, worst of the three, `overlap_group` back to NULL, which
   * silently withdraws the only claim §5.4's category half has to work from.
   *
   * §4.3 settled the identical question for aliases and this is the same answer:
   * a weaker source never overwrites a stronger one, so a re-seed cannot undo a
   * user's decision.
   */
  upsertCategory(input: CategoryInput): void {
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO category
           (id, name, parent_id, kind, overlap_group, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'seed', ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           parent_id = excluded.parent_id,
           kind = excluded.kind,
           overlap_group = excluded.overlap_group,
           updated_at = excluded.updated_at
         WHERE source = 'seed'`,
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

  /** §6.8's editor creating one. `source = 'user'` from birth: nothing shipped it,
   *  so no future seed may claim it. */
  createCategory(input: NewCategory): CategoryRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO category
           (id, name, parent_id, kind, overlap_group, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
      )
      .run(
        stamp.id,
        input.name,
        input.parentId ?? null,
        input.kind,
        input.overlapGroup ?? null,
        stamp.createdAt,
        stamp.updatedAt,
      );
    return this.getCategory(stamp.id) as CategoryRecord;
  }

  /**
   * §6.8's rename, reparent, kind change and overlap-group assignment.
   *
   * Every one of them flips `source` to `user`, including on a row that shipped as
   * a seed. That is the point of migration 009 rather than a side effect of it: an
   * edit the next boot reverts is worse than no editor at all, and the moment a
   * person has an opinion about a row the shipped opinion stops being the better
   * one.
   *
   * Absent keys are left alone and explicit `null`s clear — see `CategoryPatch`.
   */
  updateCategory(id: string, patch: CategoryPatch): CategoryRecord {
    const assignments: string[] = [];
    const values: (string | null)[] = [];

    if (patch.name !== undefined) {
      assignments.push('name = ?');
      values.push(patch.name);
    }
    if (patch.kind !== undefined) {
      assignments.push('kind = ?');
      values.push(patch.kind);
    }
    if (patch.parentId !== undefined) {
      assignments.push('parent_id = ?');
      values.push(patch.parentId);
    }
    if (patch.overlapGroup !== undefined) {
      assignments.push('overlap_group = ?');
      values.push(patch.overlapGroup);
    }

    if (assignments.length > 0) {
      this.db
        .prepare(
          `UPDATE category SET ${assignments.join(', ')}, source = 'user', updated_at = ?
            WHERE id = ?`,
        )
        .run(...values, this.clock.now(), id);
    }

    return this.getCategory(id) as CategoryRecord;
  }

  /**
   * Delete, with §3.4's tombstone written in the same transaction.
   *
   * No force and no cascade. §3.2 puts `ON DELETE RESTRICT` on all three references
   * — `transaction.category_id`, `merchant_canonical.default_category_id` and
   * `category.parent_id` — so this throws rather than orphaning anything, and the
   * caller is expected to have counted first (`categoryUsage`) or moved the rows
   * (`reassignCategory`). The constraint is the backstop, not the interface.
   */
  deleteCategory(id: string): void {
    this.db.transaction(() => {
      this.tombstones.record('category', id);
      this.db.prepare('DELETE FROM category WHERE id = ?').run(id);
    })();
  }

  /**
   * What refers to each category, in three grouped queries rather than three per row.
   *
   * Every category appears, including the ones nothing references — a zero is the
   * answer that lets §6.8 offer a delete button, so leaving it out would make an
   * unused category indistinguishable from a missing one.
   */
  categoryUsage(): CategoryUsage[] {
    const count = (sql: string): Map<string, number> =>
      new Map(
        this.db
          .prepare<[], { key: string | null; n: number }>(sql)
          .all()
          .filter((row): row is { key: string; n: number } => row.key !== null)
          .map((row) => [row.key, row.n]),
      );

    const transactions = count(
      `SELECT category_id AS key, COUNT(*) AS n FROM "transaction" GROUP BY category_id`,
    );
    const merchants = count(
      `SELECT default_category_id AS key, COUNT(*) AS n
         FROM merchant_canonical GROUP BY default_category_id`,
    );
    const children = count(
      `SELECT parent_id AS key, COUNT(*) AS n FROM category GROUP BY parent_id`,
    );

    return this.listCategories().map((category) => ({
      category,
      transactions: transactions.get(category.id) ?? 0,
      merchants: merchants.get(category.id) ?? 0,
      children: children.get(category.id) ?? 0,
    }));
  }

  /**
   * Move everything that points at one category to another, so it can then be deleted.
   *
   * `category_source` is deliberately left alone. A reassignment is a *merge* of two
   * categories, not a re-categorization of the rows in them — the person who filed a
   * charge under "Streaming" still filed it, and rewriting their provenance to make
   * the app look like the author would cost §7.6 the distinction it measures accuracy
   * with.
   *
   * Children are **promoted to roots** rather than moved under the target. Only a
   * root can have children (the API caps the taxonomy at two levels), so promotion is
   * always legal where re-parenting under an arbitrary target would not be.
   */
  reassignCategory(fromId: string, toId: string): CategoryReassignment {
    return this.db.transaction((): CategoryReassignment => {
      const now = this.clock.now();

      const transactions = this.db
        .prepare('UPDATE "transaction" SET category_id = ?, updated_at = ? WHERE category_id = ?')
        .run(toId, now, fromId).changes;

      const merchants = this.db
        .prepare(
          `UPDATE merchant_canonical SET default_category_id = ?, updated_at = ?
            WHERE default_category_id = ?`,
        )
        .run(toId, now, fromId).changes;

      const children = this.db
        .prepare('UPDATE category SET parent_id = NULL, updated_at = ? WHERE parent_id = ?')
        .run(now, fromId).changes;

      return { transactions, merchants, children };
    })();
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

  /** Case-insensitive, because two categories called "Streaming" and "streaming" are
   *  one mistake rather than two categories. §3.1 puts no UNIQUE on the column, so
   *  this is what the API checks against before it writes. */
  findCategoryByName(name: string, exceptId?: string): CategoryRecord | null {
    const row = this.db
      .prepare<[string, string], CategoryRow>(
        `${SELECT_CATEGORY} WHERE name = ? COLLATE NOCASE AND id <> ?`,
      )
      .get(name, exceptId ?? '');
    return row ? toCategory(row) : null;
  }
}

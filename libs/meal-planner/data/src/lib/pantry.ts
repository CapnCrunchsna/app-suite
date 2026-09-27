/**
 * The pantry (meal-planner-spec.md §3 `pantry_items`, §10, §11).
 *
 * A row is one purchase: adding two cartons of eggs is one row of 24, stamped with when
 * it was bought and, optionally, when it expires. Depletion (§11) draws from rows oldest
 * expiry first, so keeping purchases apart is what lets the carton going off this week be
 * used before the one bought yesterday.
 *
 * ## Undo
 *
 * Remove and cook both return a `PantryUndo`: the exact prior quantity and deletion stamp
 * of every row they touched. `restore` writes those back, so an undone removal is the
 * row as it was — not a new row that happens to hold the same amount.
 */

import { pantryStock, planDepletion, type PantryItem, type Product, type ProductDraft } from '@metrum/meal-planner-domain';
import type { ProductsRepo } from './products.js';
import { toPantryItem, toProduct, type PantryItemRow, type ProductRow } from './rows.js';
import type { Clock, SqlDb, SqlExecutor } from './sql.js';

export interface PantryEntry {
  readonly item: PantryItem;
  readonly product: Product;
}

export interface AddToPantry {
  readonly productId: string;
  /** Whole or fractional packages; the row holds `packages × package_amount`. */
  readonly packages: number;
  readonly expiresOn: string | null;
}

export interface Purchase {
  /** An existing product's id, or a draft to create. */
  readonly product: string | ProductDraft;
  readonly packages: number;
  readonly expiresOn: string | null;
}

export interface PantryUndo {
  readonly rows: readonly { readonly id: string; readonly quantity: number; readonly deletedAt: string | null }[];
}

const ITEM_COLUMNS = 'id, product_id, quantity, expires_on, acquired_at, updated_at, deleted_at';
const PRODUCT_COLUMNS = `p.id AS p_id, p.barcode, p.name, p.brand, p.package_unit, p.package_amount, p.nutrition_basis,
  p.kcal, p.protein_g, p.source, p.created_at AS p_created_at, p.updated_at AS p_updated_at, p.deleted_at AS p_deleted_at`;

type JoinedRow = PantryItemRow &
  Omit<ProductRow, 'id' | 'created_at' | 'updated_at' | 'deleted_at'> & {
    p_id: string;
    p_created_at: string;
    p_updated_at: string;
    p_deleted_at: string | null;
  };

export class PantryRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly clock: Clock,
  ) {}

  /** Live rows with something left, grouped by product name, oldest purchase first. */
  async list(): Promise<PantryEntry[]> {
    const rows = await this.db.all<JoinedRow>(
      `SELECT i.id, i.product_id, i.quantity, i.expires_on, i.acquired_at, i.updated_at, i.deleted_at, ${PRODUCT_COLUMNS}
         FROM pantry_items i JOIN products p ON p.id = i.product_id
        WHERE i.deleted_at IS NULL AND i.quantity > 0
        ORDER BY p.name COLLATE NOCASE, i.acquired_at, i.id`,
    );
    return rows.map((row) => ({
      item: toPantryItem(row),
      product: toProduct({
        ...row,
        id: row.p_id,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at,
        deleted_at: row.p_deleted_at,
      }),
    }));
  }

  async add(entry: AddToPantry): Promise<PantryItem> {
    return this.db.transaction((tx) => this.insert(tx, entry));
  }

  /** Several rows, every one or none. */
  async addMany(entries: readonly AddToPantry[]): Promise<PantryItem[]> {
    return this.db.transaction(async (tx) => {
      const items: PantryItem[] = [];
      for (const entry of entries) items.push(await this.insert(tx, entry));
      return items;
    });
  }

  /**
   * Bulk scan's commit (§7: "committing all rows in one transaction"). A purchase names
   * an existing product by id, or brings a draft — a barcode Open Food Facts knew but the
   * catalog did not — which is created in the same transaction, so a failed commit leaves
   * no half-imported catalog behind.
   */
  async addPurchases(purchases: readonly Purchase[], products: ProductsRepo): Promise<PantryItem[]> {
    return this.db.transaction(async (tx) => {
      const items: PantryItem[] = [];
      for (const purchase of purchases) {
        const productId =
          typeof purchase.product === 'string' ? purchase.product : (await products.create(purchase.product, tx)).id;
        items.push(await this.insert(tx, { productId, packages: purchase.packages, expiresOn: purchase.expiresOn }));
      }
      return items;
    });
  }

  /** Setting the quantity to zero is removing the row. */
  async update(id: string, change: { readonly quantity: number; readonly expiresOn: string | null }): Promise<void> {
    if (!(Number.isFinite(change.quantity) && change.quantity >= 0)) throw new Error('quantity must be zero or more');
    const now = this.clock.now();
    await this.db.run(
      `UPDATE pantry_items SET quantity = ?, expires_on = ?, updated_at = ?,
         deleted_at = CASE WHEN ? = 0 THEN ? ELSE NULL END
       WHERE id = ?`,
      [change.quantity, change.expiresOn, now, change.quantity, now, id],
    );
  }

  /** §10's one-tap Remove: quantity to zero and soft-deleted, with the undo to put it back. */
  async remove(id: string): Promise<PantryUndo> {
    return this.db.transaction(async (tx) => {
      const undo = await snapshot(tx, [id]);
      const now = this.clock.now();
      await tx.run('UPDATE pantry_items SET quantity = 0, deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
      return undo;
    });
  }

  async restore(undo: PantryUndo): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      for (const row of undo.rows) {
        await tx.run('UPDATE pantry_items SET quantity = ?, deleted_at = ?, updated_at = ? WHERE id = ?', [
          row.quantity,
          row.deletedAt,
          now,
          row.id,
        ]);
      }
    });
  }

  /**
   * §11's decrement for one serving's `needs`, in one transaction: each product drawn
   * from its rows oldest-expiry first, rows clamped at zero and soft-deleted when empty.
   * Returns what ran short and the undo that restores every touched row exactly.
   */
  async consume(needs: ReadonlyMap<string, number>): Promise<Consumption> {
    return this.db.transaction((tx) => consumeNeeds(tx, this.clock, needs));
  }

  /** Total live quantity per product — what the planner plans against (§5). */
  async stock(): Promise<Map<string, number>> {
    const rows = await this.db.all<PantryItemRow>(`SELECT ${ITEM_COLUMNS} FROM pantry_items WHERE deleted_at IS NULL`);
    return pantryStock(rows.map(toPantryItem));
  }

  async get(id: string): Promise<PantryItem | null> {
    const rows = await this.db.all<PantryItemRow>(`SELECT ${ITEM_COLUMNS} FROM pantry_items WHERE id = ?`, [id]);
    return rows[0] ? toPantryItem(rows[0]) : null;
  }

  private async insert(tx: SqlExecutor, entry: AddToPantry): Promise<PantryItem> {
    if (!(Number.isFinite(entry.packages) && entry.packages > 0)) throw new Error('packages must be more than zero');
    const products = await tx.all<ProductRow>('SELECT * FROM products WHERE id = ?', [entry.productId]);
    const product = products[0];
    if (!product) throw new Error(`no product ${entry.productId}`);
    const now = this.clock.now();
    const id = this.clock.newId();
    await tx.run(
      `INSERT INTO pantry_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, entry.productId, entry.packages * product.package_amount, entry.expiresOn, now, now],
    );
    const rows = await tx.all<PantryItemRow>(`SELECT ${ITEM_COLUMNS} FROM pantry_items WHERE id = ?`, [id]);
    return toPantryItem(rows[0]);
  }
}

export interface Consumption {
  readonly undo: PantryUndo;
  /** Products the pantry could not fully cover, and by how much (§11's "ran short"). */
  readonly shortfalls: readonly { readonly productId: string; readonly shortBy: number }[];
}

/** `PantryRepo.consume` inside a caller's transaction — cooking also stamps the plan slot. */
export async function consumeNeeds(tx: SqlExecutor, clock: Clock, needs: ReadonlyMap<string, number>): Promise<Consumption> {
  const touched: { id: string; quantity: number; deletedAt: string | null }[] = [];
  const shortfalls: { productId: string; shortBy: number }[] = [];
  const now = clock.now();
  for (const [productId, need] of needs) {
    const rows = (
      await tx.all<PantryItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM pantry_items WHERE product_id = ? AND deleted_at IS NULL AND quantity > 0`,
        [productId],
      )
    ).map(toPantryItem);
    const plan = planDepletion(rows, need);
    for (const step of plan.decrements) {
      touched.push({ id: step.rowId, quantity: step.from, deletedAt: null });
      await tx.run('UPDATE pantry_items SET quantity = ?, updated_at = ?, deleted_at = ? WHERE id = ?', [
        step.to,
        now,
        step.to === 0 ? now : null,
        step.rowId,
      ]);
    }
    if (plan.shortBy > 0) shortfalls.push({ productId, shortBy: plan.shortBy });
  }
  return { undo: { rows: touched }, shortfalls };
}

export async function snapshot(tx: SqlExecutor, ids: readonly string[]): Promise<PantryUndo> {
  const rows: { id: string; quantity: number; deletedAt: string | null }[] = [];
  for (const id of ids) {
    const found = await tx.all<PantryItemRow>(`SELECT ${ITEM_COLUMNS} FROM pantry_items WHERE id = ?`, [id]);
    if (found[0]) rows.push({ id, quantity: found[0].quantity, deletedAt: found[0].deleted_at });
  }
  return { rows };
}

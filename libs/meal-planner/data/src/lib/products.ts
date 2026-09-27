/**
 * The product catalog (meal-planner-spec.md §3 `products`, §7).
 *
 * Every scan, lookup and manual entry ends here, so the catalog becomes the person's own
 * list of what they buy — and a barcode seen once is never fetched again (§7: "never
 * re-fetch a barcode that exists locally").
 *
 * `get`/`getMany` return soft-deleted products too. A meal written against a product
 * that was later deleted still needs its nutrition; only the lists a person picks from
 * hide deleted rows.
 */

import { basisFor, productProblems, type Product, type ProductDraft } from '@metrum/meal-planner-domain';
import { recomputeMealsUsing } from './meals.js';
import { placeholders, toProduct, type ProductRow } from './rows.js';
import type { Clock, SqlDb, SqlExecutor } from './sql.js';

export class InvalidProductError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`product cannot be saved: ${problems.join(', ')}`);
  }
}

const COLUMNS = `id, barcode, name, brand, package_unit, package_amount, nutrition_basis,
  kcal, protein_g, source, created_at, updated_at, deleted_at`;

export class ProductsRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly clock: Clock,
  ) {}

  async create(draft: ProductDraft, tx: SqlExecutor = this.db): Promise<Product> {
    assertValid(draft);
    const now = this.clock.now();
    const id = this.clock.newId();
    await tx.run(
      `INSERT INTO products (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        blankToNull(draft.barcode),
        draft.name.trim(),
        blankToNull(draft.brand),
        draft.packageUnit,
        draft.packageAmount,
        basisFor(draft.packageUnit),
        draft.kcal,
        draft.proteinG,
        draft.source,
        now,
        now,
      ],
    );
    return (await this.get(id, tx)) as Product;
  }

  /** Also recomputes every meal that uses the product, so their cached nutrition stays true (§4). */
  async update(id: string, draft: Omit<ProductDraft, 'source'>): Promise<Product> {
    assertValid(draft);
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      await tx.run(
        `UPDATE products SET barcode = ?, name = ?, brand = ?, package_unit = ?, package_amount = ?,
           nutrition_basis = ?, kcal = ?, protein_g = ?, updated_at = ? WHERE id = ?`,
        [
          blankToNull(draft.barcode),
          draft.name.trim(),
          blankToNull(draft.brand),
          draft.packageUnit,
          draft.packageAmount,
          basisFor(draft.packageUnit),
          draft.kcal,
          draft.proteinG,
          now,
          id,
        ],
      );
      await recomputeMealsUsing(tx, [id], now);
    });
    const product = await this.get(id);
    if (!product) throw new Error(`no product ${id}`);
    return product;
  }

  async get(id: string, tx: SqlExecutor = this.db): Promise<Product | null> {
    const rows = await tx.all<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = ?`, [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async getMany(ids: readonly string[]): Promise<Map<string, Product>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.all<ProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE id IN (${placeholders(unique.length)})`,
      unique,
    );
    return new Map(rows.map((row) => [row.id, toProduct(row)]));
  }

  /** The live product with this barcode, newest first if the catalog somehow holds two. */
  async byBarcode(barcode: string): Promise<Product | null> {
    const rows = await this.db.all<ProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE barcode = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [barcode.trim()],
    );
    return rows[0] ? toProduct(rows[0]) : null;
  }

  /** Live products whose name or brand contains every word of `query`; all of them when it is blank. */
  async search(query: string, limit = 50): Promise<Product[]> {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const clauses = words.map(
      () => `AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(brand, '')) LIKE ? ESCAPE '\\')`,
    );
    const params = words.flatMap((w) => [`%${escapeLike(w)}%`, `%${escapeLike(w)}%`]);
    const rows = await this.db.all<ProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE deleted_at IS NULL ${clauses.join(' ')}
       ORDER BY name COLLATE NOCASE, id LIMIT ?`,
      [...params, limit],
    );
    return rows.map(toProduct);
  }

  /**
   * "Buy again" (design: groceries are overwhelmingly repeat purchases): live products
   * by their most recent pantry addition, newest first.
   */
  async recentlyBought(limit = 12): Promise<Product[]> {
    const rows = await this.db.all<ProductRow>(
      `SELECT ${COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ')}
         FROM products p
         JOIN (SELECT product_id, MAX(acquired_at) AS last FROM pantry_items GROUP BY product_id) r ON r.product_id = p.id
        WHERE p.deleted_at IS NULL
        ORDER BY r.last DESC, p.id LIMIT ?`,
      [limit],
    );
    return rows.map(toProduct);
  }

  async remove(id: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run('UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, id]);
  }
}

function assertValid(draft: Pick<ProductDraft, 'name' | 'packageAmount' | 'kcal' | 'proteinG'>): void {
  const problems = productProblems(draft);
  if (problems.length > 0) throw new InvalidProductError(problems);
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (c) => `\\${c}`);
}

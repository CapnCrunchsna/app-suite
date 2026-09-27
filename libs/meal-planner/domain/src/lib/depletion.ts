/**
 * meal-planner-spec.md §11: which pantry rows a cooked serving comes out of.
 *
 * Oldest `expiresOn` first with undated rows last, then oldest `acquiredAt` — so the
 * carton going off this week is used before the one bought yesterday. Each row is
 * clamped at zero, and a need larger than the stock is not an error: the meal was cooked,
 * the pantry was wrong, and the honest record is zero plus a note that it ran short.
 *
 * Pure: the data lib applies the result inside one transaction, and keeps the `from`
 * values so Undo restores exact quantities.
 */

export interface StockRow {
  readonly id: string;
  readonly quantity: number;
  readonly expiresOn: string | null;
  readonly acquiredAt: string;
}

export interface RowDecrement {
  readonly rowId: string;
  readonly from: number;
  /** Zero means the row is used up, and the data layer soft-deletes it. */
  readonly to: number;
}

export interface DepletionPlan {
  readonly decrements: readonly RowDecrement[];
  /** How much of the need the pantry could not cover; 0 when it could. */
  readonly shortBy: number;
}

const EPS = 1e-9;

export function depletionOrder(a: StockRow, b: StockRow): number {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  }
  if (a.acquiredAt !== b.acquiredAt) return a.acquiredAt < b.acquiredAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function planDepletion(rows: readonly StockRow[], need: number): DepletionPlan {
  let remaining = need;
  const decrements: RowDecrement[] = [];
  for (const row of [...rows].sort(depletionOrder)) {
    if (remaining <= EPS) break;
    if (row.quantity <= 0) continue;
    const take = Math.min(row.quantity, remaining);
    const to = row.quantity - take;
    decrements.push({ rowId: row.id, from: row.quantity, to: to <= EPS ? 0 : to });
    remaining -= take;
  }
  return { decrements, shortBy: remaining <= EPS ? 0 : remaining };
}

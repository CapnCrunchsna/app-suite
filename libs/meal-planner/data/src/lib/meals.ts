/**
 * The meal library (meal-planner-spec.md §3 `meals`/`meal_ingredients`, §4, §10).
 *
 * A meal's per-serving kcal and protein are cached on the row, because the planner reads
 * every meal on every Generate and summing ingredients each time is work repeated for
 * nothing. The cache is kept honest in two places: every write of a meal recomputes it,
 * and a product whose nutrition changes recomputes every meal that uses it
 * (`recomputeMealsUsing`, called from `ProductsRepo.update`). A meal whose person chose a
 * recipe site's figures (`nutrition_source = 'site'`) keeps them.
 *
 * Editing a meal replaces its ingredient list: the old lines are soft-deleted and the new
 * ones inserted, so the history a sync would need is never overwritten in place.
 */

import {
  mealNutritionPerServing,
  mealProblems,
  perServingNeeds,
  type Meal,
  type MealDraft,
  type MealIngredient,
  type PlannerMeal,
} from '@metrum/meal-planner-domain';
import { placeholders, toMeal, toMealIngredient, toProduct, type MealIngredientRow, type MealRow, type ProductRow } from './rows.js';
import type { Clock, SqlDb, SqlExecutor } from './sql.js';

export interface MealWithIngredients {
  readonly meal: Meal;
  readonly ingredients: readonly MealIngredient[];
}

export class InvalidMealError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`meal cannot be saved: ${problems.join(', ')}`);
  }
}

const MEAL_COLUMNS = `id, name, servings, slots, source, source_url, kcal_per_serving, protein_per_serving,
  nutrition_source, created_at, updated_at, deleted_at`;
const INGREDIENT_COLUMNS = `id, meal_id, product_id, quantity, unit, display_text, to_taste, position,
  created_at, updated_at, deleted_at`;

export class MealsRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly clock: Clock,
  ) {}

  /** Live meals by name — also the planner's tie-breaking order (§9 determinism). */
  async list(): Promise<Meal[]> {
    const rows = await this.db.all<MealRow>(
      `SELECT ${MEAL_COLUMNS} FROM meals WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`,
    );
    return rows.map(toMeal);
  }

  async get(id: string, ex: SqlExecutor = this.db): Promise<MealWithIngredients | null> {
    const meals = await ex.all<MealRow>(`SELECT ${MEAL_COLUMNS} FROM meals WHERE id = ?`, [id]);
    if (!meals[0]) return null;
    return { meal: toMeal(meals[0]), ingredients: await liveIngredients(ex, [id]) };
  }

  async create(draft: MealDraft, tx?: SqlExecutor): Promise<Meal> {
    assertValid(draft);
    const write = async (t: SqlExecutor) => {
      const id = this.clock.newId();
      const now = this.clock.now();
      await t.run(
        `INSERT INTO meals (${MEAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'ingredients', ?, ?, NULL)`,
        [id, draft.name.trim(), draft.servings, JSON.stringify(draft.slots), draft.source, draft.sourceUrl, now, now],
      );
      await this.insertIngredients(t, id, draft, now);
      await writeNutrition(t, id, draft.siteNutrition ?? null, now);
      return id;
    };
    const id = tx ? await write(tx) : await this.db.transaction(write);
    return (await this.get(id, tx))?.meal as Meal;
  }

  async update(id: string, draft: Omit<MealDraft, 'source' | 'sourceUrl'>): Promise<Meal> {
    assertValid(draft);
    await this.db.transaction(async (t) => {
      const now = this.clock.now();
      await t.run('UPDATE meals SET name = ?, servings = ?, slots = ?, updated_at = ? WHERE id = ?', [
        draft.name.trim(),
        draft.servings,
        JSON.stringify(draft.slots),
        now,
        id,
      ]);
      await t.run('UPDATE meal_ingredients SET deleted_at = ?, updated_at = ? WHERE meal_id = ? AND deleted_at IS NULL', [
        now,
        now,
        id,
      ]);
      await this.insertIngredients(t, id, draft, now);
      await writeNutrition(t, id, draft.siteNutrition ?? null, now);
    });
    const saved = await this.get(id);
    if (!saved) throw new Error(`no meal ${id}`);
    return saved.meal;
  }

  async remove(id: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run('UPDATE meals SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, id]);
  }

  /** Undo for `remove`. */
  async restore(id: string): Promise<void> {
    await this.db.run('UPDATE meals SET deleted_at = NULL, updated_at = ? WHERE id = ?', [this.clock.now(), id]);
  }

  /** Every live meal with one serving's draw on the pantry, in `list()` order (§9's input). */
  async plannerMeals(): Promise<PlannerMeal[]> {
    const meals = await this.list();
    const rows = await this.db.all<MealIngredientRow>(
      `SELECT ${INGREDIENT_COLUMNS.split(',').map((c) => `i.${c.trim()}`).join(', ')}
         FROM meal_ingredients i JOIN meals m ON m.id = i.meal_id
        WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL
        ORDER BY i.meal_id, i.position`,
    );
    const ingredients = rows.map(toMealIngredient);
    const byMeal = new Map<string, MealIngredient[]>();
    for (const line of ingredients) byMeal.set(line.mealId, [...(byMeal.get(line.mealId) ?? []), line]);
    return meals.map((meal) => ({
      id: meal.id,
      kcal: meal.kcalPerServing,
      protein: meal.proteinPerServing,
      slots: meal.slots,
      needs: perServingNeeds(byMeal.get(meal.id) ?? [], meal.servings),
    }));
  }

  private async insertIngredients(t: SqlExecutor, mealId: string, draft: Pick<MealDraft, 'ingredients'>, now: string) {
    let position = 0;
    for (const line of draft.ingredients) {
      await t.run(
        `INSERT INTO meal_ingredients (${INGREDIENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          this.clock.newId(),
          mealId,
          line.toTaste ? null : line.productId,
          line.toTaste ? null : line.quantity,
          line.toTaste ? null : line.unit,
          line.displayText.trim() || '(unnamed)',
          line.toTaste ? 1 : 0,
          position++,
          now,
          now,
        ],
      );
    }
  }
}

/**
 * Recompute the cached nutrition of every live meal that uses any of `productIds`, except
 * those whose figures the person took from a recipe site.
 */
export async function recomputeMealsUsing(tx: SqlExecutor, productIds: readonly string[], now: string): Promise<void> {
  if (productIds.length === 0) return;
  const rows = await tx.all<{ meal_id: string }>(
    `SELECT DISTINCT i.meal_id FROM meal_ingredients i JOIN meals m ON m.id = i.meal_id
      WHERE i.deleted_at IS NULL AND m.deleted_at IS NULL AND m.nutrition_source = 'ingredients'
        AND i.product_id IN (${placeholders(productIds.length)})`,
    [...productIds],
  );
  for (const row of rows) await writeNutrition(tx, row.meal_id, null, now);
}

async function writeNutrition(
  tx: SqlExecutor,
  mealId: string,
  site: { readonly kcal: number; readonly protein: number } | null,
  now: string,
): Promise<void> {
  let kcal: number;
  let protein: number;
  if (site) {
    ({ kcal, protein } = site);
  } else {
    const meal = (await tx.all<MealRow>(`SELECT ${MEAL_COLUMNS} FROM meals WHERE id = ?`, [mealId]))[0];
    const lines = await liveIngredients(tx, [mealId]);
    const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => id !== null))];
    const products = ids.length
      ? await tx.all<ProductRow>(`SELECT * FROM products WHERE id IN (${placeholders(ids.length)})`, ids)
      : [];
    ({ kcal, protein } = mealNutritionPerServing(lines, new Map(products.map((p) => [p.id, toProduct(p)])), meal.servings));
  }
  await tx.run(
    'UPDATE meals SET kcal_per_serving = ?, protein_per_serving = ?, nutrition_source = ?, updated_at = ? WHERE id = ?',
    [kcal, protein, site ? 'site' : 'ingredients', now, mealId],
  );
}

async function liveIngredients(tx: SqlExecutor, mealIds: readonly string[]): Promise<MealIngredient[]> {
  if (mealIds.length === 0) return [];
  const rows = await tx.all<MealIngredientRow>(
    `SELECT ${INGREDIENT_COLUMNS} FROM meal_ingredients
      WHERE deleted_at IS NULL AND meal_id IN (${placeholders(mealIds.length)})
      ORDER BY meal_id, position`,
    [...mealIds],
  );
  return rows.map(toMealIngredient);
}

function assertValid(draft: Pick<MealDraft, 'name' | 'servings' | 'slots' | 'ingredients'>): void {
  const problems = mealProblems(draft);
  if (problems.length > 0) throw new InvalidMealError(problems);
}

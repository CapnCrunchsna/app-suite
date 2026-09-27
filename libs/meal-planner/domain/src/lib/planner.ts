/**
 * The planner engine, meal-planner-spec.md §9 — exactly, because §14's T5–T7 pin its
 * output to the second decimal.
 *
 * ## Shape of the search
 *
 * Depth-first over the slots in order, one meal per slot, each meal at most once per plan.
 * A branch carries a reservation map of what its meals draw from the pantry, so a plan is
 * only complete when *all* its meals fit together (§5). A branch is pruned when even the
 * cheapest remaining candidates would overshoot the budget. Complete plans are kept if
 * they land in the active level's calorie window and meet its protein floor.
 *
 * Levels relax in order — tighter calorie window first, then a looser one, then no protein
 * floor — and the first level that yields anything wins. Level 3 is not a search: it is a
 * greedy fill that always returns exactly one plan, possibly with empty slots, so the
 * person is never shown nothing.
 *
 * ## Determinism
 *
 * No randomness (§13.7). Every tie is broken by the order of `input.meals`, which the
 * caller fixes. The same library, pantry and budget always produce the same plans — the
 * property that lets "Swap" be a deliberate act rather than a reroll.
 */

import { fitsWithReserved, isMakeable, type PantryStock, type ServingNeeds } from './pantry.js';
import type { SlotType } from './types.js';

export interface PlannerMeal {
  readonly id: string;
  readonly kcal: number;
  readonly protein: number;
  readonly slots: readonly SlotType[];
  /** One serving's draw on the pantry (`perServingNeeds`). */
  readonly needs: ServingNeeds;
}

export interface PlannerInput {
  readonly kcalBudget: number;
  readonly proteinTarget: number;
  readonly slots: readonly SlotType[];
  /** Slot index → meal id. A pinned meal is used even where its slot types say otherwise. */
  readonly pinned?: ReadonlyMap<number, string>;
  /** Order matters: it breaks every tie. */
  readonly meals: readonly PlannerMeal[];
  readonly pantry: PantryStock;
}

export type ConstraintLevel = 0 | 1 | 2 | 3;

export interface RankedPlan {
  /** Aligned with `input.slots`; null only in a partial level-3 plan. */
  readonly mealIds: readonly (string | null)[];
  readonly kcal: number;
  readonly protein: number;
  readonly score: number;
  readonly partial: boolean;
  readonly proteinShortBy: number;
}

export interface PlanResult {
  readonly level: ConstraintLevel;
  readonly plans: readonly RankedPlan[];
}

/** Every number §9 fixes, in one place. */
export const PLANNER_RULES = {
  levels: [
    { calorieFloor: 0.9, proteinFloor: 0.9 },
    { calorieFloor: 0.8, proteinFloor: 0.9 },
    { calorieFloor: 0.8, proteinFloor: null },
  ],
  candidateCap: 40,
  nodeCap: 50_000,
  poolSize: 10,
  picks: 3,
  overlapPenalty: 0.1,
  calorieWeight: 0.6,
  proteinWeight: 0.4,
  slotShare: { breakfast: 0.25, lunch: 0.3, dinner: 0.35, snacks: 0.1 },
} as const;

const EPS = 1e-9;

/**
 * Each slot's share of the budget: breakfast .25, lunch .30, dinner .35, and .10 split
 * across however many snacks there are — normalized over the slots actually present, so
 * a day without breakfast gives its share to the rest.
 */
export function slotShares(slots: readonly SlotType[]): number[] {
  const share = PLANNER_RULES.slotShare;
  const snacks = slots.filter((s) => s === 'snack').length;
  const raw = slots.map((s) => (s === 'snack' ? share.snacks / snacks : share[s]));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => (sum > 0 ? r / sum : 0));
}

export function scorePlan(kcal: number, protein: number, budget: number, floor: number, proteinTarget: number): number {
  const span = budget - floor;
  const calorieScore = span > 0 ? 1 - (budget - kcal) / span : 1;
  const proteinScore = proteinTarget > 0 ? Math.min(protein / proteinTarget, 1) : 1;
  return PLANNER_RULES.calorieWeight * calorieScore + PLANNER_RULES.proteinWeight * proteinScore;
}

export function generatePlans(input: PlannerInput): PlanResult {
  if (input.slots.length === 0) return { level: 0, plans: [] };
  const candidates = candidateLists(input);

  for (const [index, level] of PLANNER_RULES.levels.entries()) {
    const floor = level.calorieFloor * input.kcalBudget;
    const proteinMin = level.proteinFloor === null ? null : level.proteinFloor * input.proteinTarget;
    const pool = search(candidates, input, floor, proteinMin);
    if (pool.length === 0) continue;
    return { level: index as ConstraintLevel, plans: diversify(pool) };
  }

  return { level: 3, plans: [bestEffort(input)] };
}

/**
 * Per slot: the makeable meals eligible for it, in input order. A pinned slot's only
 * candidate is its pinned meal, if the pantry can make it. Past 40 candidates, the 40
 * closest in kcal to the slot's share of the budget are kept.
 */
function candidateLists(input: PlannerInput): PlannerMeal[][] {
  const byId = new Map(input.meals.map((m) => [m.id, m]));
  const makeable = input.meals.filter((m) => isMakeable(m.needs, input.pantry));
  const shares = slotShares(input.slots);

  return input.slots.map((slot, i) => {
    const pinnedId = input.pinned?.get(i);
    if (pinnedId !== undefined) {
      const meal = byId.get(pinnedId);
      return meal && isMakeable(meal.needs, input.pantry) ? [meal] : [];
    }
    const eligible = makeable.filter((m) => m.slots.includes(slot));
    if (eligible.length <= PLANNER_RULES.candidateCap) return eligible;
    const target = shares[i] * input.kcalBudget;
    return eligible
      .map((meal, order) => ({ meal, order, distance: Math.abs(meal.kcal - target) }))
      .sort((a, b) => a.distance - b.distance || a.order - b.order)
      .slice(0, PLANNER_RULES.candidateCap)
      .sort((a, b) => a.order - b.order)
      .map((c) => c.meal);
  });
}

/**
 * The passing plans the diversity pick draws from: the best `poolSize` by score, ties in
 * the order found — exactly the head of a stable sort of every passing plan, without
 * keeping or sorting the rest. A loose budget can pass hundreds of thousands of plans,
 * and storing them all was most of the planner's time.
 */
function addToPool(pool: RankedPlan[], plan: RankedPlan): void {
  const size = PLANNER_RULES.poolSize;
  if (pool.length === size && plan.score <= pool[size - 1].score + EPS) return;
  let at = pool.length;
  while (at > 0 && plan.score > pool[at - 1].score + EPS) at--;
  pool.splice(at, 0, plan);
  if (pool.length > size) pool.pop();
}

function search(
  candidates: readonly PlannerMeal[][],
  input: PlannerInput,
  floor: number,
  proteinMin: number | null,
): RankedPlan[] {
  const budget = input.kcalBudget;
  const n = candidates.length;
  if (candidates.some((c) => c.length === 0)) return [];

  // minRest[i]: the least kcal slots i..n-1 can possibly add — the pruning bound.
  const minRest = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    minRest[i] = minRest[i + 1] + Math.min(...candidates[i].map((m) => m.kcal));
  }

  const pool: RankedPlan[] = [];
  const chosen: PlannerMeal[] = [];
  const used = new Set<string>();
  const reserved = new Map<string, number>();
  let nodes = 0;

  const visit = (i: number, kcal: number, protein: number): void => {
    if (i === n) {
      if (kcal < floor - EPS || kcal > budget + EPS) return;
      if (proteinMin !== null && protein < proteinMin - EPS) return;
      const score = scorePlan(kcal, protein, budget, floor, input.proteinTarget);
      if (pool.length === PLANNER_RULES.poolSize && score <= pool[pool.length - 1].score + EPS) return;
      addToPool(pool, {
        mealIds: chosen.map((m) => m.id),
        kcal,
        protein,
        score,
        partial: false,
        proteinShortBy: Math.max(0, input.proteinTarget - protein),
      });
      return;
    }
    for (const meal of candidates[i]) {
      if (nodes >= PLANNER_RULES.nodeCap) return;
      if (used.has(meal.id)) continue;
      if (kcal + meal.kcal + minRest[i + 1] > budget + EPS) continue;
      if (!fitsWithReserved(meal.needs, reserved, input.pantry)) continue;
      nodes++;
      reserve(reserved, meal.needs, 1);
      used.add(meal.id);
      chosen.push(meal);
      visit(i + 1, kcal + meal.kcal, protein + meal.protein);
      chosen.pop();
      used.delete(meal.id);
      reserve(reserved, meal.needs, -1);
    }
  };

  visit(0, 0, 0);
  return pool;
}

function reserve(reserved: Map<string, number>, needs: ServingNeeds, sign: 1 | -1): void {
  for (const [productId, need] of needs) {
    reserved.set(productId, (reserved.get(productId) ?? 0) + sign * need);
  }
}

/** Shared meals between two plans, the unit of §9's diversity penalty. */
function sharedMeals(a: RankedPlan, b: RankedPlan): number {
  const other = new Set(b.mealIds.filter((id): id is string => id !== null));
  return a.mealIds.filter((id) => id !== null && other.has(id)).length;
}

/**
 * Up to three plans from the top ten: the best, then whichever maximizes its score minus
 * 0.1 per meal it shares with each plan already picked. Ties keep pool order.
 */
function diversify(ranked: readonly RankedPlan[]): RankedPlan[] {
  const remaining = ranked.slice(0, PLANNER_RULES.poolSize);
  const selected: RankedPlan[] = [];
  while (selected.length < PLANNER_RULES.picks && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    remaining.forEach((plan, index) => {
      const overlap = selected.reduce((sum, picked) => sum + sharedMeals(plan, picked), 0);
      const value = plan.score - PLANNER_RULES.overlapPenalty * overlap;
      if (value > bestValue + EPS) {
        bestValue = value;
        bestIndex = index;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

/**
 * Level 3 (§9): pinned meals first, if they still fit; then each open slot, in order,
 * takes the highest-kcal eligible meal that is unused, fits the pantry alongside what is
 * already placed, and fits what is left of the budget. A slot nothing fits stays empty.
 */
function bestEffort(input: PlannerInput): RankedPlan {
  const budget = input.kcalBudget;
  const byId = new Map(input.meals.map((m) => [m.id, m]));
  const mealIds: (string | null)[] = input.slots.map(() => null);
  const used = new Set<string>();
  const reserved = new Map<string, number>();
  let kcal = 0;
  let protein = 0;

  const fits = (meal: PlannerMeal) =>
    !used.has(meal.id) &&
    kcal + meal.kcal <= budget + EPS &&
    fitsWithReserved(meal.needs, reserved, input.pantry);

  const place = (i: number, meal: PlannerMeal) => {
    mealIds[i] = meal.id;
    used.add(meal.id);
    reserve(reserved, meal.needs, 1);
    kcal += meal.kcal;
    protein += meal.protein;
  };

  const pinnedSlots = [...(input.pinned ?? new Map<number, string>())].sort((a, b) => a[0] - b[0]);
  for (const [i, mealId] of pinnedSlots) {
    const meal = byId.get(mealId);
    if (meal && i < mealIds.length && fits(meal)) place(i, meal);
  }

  input.slots.forEach((slot, i) => {
    if (input.pinned?.has(i)) return;
    let best: PlannerMeal | null = null;
    for (const meal of input.meals) {
      if (!meal.slots.includes(slot) || !fits(meal)) continue;
      if (best === null || meal.kcal > best.kcal + EPS) best = meal;
    }
    if (best) place(i, best);
  });

  return {
    mealIds,
    kcal,
    protein,
    score: scorePlan(kcal, protein, budget, 0, input.proteinTarget),
    partial: mealIds.some((id) => id === null),
    proteinShortBy: Math.max(0, input.proteinTarget - protein),
  };
}

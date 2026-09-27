/**
 * meal-planner-spec.md §14 T5–T7, with the spec's numbers. If one of these fails, the
 * planner is wrong, not the test: the expected values were derived by hand from §9.
 */

import { generatePlans, slotShares, type PlannerMeal } from './planner.js';
import type { SlotType } from './types.js';

const B: SlotType = 'breakfast';
const L: SlotType = 'lunch';
const D: SlotType = 'dinner';
const S: SlotType = 'snack';

const meal = (id: string, kcal: number, protein: number, slots: SlotType[], needs: [string, number][] = []): PlannerMeal => ({
  id,
  kcal,
  protein,
  slots,
  needs: new Map(needs),
});

/** T5's library. Ample pantry: none of these meals draws on it. */
const LIBRARY: PlannerMeal[] = [
  meal('oatmeal', 350, 12, [B]),
  meal('eggs', 250, 13, [B]),
  meal('pbj', 400, 15, [B, L]),
  meal('chicken-rice', 600, 45, [L, D]),
  meal('tuna', 450, 30, [L]),
  meal('spaghetti', 700, 35, [D]),
  meal('yogurt', 150, 15, [S]),
  meal('apple-pb', 280, 8, [S]),
];

const DAY: SlotType[] = [B, L, D, S];

describe('T5 — level 0', () => {
  const result = generatePlans({
    kcalBudget: 2000,
    proteinTarget: 100,
    slots: DAY,
    meals: LIBRARY,
    pantry: new Map(),
  });

  it('solves at level 0', () => {
    expect(result.level).toBe(0);
  });

  it('picks rows 1, 2 and 3 of the five passing plans, in that order', () => {
    expect(result.plans.map((p) => p.mealIds)).toEqual([
      ['pbj', 'chicken-rice', 'spaghetti', 'apple-pb'],
      ['oatmeal', 'chicken-rice', 'spaghetti', 'apple-pb'],
      ['pbj', 'chicken-rice', 'spaghetti', 'yogurt'],
    ]);
  });

  it('scores them 0.94, 0.79 and 0.55 with the spec totals', () => {
    const [first, second, third] = result.plans;
    expect(first.kcal).toBe(1980);
    expect(first.protein).toBe(103);
    expect(first.score).toBeCloseTo(0.94, 10);
    expect(second.kcal).toBe(1930);
    expect(second.protein).toBe(100);
    expect(second.score).toBeCloseTo(0.79, 10);
    expect(third.kcal).toBe(1850);
    expect(third.protein).toBe(110);
    expect(third.score).toBeCloseTo(0.55, 10);
  });

  /**
   * The diversity pick shows three of the five, so each passing plan is checked on its
   * own by pinning all four of its slots — which leaves it the only candidate — and the
   * snack pin below shows no plan outside the spec's list gets through.
   */
  it('finds exactly the five passing plans the spec lists', () => {
    const passing = [
      ['pbj', 'chicken-rice', 'spaghetti', 'apple-pb', 0.94],
      ['oatmeal', 'chicken-rice', 'spaghetti', 'apple-pb', 0.79],
      ['pbj', 'chicken-rice', 'spaghetti', 'yogurt', 0.55],
      ['eggs', 'chicken-rice', 'spaghetti', 'apple-pb', 0.49],
      ['oatmeal', 'chicken-rice', 'spaghetti', 'yogurt', 0.4],
    ] as const;
    for (const [b, l, d, s, score] of passing) {
      const pinned = new Map([
        [0, b],
        [1, l],
        [2, d],
        [3, s],
      ]);
      const only = generatePlans({ kcalBudget: 2000, proteinTarget: 100, slots: DAY, meals: LIBRARY, pantry: new Map(), pinned });
      expect(only.level).toBe(0);
      expect(only.plans).toHaveLength(1);
      expect(only.plans[0].score).toBeCloseTo(score, 10);
    }
    const yogurtDays = generatePlans({
      kcalBudget: 2000,
      proteinTarget: 100,
      slots: DAY,
      meals: LIBRARY,
      pantry: new Map(),
      pinned: new Map([[3, 'yogurt']]),
    });
    expect(yogurtDays.plans.map((p) => p.mealIds)).toEqual([
      ['pbj', 'chicken-rice', 'spaghetti', 'yogurt'],
      ['oatmeal', 'chicken-rice', 'spaghetti', 'yogurt'],
    ]);
  });
});

describe('T6 — pinned lunch forces level 1', () => {
  const result = generatePlans({
    kcalBudget: 2000,
    proteinTarget: 100,
    slots: DAY,
    meals: LIBRARY,
    pantry: new Map(),
    pinned: new Map([[1, 'tuna']]),
  });

  it('finds nothing at level 0 and solves at level 1', () => {
    expect(result.level).toBe(1);
  });

  it('ranks PB&J / Tuna / Chicken & rice / Apple + PB first at 0.587', () => {
    const top = result.plans[0];
    expect(top.mealIds).toEqual(['pbj', 'tuna', 'chicken-rice', 'apple-pb']);
    expect(top.kcal).toBe(1730);
    expect(top.protein).toBe(98);
    expect(top.score).toBeCloseTo(0.587, 10);
  });

  it('keeps the pin in every plan it offers', () => {
    for (const plan of result.plans) expect(plan.mealIds[1]).toBe('tuna');
  });
});

describe('T7 — plan feasibility', () => {
  const pair = (eggs: number) =>
    generatePlans({
      kcalBudget: 1000,
      proteinTarget: 60,
      slots: [L, D],
      meals: [meal('a', 500, 30, [L, D], [['egg', 2]]), meal('b', 500, 30, [L, D], [['egg', 2]])],
      pantry: new Map([['egg', eggs]]),
    });

  it('plans both meals at level 0 when the eggs cover both', () => {
    const result = pair(4);
    expect(result.level).toBe(0);
    expect(result.plans[0].mealIds).toEqual(['a', 'b']);
    expect(result.plans[0].score).toBeCloseTo(1, 10);
  });

  it('never plans both on three eggs, and falls back to one meal at level 3', () => {
    const result = pair(3);
    expect(result.level).toBe(3);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].mealIds).toEqual(['a', null]);
    expect(result.plans[0].partial).toBe(true);
    expect(result.plans[0].kcal).toBe(500);
  });
});

describe('level 3', () => {
  it('fills with the largest meal that fits the budget left, leaving misfits empty', () => {
    const result = generatePlans({
      kcalBudget: 700,
      proteinTarget: 100,
      slots: [B, D],
      meals: LIBRARY,
      pantry: new Map(),
    });
    expect(result.level).toBe(3);
    // 400 (PB&J) is the largest breakfast; then no dinner fits in the remaining 300.
    expect(result.plans[0].mealIds).toEqual(['pbj', null]);
  });

  it('places a pinned meal before the open slots claim the budget', () => {
    const result = generatePlans({
      kcalBudget: 900,
      proteinTarget: 100,
      slots: [B, D],
      meals: LIBRARY,
      pantry: new Map(),
      pinned: new Map([[1, 'spaghetti']]),
    });
    expect(result.level).toBe(3);
    expect(result.plans[0].mealIds).toEqual([null, 'spaghetti']);
  });
});

describe('candidates', () => {
  it('leaves out a meal the pantry cannot make', () => {
    const result = generatePlans({
      kcalBudget: 1000,
      proteinTarget: 0,
      slots: [L],
      meals: [meal('big', 950, 10, [L], [['beef', 500]]), meal('small', 920, 5, [L])],
      pantry: new Map([['beef', 100]]),
    });
    expect(result.plans.map((p) => p.mealIds)).toEqual([['small']]);
  });

  it('uses a pinned meal in a slot its types do not name', () => {
    const result = generatePlans({
      kcalBudget: 2000,
      proteinTarget: 100,
      slots: DAY,
      meals: LIBRARY,
      pantry: new Map(),
      pinned: new Map([[0, 'chicken-rice']]),
    });
    for (const plan of result.plans) expect(plan.mealIds[0]).toBe('chicken-rice');
  });
});

describe('slotShares', () => {
  it('uses the spec shares for a full day', () => {
    const shares = slotShares(DAY);
    expect(shares[0]).toBeCloseTo(0.25, 10);
    expect(shares[1]).toBeCloseTo(0.3, 10);
    expect(shares[2]).toBeCloseTo(0.35, 10);
    expect(shares[3]).toBeCloseTo(0.1, 10);
  });

  it('splits the snack share and renormalizes to one', () => {
    const shares = slotShares([L, D, S, S]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(shares[2]).toBeCloseTo(shares[3], 10);
    expect(shares[1] / shares[0]).toBeCloseTo(0.35 / 0.3, 10);
  });
});

it('is deterministic', () => {
  const input = { kcalBudget: 2000, proteinTarget: 100, slots: DAY, meals: LIBRARY, pantry: new Map() };
  expect(generatePlans(input)).toEqual(generatePlans(input));
});

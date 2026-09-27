import type { PlannerMeal } from './planner.js';
import { dayTotals, replanDay, type DaySlot } from './replan.js';
import type { SlotType } from './types.js';

const meal = (id: string, kcal: number, protein: number, slots: SlotType[], needs: [string, number][] = []): PlannerMeal => ({
  id,
  kcal,
  protein,
  slots,
  needs: new Map(needs),
});

/** T5's library again. */
const LIBRARY = [
  meal('oatmeal', 350, 12, ['breakfast']),
  meal('eggs', 250, 13, ['breakfast'], [['egg', 2]]),
  meal('pbj', 400, 15, ['breakfast', 'lunch']),
  meal('chicken-rice', 600, 45, ['lunch', 'dinner']),
  meal('tuna', 450, 30, ['lunch']),
  meal('spaghetti', 700, 35, ['dinner']),
  meal('yogurt', 150, 15, ['snack']),
  meal('apple-pb', 280, 8, ['snack']),
];

const slot = (slotType: SlotType, mealId: string | null, flags: Partial<Pick<DaySlot, 'pinned' | 'cooked'>> = {}): DaySlot => ({
  slotType,
  mealId,
  pinned: flags.pinned ?? false,
  cooked: flags.cooked ?? false,
});

describe('replanDay', () => {
  it('on an open day is exactly T5', () => {
    const day = {
      kcalBudget: 2000,
      proteinTarget: 100,
      slots: [slot('breakfast', null), slot('lunch', null), slot('dinner', null), slot('snack', null)],
    };
    const result = replanDay(day, LIBRARY, new Map([['egg', 12]]));
    expect(result.level).toBe(0);
    expect(result.options[0].mealIds).toEqual(['pbj', 'chicken-rice', 'spaghetti', 'apple-pb']);
    expect(result.options[0].kcal).toBe(1980);
  });

  it('keeps a pin in place, as T6 does', () => {
    const day = {
      kcalBudget: 2000,
      proteinTarget: 100,
      slots: [slot('breakfast', 'oatmeal'), slot('lunch', 'tuna', { pinned: true }), slot('dinner', null), slot('snack', null)],
    };
    const result = replanDay(day, LIBRARY, new Map([['egg', 12]]));
    expect(result.level).toBe(1);
    expect(result.options[0].mealIds).toEqual(['pbj', 'tuna', 'chicken-rice', 'apple-pb']);
  });

  it('takes a cooked meal off the budget and out of the search, and keeps it in the day', () => {
    // Breakfast (PB&J, 400/15) is eaten: the rest must fit 1600 kcal and 85 g protein.
    const day = {
      kcalBudget: 2000,
      proteinTarget: 100,
      slots: [slot('breakfast', 'pbj', { cooked: true }), slot('lunch', null), slot('dinner', null), slot('snack', null)],
    };
    const result = replanDay(day, LIBRARY, new Map());
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(option.mealIds[0]).toBe('pbj');
      expect(option.kcal).toBeLessThanOrEqual(2000);
      expect(option.kcal - 400).toBeLessThanOrEqual(1600);
      // PB&J is eligible for lunch but already used today.
      expect(option.mealIds.slice(1)).not.toContain('pbj');
    }
  });

  it('does not reserve a cooked meal’s ingredients a second time', () => {
    // Two eggs left after cooking scrambled eggs; the eggs are out of the pantry already.
    const day = { kcalBudget: 600, proteinTarget: 0, slots: [slot('breakfast', 'eggs', { cooked: true }), slot('lunch', null)] };
    const lunches = [meal('egg-salad', 350, 20, ['lunch'], [['egg', 2]])];
    const result = replanDay(day, [...LIBRARY, ...lunches], new Map([['egg', 2]]));
    expect(result.options[0].mealIds).toEqual(['eggs', 'egg-salad']);
  });
});

it('totals whatever is assigned', () => {
  const meals = new Map(LIBRARY.map((m) => [m.id, m]));
  expect(dayTotals(['oatmeal', null, 'spaghetti'], meals)).toEqual({ kcal: 1050, protein: 47 });
});

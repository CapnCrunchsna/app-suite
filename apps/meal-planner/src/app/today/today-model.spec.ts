import type { DayOption, PlanSlot, RankedPlan } from '@metrum/meal-planner-domain';
import type { PlanWithSlots } from '@metrum/meal-planner-data';
import { addDays, assignmentFor, constraintNote, countsOf, dateLabel, generateDay, isCurrent, sameShape, swapDay } from './today-model';

const TARGETS = { kcalBudget: 2000, proteinTarget: 100 };

function slot(position: number, over: Partial<PlanSlot>): PlanSlot {
  return { id: `s${position}`, planId: 'p', slotType: 'lunch', position, mealId: null, pinned: false, cookedAt: null, updatedAt: '', ...over };
}

const SAVED: PlanWithSlots = {
  plan: { id: 'p', planDate: '2026-09-27', ...TARGETS, createdAt: '', updatedAt: '', deletedAt: null },
  slots: [
    slot(0, { slotType: 'breakfast', mealId: 'oats', cookedAt: '2026-09-27T08:00:00Z' }),
    slot(1, { slotType: 'lunch', mealId: 'wrap', pinned: true }),
    slot(2, { slotType: 'dinner', mealId: 'chili' }),
    slot(3, { slotType: 'snack', mealId: null }),
  ],
};

function option(mealIds: (string | null)[], over: Partial<RankedPlan> = {}): DayOption {
  const plan: RankedPlan = { mealIds, kcal: 0, protein: 0, score: 0, partial: false, proteinShortBy: 0, ...over };
  return { mealIds, kcal: plan.kcal, protein: plan.protein, plan };
}

describe('generateDay', () => {
  it('holds cooked and pinned slots and re-solves the rest on a same-shaped day', () => {
    const day = generateDay(TARGETS, ['breakfast', 'lunch', 'dinner', 'snack'], SAVED);
    expect(day.slots.map((s) => [s.mealId, s.pinned, s.cooked])).toEqual([
      ['oats', false, true],
      ['wrap', true, false],
      ['chili', false, false],
      [null, false, false],
    ]);
  });

  it('starts from nothing when the shape changed', () => {
    const day = generateDay(TARGETS, ['breakfast', 'lunch', 'dinner'], SAVED);
    expect(sameShape(SAVED, ['breakfast', 'lunch', 'dinner'])).toBe(false);
    expect(day.slots.every((s) => s.mealId === null && !s.pinned && !s.cooked)).toBe(true);
  });
});

describe('swapDay', () => {
  it('opens only the swapped slot and any empty one, holding everything placed', () => {
    const day = swapDay(SAVED, 2);
    expect(day.slots.map((s) => [s.mealId, s.pinned, s.cooked])).toEqual([
      ['oats', true, true],
      ['wrap', true, false],
      [null, false, false],
      [null, false, false],
    ]);
  });
});

describe('choosing a card', () => {
  it('recognizes the day it already has', () => {
    expect(isCurrent(SAVED, option(['oats', 'wrap', 'chili', null]))).toBe(true);
    expect(isCurrent(SAVED, option(['oats', 'wrap', 'stew', null]))).toBe(false);
    expect(isCurrent(null, option(['oats']))).toBe(false);
  });

  it('writes only the changed, uncooked slots', () => {
    const changes = assignmentFor(SAVED, option(['eggs', 'wrap', 'stew', 'apple']));
    expect([...changes]).toEqual([
      ['s2', 'stew'],
      ['s3', 'apple'],
    ]);
  });

  it('reads the slot counts back off a saved plan', () => {
    expect(countsOf(SAVED)).toEqual({ meals: 3, snacks: 1 });
  });
});

describe('constraintNote', () => {
  it('labels each relaxed level as §10 words it', () => {
    expect(constraintNote(0, option([]), 100)).toBeNull();
    expect(constraintNote(1, option([]), 100)).toBe('relaxed calories');
    expect(constraintNote(2, option([], { protein: 82.6 }), 100)).toBe('protein short by 17 g');
    expect(constraintNote(2, option([], { protein: 100 }), 100)).toBe('relaxed calories');
    expect(constraintNote(3, option([null], { partial: true }), 100)).toBe('partial');
    expect(constraintNote(3, option(['a']), 100)).toBe('best effort');
  });
});

describe('dates', () => {
  it('steps across month ends in local time', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('names today and tomorrow', () => {
    expect(dateLabel('2026-09-27', '2026-09-27')).toBe('Today');
    expect(dateLabel('2026-09-28', '2026-09-27')).toBe('Tomorrow');
  });
});

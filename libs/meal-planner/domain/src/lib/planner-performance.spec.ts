/**
 * §12 Phase 3: "generating on a 200-meal library completes < 1 s on a mid-range phone".
 * A phone is not available to a unit test, so this holds the laptop to a fifth of that —
 * room for a phone several times slower — on the worst shape the planner sees: 200
 * meals, every one eligible for every slot, sharing ingredients, and a budget no
 * combination fits, so all three search levels run to their node cap before level 3.
 */

import { generatePlans, type PlannerMeal } from './planner.js';
import type { SlotType } from './types.js';

/** Deterministic pseudo-random numbers (mulberry32), so the library is the same every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL: SlotType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

function library(size: number): PlannerMeal[] {
  const next = random(42);
  return Array.from({ length: size }, (_, i) => ({
    id: `m${i}`,
    kcal: 150 + Math.round(next() * 700),
    protein: Math.round(next() * 50),
    slots: ALL,
    needs: new Map(Array.from({ length: 4 }, () => [`p${Math.floor(next() * 40)}`, 1 + Math.round(next() * 200)] as [string, number])),
  }));
}

it('plans a 200-meal library in well under a second', () => {
  const meals = library(200);
  const pantry = new Map(Array.from({ length: 40 }, (_, i) => [`p${i}`, 500]));
  for (const kcalBudget of [2000, 4000]) {
    const started = performance.now();
    const result = generatePlans({ kcalBudget, proteinTarget: 150, slots: ['breakfast', 'lunch', 'dinner', 'snack', 'snack'], meals, pantry });
    const elapsed = performance.now() - started;
    expect(result.plans.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  }
});

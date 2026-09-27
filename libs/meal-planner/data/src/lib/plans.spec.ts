import { nodeSqliteDb, testClock } from '../testing/node-sqlite-db.js';
import { migrate } from './migrations.js';
import { PlansRepo, type SlotAssignment } from './plans.js';

const TARGETS = { kcalBudget: 2000, proteinTarget: 100 };
const DAY: SlotAssignment[] = [
  { slotType: 'breakfast', mealId: 'oats', pinned: false },
  { slotType: 'lunch', mealId: 'wrap', pinned: true },
  { slotType: 'dinner', mealId: null, pinned: false },
];

async function setup() {
  const db = nodeSqliteDb();
  const clock = testClock();
  await migrate(db, clock);
  return { db, plans: new PlansRepo(db, clock) };
}

describe('PlansRepo', () => {
  it('has no plan for a date nothing was planned on', async () => {
    const { plans } = await setup();
    expect(await plans.forDate('2026-09-27')).toBeNull();
  });

  it('creates a plan with its slots in position order', async () => {
    const { plans } = await setup();
    const created = await plans.create('2026-09-27', TARGETS, DAY);
    expect(created.plan).toMatchObject({ planDate: '2026-09-27', kcalBudget: 2000, proteinTarget: 100, deletedAt: null });
    expect(created.slots.map((s) => [s.position, s.slotType, s.mealId, s.pinned, s.cookedAt])).toEqual([
      [0, 'breakfast', 'oats', false, null],
      [1, 'lunch', 'wrap', true, null],
      [2, 'dinner', null, false, null],
    ]);
    expect(await plans.forDate('2026-09-27')).toEqual(created);
  });

  it('keeps one live plan per date, soft-deleting the one it replaces', async () => {
    const { db, plans } = await setup();
    const first = await plans.create('2026-09-27', TARGETS, DAY);
    const second = await plans.create('2026-09-27', TARGETS, DAY.slice(0, 2));
    expect((await plans.forDate('2026-09-27'))?.plan.id).toBe(second.plan.id);
    expect((await plans.forDate('2026-09-27'))?.slots).toHaveLength(2);
    const rows = await db.all<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM plans ORDER BY created_at');
    expect(rows).toEqual([
      { id: first.plan.id, deleted_at: expect.any(String) },
      { id: second.plan.id, deleted_at: null },
    ]);
  });

  it('leaves other dates alone', async () => {
    const { plans } = await setup();
    const today = await plans.create('2026-09-27', TARGETS, DAY);
    await plans.create('2026-09-28', TARGETS, DAY);
    expect((await plans.forDate('2026-09-27'))?.plan.id).toBe(today.plan.id);
  });

  it('re-assigns slots in place and never touches a cooked one', async () => {
    const { db, plans } = await setup();
    const { slots } = await plans.create('2026-09-27', TARGETS, DAY);
    await db.run('UPDATE plan_slots SET cooked_at = ? WHERE id = ?', ['2026-09-27T08:00:00.000Z', slots[0].id]);
    await plans.assign(
      new Map([
        [slots[0].id, 'eggs'],
        [slots[2].id, 'chili'],
      ]),
    );
    const after = await plans.forDate('2026-09-27');
    expect(after?.slots.map((s) => s.mealId)).toEqual(['oats', 'wrap', 'chili']);
    expect(after?.slots.map((s) => s.id)).toEqual(slots.map((s) => s.id));
  });

  it('pins and unpins a slot', async () => {
    const { plans } = await setup();
    const { slots } = await plans.create('2026-09-27', TARGETS, DAY);
    await plans.setPinned(slots[0].id, true);
    await plans.setPinned(slots[1].id, false);
    expect((await plans.forDate('2026-09-27'))?.slots.map((s) => s.pinned)).toEqual([true, false, false]);
  });

  it('updates targets and soft-deletes on remove', async () => {
    const { plans } = await setup();
    const { plan } = await plans.create('2026-09-27', TARGETS, DAY);
    await plans.updateTargets(plan.id, { kcalBudget: 1800, proteinTarget: 120 });
    expect((await plans.forDate('2026-09-27'))?.plan).toMatchObject({ kcalBudget: 1800, proteinTarget: 120 });
    await plans.remove(plan.id);
    expect(await plans.forDate('2026-09-27')).toBeNull();
  });
});

/**
 * Day plans (meal-planner-spec.md §3 `plans`/`plan_slots`, §10 Today).
 *
 * One live plan per date. Its slots are fixed when the plan is created: re-planning a day
 * (Swap) changes which meal sits in each slot, in place. Changing the day's shape — how
 * many meals and snacks — makes a new plan and soft-deletes the old one, because
 * `plan_slots` has no deletion stamp of its own and rows are never hard-deleted (§2).
 */

import type { Plan, PlanSlot, SlotType } from '@metrum/meal-planner-domain';
import { consumeNeeds, restoreRows, type Consumption, type PantryUndo } from './pantry.js';
import { toPlan, toPlanSlot, type PlanRow, type PlanSlotRow } from './rows.js';
import { bool, type Clock, type SqlDb, type SqlExecutor } from './sql.js';

export interface PlanWithSlots {
  readonly plan: Plan;
  /** In position order. */
  readonly slots: readonly PlanSlot[];
}

export interface SlotAssignment {
  readonly slotType: SlotType;
  readonly mealId: string | null;
  readonly pinned: boolean;
}

const PLAN_COLUMNS = 'id, plan_date, kcal_budget, protein_target, created_at, updated_at, deleted_at';
const SLOT_COLUMNS = 'id, plan_id, slot_type, position, meal_id, pinned, cooked_at, updated_at';

export class PlansRepo {
  constructor(
    private readonly db: SqlDb,
    private readonly clock: Clock,
  ) {}

  async forDate(date: string, ex: SqlExecutor = this.db): Promise<PlanWithSlots | null> {
    const plans = await ex.all<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_date = ? AND deleted_at IS NULL`, [date]);
    return plans[0] ? this.withSlots(ex, toPlan(plans[0])) : null;
  }

  /** A new plan for `date`, replacing (soft-deleting) whatever live plan it had. */
  async create(
    date: string,
    targets: { readonly kcalBudget: number; readonly proteinTarget: number },
    slots: readonly SlotAssignment[],
  ): Promise<PlanWithSlots> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now();
      await tx.run('UPDATE plans SET deleted_at = ?, updated_at = ? WHERE plan_date = ? AND deleted_at IS NULL', [now, now, date]);
      const planId = this.clock.newId();
      await tx.run(`INSERT INTO plans (${PLAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL)`, [
        planId,
        date,
        targets.kcalBudget,
        targets.proteinTarget,
        now,
        now,
      ]);
      for (const [position, slot] of slots.entries()) {
        await tx.run(`INSERT INTO plan_slots (${SLOT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`, [
          this.clock.newId(),
          planId,
          slot.slotType,
          position,
          slot.mealId,
          bool(slot.pinned),
          now,
        ]);
      }
      return (await this.forDate(date, tx)) as PlanWithSlots;
    });
  }

  async updateTargets(planId: string, targets: { readonly kcalBudget: number; readonly proteinTarget: number }): Promise<void> {
    await this.db.run('UPDATE plans SET kcal_budget = ?, protein_target = ?, updated_at = ? WHERE id = ?', [
      targets.kcalBudget,
      targets.proteinTarget,
      this.clock.now(),
      planId,
    ]);
  }

  /** Swap's result: new meals for some slots, by slot id. Cooked slots are never touched. */
  async assign(meals: ReadonlyMap<string, string | null>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      for (const [slotId, mealId] of meals) {
        await tx.run('UPDATE plan_slots SET meal_id = ?, updated_at = ? WHERE id = ? AND cooked_at IS NULL', [mealId, now, slotId]);
      }
    });
  }

  async setPinned(slotId: string, pinned: boolean): Promise<void> {
    await this.db.run('UPDATE plan_slots SET pinned = ?, updated_at = ? WHERE id = ?', [bool(pinned), this.clock.now(), slotId]);
  }

  /**
   * §11's Mark cooked: one serving's `needs` come out of the pantry and the slot is
   * stamped, in one transaction. Idempotent — a slot already cooked (or gone) changes
   * nothing and returns null, so a double tap cannot decrement twice.
   */
  async cook(slotId: string, needs: ReadonlyMap<string, number>): Promise<Consumption | null> {
    return this.db.transaction(async (tx) => {
      const open = await tx.all<{ id: string }>('SELECT id FROM plan_slots WHERE id = ? AND cooked_at IS NULL', [slotId]);
      if (!open[0]) return null;
      const consumption = await consumeNeeds(tx, this.clock, needs);
      const now = this.clock.now();
      await tx.run('UPDATE plan_slots SET cooked_at = ?, updated_at = ? WHERE id = ?', [now, now, slotId]);
      return consumption;
    });
  }

  /** Undo for `cook`: the pantry rows back exactly as they were, and the slot uncooked. */
  async uncook(slotId: string, undo: PantryUndo): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now();
      await restoreRows(tx, now, undo);
      await tx.run('UPDATE plan_slots SET cooked_at = NULL, updated_at = ? WHERE id = ?', [now, slotId]);
    });
  }

  async remove(planId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.run('UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, planId]);
  }

  private async withSlots(ex: SqlExecutor, plan: Plan): Promise<PlanWithSlots> {
    const rows = await ex.all<PlanSlotRow>(`SELECT ${SLOT_COLUMNS} FROM plan_slots WHERE plan_id = ? ORDER BY position`, [plan.id]);
    return { plan, slots: rows.map(toPlanSlot) };
  }
}

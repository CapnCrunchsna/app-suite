/**
 * The key/value `settings` table (meal-planner-spec.md §3, §10 Settings).
 *
 * Values are stored as JSON text so a number reads back as a number. Defaults live here,
 * not in the table: a fresh install has no rows, and a default changed in a later version
 * reaches everyone who never touched that setting.
 */

import type { SlotType } from '@metrum/meal-planner-domain';
import type { SqlDb } from './sql.js';

export interface SlotCounts {
  readonly meals: number;
  readonly snacks: number;
}

export interface Settings {
  readonly defaultKcalBudget: number;
  readonly defaultProteinTarget: number;
  readonly defaultSlots: SlotCounts;
  readonly usdaApiKey: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultKcalBudget: 2000,
  defaultProteinTarget: 100,
  defaultSlots: { meals: 3, snacks: 1 },
  usdaApiKey: null,
};

const KEYS: Readonly<Record<keyof Settings, string>> = {
  defaultKcalBudget: 'default_kcal_budget',
  defaultProteinTarget: 'default_protein_target',
  defaultSlots: 'default_slots',
  usdaApiKey: 'usda_api_key',
};

export class SettingsRepo {
  constructor(private readonly db: SqlDb) {}

  async read(): Promise<Settings> {
    const rows = await this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const [field, key] of Object.entries(KEYS)) {
      const raw = stored.get(key);
      if (raw === undefined) continue;
      try {
        out[field] = JSON.parse(raw);
      } catch {
        // A value this version cannot read keeps its default rather than breaking every screen.
      }
    }
    return out as unknown as Settings;
  }

  async write(change: Partial<Settings>): Promise<Settings> {
    await this.db.transaction(async (tx) => {
      for (const [field, value] of Object.entries(change)) {
        const key = KEYS[field as keyof Settings];
        if (!key || value === undefined) continue;
        await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
          key,
          JSON.stringify(value),
        ]);
      }
    });
    return this.read();
  }
}

/** Meals 1–3 map to breakfast, lunch, dinner in order; snacks 0–3 follow (§10). */
export function slotsFor(counts: SlotCounts): SlotType[] {
  const mealTypes: SlotType[] = ['breakfast', 'lunch', 'dinner'];
  const m = Math.max(1, Math.min(3, Math.round(counts.meals)));
  const s = Math.max(0, Math.min(3, Math.round(counts.snacks)));
  return [...mealTypes.slice(0, m), ...new Array<SlotType>(s).fill('snack')];
}

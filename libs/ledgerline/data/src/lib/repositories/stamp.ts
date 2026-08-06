/**
 * The three columns §3.1 puts on every table, produced in one place.
 *
 * "the repository layer sets all three on every write". Not a SQL DEFAULT: a
 * default would quietly supply a plausible timestamp for a write that forgot to,
 * and `updated_at` is the watermark an Elasticsearch re-index reads (§3.4) — a
 * row whose `updated_at` is wrong is a row the re-index never revisits.
 */

import type { Clock } from '../clock.js';

export interface Stamp {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function newStamp(clock: Clock): Stamp {
  const now = clock.now();
  return { id: clock.newId(), createdAt: now, updatedAt: now };
}

export const asInt = (value: boolean): number => (value ? 1 : 0);

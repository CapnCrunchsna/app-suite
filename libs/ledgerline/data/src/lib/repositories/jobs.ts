/**
 * The `job` table (§2.7) — "the queue is a table, not a broker."
 *
 * This is the queue's *storage*, not its runner. §2.7 has two producers
 * (`POST /api/jobs/renormalize`, `POST /api/analysis/run`) and one consumer that
 * runs in-process; only enqueueing and reading are needed for a merchant
 * correction to honestly report "re-normalize queued", and the runner is separate
 * work. Nothing here executes anything.
 */

import { newStamp } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

/** §2.7's two kinds. The column is free text so a third does not need a
 *  migration, but these are the two the design names. */
export type JobKind = 'renormalize' | 'analysis';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly state: JobState;
  /** 0–100. §2.7: "`GET /api/jobs/:id` reports `{ state, progress, message,
   *  result }`; the UI polls." */
  readonly progress: number;
  readonly message: string | null;
  readonly payloadJson: string | null;
  readonly resultJson: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueCoalescedInput {
  readonly kind: JobKind;
  /**
   * Merge this request's work into whatever a queued job of the same kind is
   * already carrying, or produce a fresh payload when there is none.
   *
   * The merge is the **caller's**, not this repository's. `data` may depend on
   * `type:domain` and nothing else (§2.2), so it cannot know that a renormalize
   * payload is a set of alias keys and transaction ids, let alone that merging
   * two of them is a set union. Passing the function in is what keeps that
   * knowledge in the composition root where the rest of §4.3 lives.
   */
  readonly mergePayload: (existingPayloadJson: string | null) => string | null;
  readonly message?: string | null;
}

export interface EnqueueResult {
  readonly job: JobRecord;
  /** True when this request merged into a job that was already queued. */
  readonly coalesced: boolean;
}

interface JobRow {
  id: string;
  kind: string;
  state: JobState;
  progress: number;
  message: string | null;
  payload_json: string | null;
  result_json: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, kind, state, progress, message, payload_json, result_json,
                       finished_at, created_at, updated_at
                  FROM job`;

function toJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    progress: row.progress,
    message: row.message,
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  get(id: string): JobRecord | null {
    const row = this.db.prepare<[string], JobRow>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toJob(row) : null;
  }

  /** Newest first. §2.3's `GET /api/jobs`. */
  list(limit = 20): JobRecord[] {
    return this.db
      .prepare<[number], JobRow>(`${SELECT} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit)
      .map(toJob);
  }

  /**
   * §2.7: "Jobs of the same kind **coalesce**: a second renormalize request
   * while one is queued merges into it rather than stacking."
   *
   * Only a `queued` job is a merge target. A `running` one has already read its
   * payload, so adding to it would silently drop the addition — that request
   * needs its own job, which is the next one to coalesce into.
   *
   * The lookup and the write share one transaction: two corrections applied in
   * the same tick must not each find "no queued job" and insert one, which is the
   * exact stacking this method exists to prevent.
   */
  enqueueCoalesced(input: EnqueueCoalescedInput): EnqueueResult {
    return this.db.transaction((): EnqueueResult => {
      const existing = this.db
        .prepare<[string], JobRow>(
          `${SELECT} WHERE kind = ? AND state = 'queued' ORDER BY created_at LIMIT 1`,
        )
        .get(input.kind);

      const now = this.clock.now();

      if (existing) {
        this.db
          .prepare('UPDATE job SET payload_json = ?, message = ?, updated_at = ? WHERE id = ?')
          .run(
            input.mergePayload(existing.payload_json),
            input.message ?? existing.message,
            now,
            existing.id,
          );
        return { job: this.getOrThrow(existing.id), coalesced: true };
      }

      const stamp = newStamp(this.clock);
      this.db
        .prepare(
          `INSERT INTO job
             (id, kind, state, progress, message, payload_json, result_json,
              finished_at, created_at, updated_at)
           VALUES (?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          stamp.id,
          input.kind,
          input.message ?? null,
          input.mergePayload(null),
          stamp.createdAt,
          stamp.updatedAt,
        );

      return { job: this.getOrThrow(stamp.id), coalesced: false };
    })();
  }

  private getOrThrow(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }
}

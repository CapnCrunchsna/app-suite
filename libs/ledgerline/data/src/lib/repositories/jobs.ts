/**
 * The `job` table (§2.7) — "the queue is a table, not a broker."
 *
 * This is the queue's *storage*, and now also the four state transitions its
 * consumer needs. What is still deliberately absent is the consumer itself:
 * §2.7's jobs "run in-process", and what they run is re-normalization (§4.3's
 * chain) and analysis (§5) — neither of which `data` may reach, since
 * `type:data-access` may depend on `type:domain` and nothing else (§2.2). So the
 * runner lives in the composition root and this file hands it a claim, a progress
 * report and two ways to finish. Nothing here executes anything.
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

const COLUMNS = `id, kind, state, progress, message, payload_json, result_json,
                 finished_at, created_at, updated_at`;

const SELECT = `SELECT ${COLUMNS} FROM job`;

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

  // ------------------------------------------------------- the consumer side ---

  /**
   * Take the oldest queued job and mark it `running`, or return null.
   *
   * The select and the update are one statement, not a read followed by a write.
   * §2.7's coalescing depends on `queued` meaning "not yet read": a job claimed in
   * two steps is a job another request can merge into after its payload has been
   * taken, and that addition is then silently lost. `UPDATE ... WHERE id = (SELECT
   * ...)` closes the gap even before the surrounding transaction does.
   *
   * FIFO by `created_at`. A coalesced job keeps the created_at of the request that
   * opened it, so merging into a queued job does not push it to the back of the
   * line behind work that arrived later.
   */
  claimNext(): JobRecord | null {
    const claimed = this.db
      .prepare<[string], JobRow>(
        `UPDATE job
            SET state = 'running', updated_at = ?
          WHERE id = (SELECT id FROM job WHERE state = 'queued' ORDER BY created_at, id LIMIT 1)
        RETURNING ${COLUMNS}`,
      )
      .get(this.clock.now());

    // The enqueue message survives the claim. It is the one the UI is already
    // showing ("re-normalizing 47 transactions"), and replacing it with "running"
    // would trade a sentence about the work for a restatement of `state`.
    return claimed ? toJob(claimed) : null;
  }

  /** §2.7: "`GET /api/jobs/:id` reports `{ state, progress, message, result }`;
   *  the UI polls." This is what moves the first two while the work runs. */
  reportProgress(id: string, progress: number, message?: string | null): void {
    this.db
      .prepare(
        'UPDATE job SET progress = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?',
      )
      .run(Math.max(0, Math.min(100, Math.round(progress))), message ?? null, this.clock.now(), id);
  }

  succeed(id: string, result: unknown, message?: string | null): JobRecord {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE job
            SET state = 'succeeded', progress = 100, message = COALESCE(?, message),
                result_json = ?, finished_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(message ?? null, JSON.stringify(result ?? null), now, now, id);
    return this.getOrThrow(id);
  }

  /**
   * A failed job keeps whatever progress it reached rather than being reset.
   *
   * "Failed at 60%" tells the user which half of a re-normalize landed; "failed at
   * 0%" says it never started, which would be a lie about a job that rewrote four
   * hundred rows before it threw.
   */
  fail(id: string, message: string): JobRecord {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE job SET state = 'failed', message = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(message, now, now, id);
    return this.getOrThrow(id);
  }

  countQueued(): number {
    return (
      this.db
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM job WHERE state = 'queued'`)
        .get()?.n ?? 0
    );
  }

  /**
   * §2.7's queue survives a restart; a job that was `running` when the process
   * died does not. Returning it to `queued` at boot is what makes an interrupted
   * re-normalize resume rather than sit as a permanent spinner — the work is
   * idempotent (re-resolving an alias to the same merchant writes the same row),
   * which is what makes re-running it safe.
   */
  requeueStranded(): number {
    const now = this.clock.now();
    return this.db
      .prepare(
        `UPDATE job
            SET state = 'queued', progress = 0,
                message = 'requeued after restart', updated_at = ?
          WHERE state = 'running'`,
      )
      .run(now).changes;
  }

  private getOrThrow(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }
}

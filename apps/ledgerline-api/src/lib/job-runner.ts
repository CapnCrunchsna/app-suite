/**
 * §2.7's consumer. "Jobs run in-process (single local user, `better-sqlite3` is
 * synchronous); the queue is a table, not a broker."
 *
 * Taken literally, that sentence describes something much smaller than a worker:
 * there is no pool, no IPC, no lock file and no polling interval. A job is a
 * function call whose arguments came out of a table, and the only thing between
 * "enqueued" and "run" is a turn of the event loop.
 *
 * ## Why the drain is scheduled rather than awaited
 *
 * The producer is an HTTP request — a merchant correction (§4.3), or
 * `POST /api/analysis/run`. §2.7 has both of those *return a job id* rather than
 * a result, and §6.3 says the UI "shows its progress rather than blocking". So
 * the route enqueues, `schedule()` books a drain for after the response is sent,
 * and the runner does the work while the client polls `GET /api/jobs/:id`.
 * Running it inline would make a five-second re-normalize a five-second PATCH.
 *
 * ## Why the drain waits, and does not fire on the next tick
 *
 * §2.7 asks for two separate things and the queue can only deliver one of them
 * alone. Coalescing — "a second renormalize request while one is queued merges
 * into it rather than stacking" — needs a job to *stay* queued long enough for a
 * second request to find it. `setImmediate` gives it no such window: Node runs
 * the drain between two awaited requests, so eight single-row corrections become
 * eight full re-normalizations and eight full analyses, which is the outcome that
 * sentence exists to prevent.
 *
 * §2.7's own answer is a debounce, and it puts it in the UI: "Merchant
 * corrections in the UI are debounced 5 seconds and batched." That covers a burst
 * of edits made through the batching path and nothing else — a run of individual
 * `PATCH /api/transactions/:id` calls arrives as a run of requests however patient
 * the page is. So the runner keeps a short window of its own. It is deliberately
 * far shorter than §2.7's five seconds: the UI's debounce is there to make eight
 * clicks one *request*, this one only has to make several requests one *run*, and
 * a user who clicks Run Analysis should not watch a queued job for five seconds
 * first. **Uncalibrated** in the §7.6 sense, like every other number that has not
 * been run against real statements.
 *
 * ## One runner at a time, which is what the synchronous rule was protecting
 *
 * Every handler used to be synchronous, and the argument for it was concurrency:
 * "a job that yielded mid-run would let a second drain claim the next job and
 * interleave two writers over one SQLite connection — which is precisely the
 * concurrency §2.7 avoided by not having a broker." §4.2's stage cannot be
 * synchronous; it awaits a subprocess or an HTTP call by construction (§2.4), and
 * §2.7's own reasoning is *why* it is a job rather than a request.
 *
 * So the guard moved down to what it was actually guarding. `draining` is now held
 * across the awaits, so there is still exactly one runner and no second drain can
 * claim the next job — which is the property that sentence names. What is no longer
 * true is that a job cannot be interleaved with an HTTP request, and that turns out
 * to be the safe half: a handler's writes are still synchronous between awaits, and
 * the one thing a concurrent request could change under §4.2 is the alias table,
 * where §4.3's precedence already settles the race in the user's favour — an `llm`
 * write never overwrites a `user` one. Recorded in §9s.
 *
 * ## Failure is a job state, not an exception
 *
 * A throw inside a handler marks the job `failed` with the message and moves to
 * the next one. §2.7 makes `GET /api/jobs/:id` report `{ state, progress,
 * message, result }` — a failed job with a readable reason is a UI the user can
 * act on, and an unhandled rejection that kills the API is not.
 */

import type { JobRecord, LedgerlineStore } from '@metrum/ledgerline-data';

import { runAnalysis } from './analysis-service.js';
import type { LedgerlineContext } from './context.js';
import { runLlmMerchantProposals } from './llm-merchants.js';
import { runRenormalize } from './merchant-corrections.js';
import type { RenormalizePayload } from './merchant-corrections.js';

/** Progress channel handed to a handler. §2.7's `{ state, progress, message }`. */
export type ProgressReporter = (progress: number, message: string) => void;

export type JobHandler = (
  job: JobRecord,
  report: ProgressReporter,
  context: LedgerlineContext,
) => unknown | Promise<unknown>;

/** §4.2's stage, as a job kind. Named rather than spelled at both the route and
 *  the handler, because a typo in one of two string literals is a job that
 *  enqueues and then fails with "no handler". */
export const LLM_PROPOSAL_JOB = 'llm-normalize';

/**
 * A ceiling on one drain, so a handler that enqueues its own kind cannot spin the
 * process. Nothing does that today; the guard is here because the day something
 * does, the symptom is a wedged API rather than a stack trace.
 */
const MAX_JOBS_PER_DRAIN = 100;

/** The coalescing window described in the header. Uncalibrated (§7.6). */
export const COALESCE_WINDOW_MS = 250;

export const JOB_HANDLERS: Readonly<Record<string, JobHandler>> = {
  /**
   * §2.7: "A re-normalize triggered by a merchant correction re-runs the chain
   * over every historical transaction **and then re-runs the full analysis**."
   *
   * Both halves in one job rather than a second enqueued job, because that is the
   * sentence's shape and because the intermediate state is not worth publishing:
   * between the two, `merchant_id` has moved and every finding still describes
   * the old grouping. A single job means the UI's "done" is the first moment both
   * are true.
   */
  renormalize: (job, report, context) => {
    const payload = parsePayload<RenormalizePayload>(job.payloadJson) ?? {
      transactionIds: [],
      aliasKeys: [],
    };

    report(10, 'reapplying the merchant chain');
    const renormalized = runRenormalize(context, payload);

    report(50, 're-running analysis');
    const analysis = runAnalysis(context, (progress, message) =>
      // The analysis owns the back half of the bar. Its own 0–100 is rescaled
      // rather than replayed, so the bar never goes backwards mid-job.
      report(50 + progress / 2, message),
    );

    return { renormalized, analysis };
  },

  analysis: (_job, report, context) => runAnalysis(context, report),

  /**
   * §4.2's stage. The only asynchronous handler, and the reason the runner is —
   * §2.4's providers are a subprocess and an HTTP call.
   *
   * It does *not* re-run the analysis itself. Applying an alias enqueues §4.3's
   * re-normalize (see `runLlmMerchantProposals`), and that job already ends in a
   * full analysis; doing both here would run §5 twice over the same data and
   * publish the intermediate one.
   */
  [LLM_PROPOSAL_JOB]: (_job, report, context) => runLlmMerchantProposals(context, { report }),
};

export class JobRunner {
  private draining = false;
  private scheduled = false;

  constructor(
    private readonly context: LedgerlineContext,
    private readonly handlers: Readonly<Record<string, JobHandler>> = JOB_HANDLERS,
  ) {}

  private get store(): LedgerlineStore {
    return this.context.store;
  }

  /**
   * Claim and run one job. Returns null when the queue is empty.
   *
   * Public because the tests drive it directly: a suite that had to await a
   * scheduled drain would be a suite that sleeps, and the assertion "one
   * correction produces one converged analysis" does not need a timer to be true.
   */
  async runNext(): Promise<JobRecord | null> {
    const job = this.store.jobs.claimNext();
    if (!job) return null;

    const handler = this.handlers[job.kind];
    if (!handler) {
      return this.store.jobs.fail(job.id, `no handler for job kind "${job.kind}"`);
    }

    try {
      // `await` on a synchronous handler's return value is a microtask and
      // nothing else, so the two existing handlers behave exactly as before.
      const result = await handler(
        job,
        (progress, message) => {
          this.store.jobs.reportProgress(job.id, progress, message);
        },
        this.context,
      );
      return this.store.jobs.succeed(job.id, result ?? null);
    } catch (cause) {
      return this.store.jobs.fail(job.id, (cause as Error).message);
    }
  }

  /** Run until the queue is empty. Re-entrant calls are a no-op rather than a
   *  second runner — `draining` is held across the awaits, which is the whole of
   *  the guarantee described in the header. */
  async drain(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;

    try {
      let ran = 0;
      while (ran < MAX_JOBS_PER_DRAIN && (await this.runNext()) !== null) ran += 1;
      return ran;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Book a drain, after a window in which further requests can coalesce into the
   * job that is already queued (see the header).
   *
   * The booking is itself coalesced: eight corrections inside the window schedule
   * one drain, and that drain finds one merged job. `unref` so a pending drain
   * never holds the process open — the queue is a table, and whatever is still
   * `queued` at shutdown is claimed at the next boot.
   */
  schedule(): void {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;

    setTimeout(() => {
      this.scheduled = false;
      // `drain` marks each job's own failure, so a rejection here means the store
      // itself is unusable and there is no job left to record it against. Caught
      // rather than left to become an unhandled rejection, which would take the
      // API down for a diagnostic.
      void this.drain().catch(() => undefined);
    }, COALESCE_WINDOW_MS).unref();
  }
}

function parsePayload<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * §4.1 step 7's queue, held once for the whole app.
 *
 * ## Why this is a service and not a `resource()` on the page
 *
 * Every other page in this lib fetches its own data and nothing outside it cares.
 * This one is different: the shell's rail carries a badge for the same number the
 * page renders, and the badge is the reason the page is findable at all.
 *
 * **The rail cannot wait for the page to publish it.** A badge that says "there is
 * something to review here" is addressed to someone who has *not* been to the
 * Review page — that is its entire job. A count published by the page on load is a
 * count you first see at the moment you no longer need it.
 *
 * **And the rail must not read it privately either.** A merge changes the count,
 * and a rail that read once at startup would go on advertising work that is
 * finished — with the page saying "nothing to review" two inches away from a rail
 * saying `1`. Two reads of one endpoint is two numbers that can disagree on one
 * screen, which is worse than either being briefly stale.
 *
 * So: one holder, injected by both. The shell loads it at startup, the Review page
 * re-reads it on entry and after a merge, and §6.1's commit re-reads it because a
 * statement is the thing that creates these questions in the first place.
 *
 * **Not a timer poll.** This is a single-user local app and nothing outside this UI
 * writes an alias, so a poll would spend a request every few seconds to be told
 * what the page that caused the change already knew.
 *
 * **The count is the API's**, never derived by decrementing what the page holds —
 * §6.3's argument about its bulk count applies to every number that authorises a
 * permanent change, and this one is the doorway to that change.
 */

import { Injectable, PendingTasks, computed, inject, signal } from '@angular/core';
import type { MerchantReviewQueue } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';

/** "Nothing to review" is a valid and common state, and rendering it while the
 *  first read is in flight is honest — an empty rail badge is the same shape as a
 *  loading one. */
const EMPTY: MerchantReviewQueue = {
  mergeCandidates: [],
  provisional: [],
  llmProposals: [],
  llmProposalsUnavailableReason: null,
};

@Injectable({ providedIn: 'root' })
export class ReviewQueue {
  private readonly api = inject(LedgerlineApiService);

  /**
   * The read is registered as a pending task rather than left floating. Everything
   * else in this lib fetches through `resource()`, which does this for us; this one
   * is hand-rolled because two components share it, and an unregistered fetch is
   * invisible to `ApplicationRef.isStable` — which is what `whenStable()` waits on
   * in a test and what a future prerender would wait on for real.
   */
  private readonly pending = inject(PendingTasks);

  private readonly current = signal<MerchantReviewQueue>(EMPTY);
  private readonly reading = signal(false);
  private readonly failure = signal<Error | null>(null);
  private loaded = false;

  readonly queue = this.current.asReadonly();
  readonly loading = this.reading.asReadonly();
  readonly error = this.failure.asReadonly();

  /**
   * What the badge counts: things waiting on an answer.
   *
   * Provisional merchants are deliberately not among them. There are seventeen on
   * the first real statement and none of them is a question — a name the chain made
   * up is fine as long as it is spelled the same way every month, which is what the
   * section says when it lists them. A badge of `18` would be a badge nobody reads.
   */
  readonly outstanding = computed(
    () => this.current().mergeCandidates.length + this.current().llmProposals.length,
  );

  /** The shell's startup read. Idempotent, so mounting the rail twice in a test
   *  does not produce two requests. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.refresh();
  }

  /**
   * Re-read from the API.
   *
   * A failure keeps the previous queue rather than emptying it: "the API is not
   * answering" and "you have nothing left to review" are different facts, and only
   * one of them is worth telling someone by silently clearing their badge.
   */
  async refresh(): Promise<void> {
    this.reading.set(true);
    await this.pending.run(async () => {
      try {
        this.current.set(await this.api.getMerchantReviewQueue());
        this.failure.set(null);
      } catch (cause) {
        this.failure.set(cause as Error);
      } finally {
        this.loaded = true;
        this.reading.set(false);
      }
    });
  }
}

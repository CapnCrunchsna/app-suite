/**
 * §6.9, the Review page.
 *
 * ## Why this is not a section of §6.8's Settings page
 *
 * It was one, for a day (§9r). Settings is where you go to *configure* — to change
 * a threshold, pick a provider, say where the backups live — and every one of those
 * is a thing you do to the app. This is a thing you do to your data, and it is the
 * only screen in the app that asks the user a question it cannot answer itself.
 * Filing that under Settings buries the one surface whose whole value is being
 * noticed, behind a door people open twice a year.
 *
 * So it gets a page and a badge in the rail (§9s). The badge is the actual fix: a
 * queue nobody knows is non-empty is a queue nobody answers.
 *
 * ## What belongs here later
 *
 * Everything of the same shape — the app is unsure about the data and a person can
 * settle it in one click. §4.2's LLM alias proposals land here the moment §2.4's
 * provider seam can produce them, and the queue already carries the field and the
 * reason it is empty. Uncategorized merchants and §2.6's possible transfers are the
 * two other populations of the same kind, though transfers stay on §6.2's Accounts
 * page for now: they are a fact about two accounts and the page holding both is
 * where the evidence already is.
 *
 * Same split as the other six pages: the container owns all state and every
 * request, the child is presentational, and `LedgerlineApiService` is the one seam.
 * The queue itself is held by `ReviewQueue` rather than by a `resource()` here,
 * because the rail's badge renders the same number — that file argues it.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Panel } from '@metrum/ui';
import { LedgerlineApiError } from '@metrum/api-client';
import type { Calibration } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { CalibrationPass } from './calibration-pass.js';
import type { AssertionEvent } from './calibration-pass.js';
import { MerchantReview } from './merchant-review.js';
import type { MergeRequest } from './merchant-review.js';
import { ReviewQueue } from './review-queue.service.js';

@Component({
  selector: 'll-review-page',
  imports: [Panel, MerchantReview, CalibrationPass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './review-page.html',
  styleUrl: './review-page.scss',
})
export class ReviewPage {
  private readonly api = inject(LedgerlineApiService);
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly queue = this.reviewQueue.queue;
  protected readonly loading = this.reviewQueue.loading;
  protected readonly failure = this.reviewQueue.error;
  protected readonly outstanding = this.reviewQueue.outstanding;

  /** Nothing held yet — so the first read can say "reading" rather than flashing
   *  "nothing to review" at someone who has one waiting. */
  protected readonly nothingHeld = computed(
    () => this.outstanding() === 0 && this.queue().provisional.length === 0,
  );

  /**
   * §7.6's pass, behind a mode switch rather than beside the queue (§9ab).
   *
   * Both halves of this page are work on your data, which is why §9s put the queue
   * here — but they are opposite kinds of work. The queue is the app asking *you* a
   * question it could not settle; the pass is you volunteering answers it never
   * thought to ask. Showing both at once would make the page a wall, and would bury
   * the queue, which is the half with a badge and a reason to be noticed.
   */
  protected readonly mode = signal<'queue' | 'calibrate'>('queue');
  private readonly passRevision = signal(0);

  /** Date order, oldest first: §7.6 describes an afternoon with a year of
   *  statements, and that is the order they arrive in. */
  private readonly passResource = resource({
    params: () => ({ revision: this.passRevision(), on: this.mode() }),
    loader: ({ params }) =>
      params.on === 'calibrate'
        ? this.api.listTransactions({ sort: 'date_asc', limit: 500, includeInternalTransfers: true })
        : Promise.resolve(null),
    defaultValue: null,
  });

  private readonly calibrationResource = resource<Calibration | null, number>({
    params: () => this.passRevision(),
    loader: () => this.api.getCalibration(),
    defaultValue: null,
  });

  protected readonly passRows = computed(
    () => this.passResource.value()?.rows.map((row) => row.transaction) ?? [],
  );

  /** Keyed by transaction id, because the pass renders one row at a time and a
   *  linear scan per row would be quadratic over a year of statements. */
  protected readonly passLabels = computed(() => {
    const report = this.calibrationResource.value();
    const byId: Record<string, NonNullable<typeof report>['labels'][number]> = {};
    for (const label of report?.labels ?? []) byId[label.transactionId] = label;
    return byId;
  });

  protected readonly calibration = computed(() => this.calibrationResource.value());

  protected readonly passProgress = computed(() => {
    const report = this.calibrationResource.value();
    return report ? { labelled: report.progress.labelled, total: report.progress.total } : null;
  });

  protected setMode(mode: 'queue' | 'calibrate'): void {
    this.mode.set(mode);
  }

  /**
   * One keystroke, one write, and the row's other assertions left alone.
   *
   * `nothing` sends four falses rather than clearing: §9ab's schema makes
   * "asserted false" and "nobody said" different facts, and the whole recall
   * figure rests on most rows being explicitly ordinary rather than merely
   * unexamined.
   */
  protected async onAsserted(event: AssertionEvent): Promise<void> {
    const bodies: Record<string, Record<string, boolean | null>> = {
      recurring: { isRecurring: true },
      fee: { isFee: true },
      transfer: { isTransfer: true },
      outlier: { isOutlier: true },
      nothing: { isRecurring: false, isFee: false, isTransfer: false, isOutlier: false },
    };

    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (event.assertion === 'clear') {
        await this.api.unlabelTransaction(event.transaction.id);
      } else {
        await this.api.labelTransaction(event.transaction.id, bodies[event.assertion]);
      }
      // One counter drives both the label map and the scorecard, so a keystroke
      // cannot leave the two disagreeing about what has been said.
      this.passRevision.update((n) => n + 1);
    } catch (cause) {
      this.notice.set(
        cause instanceof LedgerlineApiError
          ? cause.message
          : `That did not work: ${(cause as Error).message}`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  constructor() {
    // Entering the page is a re-read. The rail's copy can be a few minutes old —
    // a §6.3 merchant correction writes an alias too, and nothing tells the rail —
    // and the page is where being wrong about it actually costs something.
    void this.reviewQueue.refresh();
  }

  /**
   * §4.3's correction, and the one write on this page.
   *
   * The notice reports the count the *API* returned rather than the one the card
   * showed. They should agree, and on the day they do not the user is owed the
   * true number — a merge is permanent, and "47 charges moved" has to mean it.
   *
   * **The re-read waits for the job**, which is the difference between a card that
   * disappears and one that sits there having apparently done nothing. The alias
   * is written synchronously but the rows move in §4.3's re-normalize job, so a
   * queue re-read issued the moment the POST returns still sees the old counts and
   * proposes the merge that was just made. §2.7's answer is that the UI polls a
   * job rather than blocking on it, and §6.4's Run analysis already runs this loop.
   */
  protected async onMerge(request: MergeRequest): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const result = await this.api.mergeMerchant(request.mergeMerchantId, {
        intoMerchantId: request.intoMerchantId,
      });

      const settled = await this.awaitJob(result.jobId);

      this.notice.set(
        `${request.mergeName} is now ${request.keepName}. ` +
          `${result.transactionsAffected} ` +
          `${result.transactionsAffected === 1 ? 'charge' : 'charges'} moved` +
          (settled
            ? ', and subscriptions and findings have been recalculated.'
            : '. Subscriptions and findings are still recalculating.'),
      );

      // One re-read for both the card list and the rail's badge — see `ReviewQueue`.
      await this.reviewQueue.refresh();
    } catch (cause) {
      // `LedgerlineApiError` carries the API's own message, which explains a
      // refusal better than anything this page could add.
      this.notice.set(
        cause instanceof LedgerlineApiError
          ? cause.message
          : `That did not work: ${(cause as Error).message}`,
      );
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * §2.7's poll. Returns whether the job actually landed, so the notice can say
   * "have been" or "are still" rather than guessing.
   *
   * Bounded, and a timeout is not a failure: the work is queued and finishes
   * whether or not this page is still watching. A merge that reported success and
   * then threw because a poll ran out would be the worst of both.
   */
  private async awaitJob(jobId: string): Promise<boolean> {
    let job = await this.api.getJob(jobId);

    for (
      let attempt = 0;
      attempt < 60 && (job.state === 'queued' || job.state === 'running');
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = await this.api.getJob(jobId);
    }

    return job.state === 'succeeded';
  }
}

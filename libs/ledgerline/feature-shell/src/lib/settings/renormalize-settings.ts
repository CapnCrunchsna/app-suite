/**
 * §6.8's **Merchant aliases** section, which §9s reduced to one thing: "a
 * re-normalize trigger with job progress".
 *
 * The queue and the corrections list moved to §6.9's Review page, because they are
 * work on the data. What is left is maintenance, and maintenance is what the rest of
 * this page is — a sweep rebuilds derived state from inputs that have not changed.
 *
 * ## The button has to say what it is for, because nobody wants a sweep
 *
 * Nobody opens Settings intending to re-normalize. They open it because a merchant
 * looks wrong and every obvious fix has failed — which is exactly the situation §9o
 * describes: the chain improved, and rows imported before it still carry the old
 * chain's output. So the copy leads with the symptom rather than the operation, and
 * the count is there because "this will take a moment" is more useful with a number.
 *
 * ## Progress rather than a spinner
 *
 * §2.7: "`GET /api/jobs/:id` reports `{ state, progress, message }`; the UI polls."
 * §6.8 asks for "job progress" by name, and this is the only screen in the app where
 * the work is long enough for the difference to matter — a sweep over §2.2's ceiling
 * is tens of thousands of rows. The bar shows the job's own `message`, which names
 * the phase the runner is in rather than a percentage invented here.
 *
 * Presentational, like every other child on this page: the container owns the
 * request and the polling.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** What the page is showing while a sweep runs. `null` when none is in flight. */
export interface RenormalizeProgress {
  readonly progress: number;
  readonly message: string | null;
  readonly done: boolean;
}

@Component({
  selector: 'll-renormalize-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './renormalize-settings.html',
  styleUrl: './renormalize-settings.scss',
})
export class RenormalizeSettings {
  readonly busy = input(false);
  /** Rows the sweep would walk, from `GET /api/health` — the same count the API
   *  returns when the job is enqueued, so the two never disagree. */
  readonly transactionCount = input(0);
  readonly running = input<RenormalizeProgress | null>(null);

  readonly renormalize = output<void>();

  protected readonly empty = computed(() => this.transactionCount() === 0);

  /** Clamped, because a job's `progress` is written by a handler and a bar that
   *  overshoots its track is a bar nobody trusts the rest of. */
  protected readonly percent = computed(() => {
    const value = this.running()?.progress ?? 0;
    return Math.min(100, Math.max(0, Math.round(value)));
  });

  protected start(): void {
    if (this.busy() || this.empty() || this.running() !== null) return;
    this.renormalize.emit();
  }
}

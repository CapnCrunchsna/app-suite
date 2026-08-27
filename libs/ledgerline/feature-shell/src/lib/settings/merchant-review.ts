/**
 * §6.8's Merchant aliases section — §4.1 step 7's review queue, on screen.
 *
 * This is where the app stops pretending it can work everything out. §4.1's chain
 * is deliberately unable to decide whether two similar names are one merchant, so
 * the queue carries the question here and a person answers it once.
 *
 * ## Two decisions, both borrowed from §6.3's merchant edit
 *
 * **The counts are the API's, never computed here.** They are the basis on which
 * someone authorises a permanent, precedence-topping change (§4.3), and a number
 * derived from whatever the page happens to hold is a number that can be wrong in
 * the user's favour. `merchant-assign.ts` makes the same argument about its "apply
 * to all 47 matching" count.
 *
 * **Nothing applies on hover, focus or selection.** Choosing a direction arms the
 * merge; a second, explicit click performs it. §4.3 makes the write permanent, so
 * it does not happen on a `change` event.
 *
 * ## Why the direction is a control rather than a decision
 *
 * The API proposes a survivor — the larger history, or the shipped canonical — and
 * it is usually right and occasionally not: the bank's uglier spelling can be the
 * one with more charges behind it. Flipping is one click, and the card says which
 * way it is pointing in words rather than by the order of two names.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MergeCandidate, MerchantReviewQueue, ReviewMerchant } from '@metrum/api-client';

/** A merge the user has asked for: which merchant survives, which is folded in. */
export interface MergeRequest {
  readonly mergeMerchantId: string;
  readonly intoMerchantId: string;
  /** What the user was shown, so the page can report what happened against what
   *  was promised. */
  readonly transactionCount: number;
  readonly keepName: string;
  readonly mergeName: string;
}

@Component({
  selector: 'll-merchant-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './merchant-review.html',
  styleUrl: './merchant-review.scss',
})
export class MerchantReview {
  readonly queue = input.required<MerchantReviewQueue>();
  readonly busy = input(false);

  readonly merge = output<MergeRequest>();

  /** Candidate ids whose direction the user has reversed. Keyed by the pair rather
   *  than held as one value, so flipping one card does not disturb another. */
  private readonly flipped = signal<ReadonlySet<string>>(new Set());

  protected readonly candidates = computed(() => this.queue().mergeCandidates);
  protected readonly provisional = computed(() => this.queue().provisional);

  /** §4.1 step 7 says an unresolved descriptor "joins the review queue", which is
   *  true of every provisional merchant and would be a list of dozens. The ones
   *  worth a person's attention are the ones with history behind them. */
  protected readonly provisionalShown = computed(() => this.provisional().slice(0, 12));
  protected readonly provisionalHidden = computed(() =>
    Math.max(0, this.provisional().length - this.provisionalShown().length),
  );

  protected keyOf(candidate: MergeCandidate): string {
    return `${candidate.keep.merchant.id}:${candidate.merge.merchant.id}`;
  }

  protected isFlipped(candidate: MergeCandidate): boolean {
    return this.flipped().has(this.keyOf(candidate));
  }

  protected keeping(candidate: MergeCandidate): ReviewMerchant {
    return this.isFlipped(candidate) ? candidate.merge : candidate.keep;
  }

  protected folding(candidate: MergeCandidate): ReviewMerchant {
    return this.isFlipped(candidate) ? candidate.keep : candidate.merge;
  }

  protected flip(candidate: MergeCandidate): void {
    const key = this.keyOf(candidate);
    this.flipped.update((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected confirm(candidate: MergeCandidate): void {
    if (this.busy()) return;
    const keep = this.keeping(candidate);
    const fold = this.folding(candidate);

    this.merge.emit({
      mergeMerchantId: fold.merchant.id,
      intoMerchantId: keep.merchant.id,
      transactionCount: fold.transactionCount,
      keepName: keep.merchant.displayName,
      mergeName: fold.merchant.displayName,
    });
  }

  /** Presentation only. A similarity is a diagnostic, not a promise, so it reaches
   *  the card as a coarse word — §7.5's rule about provenance reaching the UI as
   *  something to show rather than something to act on. */
  protected confidenceWord(candidate: MergeCandidate): string {
    if (candidate.similarity >= 0.8) return 'very similar';
    if (candidate.similarity >= 0.65) return 'similar';
    return 'possibly the same';
  }
}

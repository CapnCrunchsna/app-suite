/**
 * §4.1 step 7's review queue, on screen — the merchant half of §6.9's Review page.
 *
 * This is where the app stops pretending it can work everything out. §4.1's chain
 * is deliberately unable to decide whether two similar names are one merchant, so
 * the queue carries the question here and a person answers it once.
 *
 * Presentational, and it stayed that way through the move out of §6.8's Settings
 * page (§9s): the container changed, the questions did not.
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
import type {
  Category,
  MergeCandidate,
  MerchantReviewQueue,
  ReviewMerchant,
  UpdateMerchantBody,
} from '@metrum/api-client';

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

/** §2.3's `PATCH /api/merchants/:id`, as this card asks for it. */
export interface MerchantEditRequest {
  readonly merchantId: string;
  readonly displayName: string;
  readonly patch: UpdateMerchantBody;
}

@Component({
  selector: 'll-merchant-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './merchant-review.html',
  styleUrl: './merchant-review.scss',
})
export class MerchantReview {
  readonly queue = input.required<MerchantReviewQueue>();
  /** §6.8's taxonomy, for the default-category picker. Supplied by the page; this
   *  component does not go looking. */
  readonly categories = input<readonly Category[]>([]);
  readonly busy = input(false);

  readonly merge = output<MergeRequest>();
  readonly edit = output<MerchantEditRequest>();

  /** Candidate ids whose direction the user has reversed. Keyed by the pair rather
   *  than held as one value, so flipping one card does not disturb another. */
  private readonly flipped = signal<ReadonlySet<string>>(new Set());

  protected readonly candidates = computed(() => this.queue().mergeCandidates);
  protected readonly provisional = computed(() => this.queue().provisional);

  /**
   * §4.2's proposals that did not apply, split by *why*.
   *
   * Two lists rather than one with a status column, because the two are different
   * questions to a reader. A sub-floor proposal is the model being unsure and is
   * released by raising confidence or by assigning the merchant by hand. A blocked
   * one is the settled-series exception, which "never auto-applies at any
   * confidence" — no threshold releases it, and showing them together would invite
   * exactly that misreading.
   */
  protected readonly llmBlocked = computed(() =>
    this.queue().llmProposals.filter((proposal) => proposal.status === 'blocked'),
  );
  protected readonly llmPending = computed(() =>
    this.queue().llmProposals.filter((proposal) => proposal.status !== 'blocked'),
  );

  /** Whether the queue has anything at all in it. Includes the LLM half, so the
   *  "nothing to review" line cannot appear above a list of proposals. */
  protected readonly empty = computed(
    () =>
      this.candidates().length === 0 &&
      this.provisional().length === 0 &&
      this.queue().llmProposals.length === 0,
  );

  /** §7.5 again: a confidence is a diagnostic, not a promise, so it reaches the
   *  card as a word. The floor is named separately where it is the reason. */
  protected confidenceOf(confidence: number): string {
    if (confidence >= 0.85) return 'confident';
    if (confidence >= 0.6) return 'fairly sure';
    return 'unsure';
  }

  /**
   * §4.1 step 7 says an unresolved descriptor "joins the review queue", which is
   * true of every provisional merchant and would be a list of dozens. The ones
   * worth a person's attention are the ones with history behind them.
   *
   * The cut stops being right once the list is *editable* (§9af): a truncation is
   * fine when it hides things you can only read, and wrong when it hides the only
   * place to rename the merchant sitting at position 13. So the rest is one click
   * away rather than unreachable.
   */
  protected readonly showAllProvisional = signal(false);

  /**
   * Merchants edited in this sitting, kept on screen after they stop qualifying.
   *
   * The queue's `provisional` list is `source = 'rule'` — merchants the chain
   * named for itself — and §2.3's edit promotes the row to `user`, so answering
   * the question correctly removes it. That is right for a queue and wrong for
   * the minute afterwards: pick the wrong category, and the row you need is gone
   * from the only screen that offered it. So an edited merchant stays, marked as
   * saved, until the page is left.
   *
   * Held as whole records rather than as ids because the API will not return
   * them again — by then they are not provisional, which is the entire point.
   */
  private readonly justEdited = signal<readonly ReviewMerchant[]>([]);

  /** The queue's own list first, then anything edited that has dropped out of it.
   *  Order matters: the questions still waiting stay at the top. */
  protected readonly provisionalWithEdited = computed(() => {
    const live = this.provisional();
    const ids = new Set(live.map((entry) => entry.merchant.id));
    return [...live, ...this.justEdited().filter((entry) => !ids.has(entry.merchant.id))];
  });

  protected readonly provisionalShown = computed(() =>
    this.showAllProvisional()
      ? this.provisionalWithEdited()
      : this.provisionalWithEdited().slice(0, 12),
  );
  protected readonly provisionalHidden = computed(() =>
    Math.max(0, this.provisionalWithEdited().length - this.provisionalShown().length),
  );

  protected isSaved(entry: ReviewMerchant): boolean {
    return this.justEdited().some((edited) => edited.merchant.id === entry.merchant.id);
  }

  protected revealAllProvisional(): void {
    this.showAllProvisional.set(true);
  }

  // ------------------------------------------------ editing one merchant ---

  /**
   * Which merchant's editor is open, and the draft in it.
   *
   * One at a time, for the same reason `account-card.ts` allows one: two open
   * forms on one list is two things to read before deciding either. The draft is
   * held here rather than written through on every keystroke because §2.3's
   * `PATCH` promotes the row to `source: user` — a permanent consequence, and not
   * one to trigger on a `change` event, which is the same argument the merge
   * above makes about arming versus performing.
   */
  protected readonly editing = signal<string | null>(null);
  protected readonly draftName = signal('');
  protected readonly draftCategoryId = signal('');
  protected readonly draftSubscription = signal(false);
  protected readonly draftTransfer = signal(false);

  /** The category's name, or `null` so the template's `@if ... as` drops the chip
   *  entirely — an empty pill reads as a category called nothing. */
  protected categoryName(categoryId: string | null): string | null {
    if (categoryId === null) return null;
    return this.categories().find((category) => category.id === categoryId)?.name ?? null;
  }

  protected openEditor(entry: ReviewMerchant): void {
    this.editing.set(entry.merchant.id);
    this.draftName.set(entry.merchant.displayName);
    this.draftCategoryId.set(entry.merchant.defaultCategoryId ?? '');
    this.draftSubscription.set(entry.merchant.isKnownSubscription);
    this.draftTransfer.set(entry.merchant.isTransferKind);
  }

  protected closeEditor(): void {
    this.editing.set(null);
  }

  protected onDraftName(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected onDraftCategory(event: Event): void {
    this.draftCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onDraftSubscription(event: Event): void {
    this.draftSubscription.set((event.target as HTMLInputElement).checked);
  }

  protected onDraftTransfer(event: Event): void {
    this.draftTransfer.set((event.target as HTMLInputElement).checked);
  }

  protected saveEdit(entry: ReviewMerchant): void {
    if (this.busy()) return;
    const displayName = this.draftName().trim();
    if (displayName === '') return;

    const patch = {
      displayName,
      // Empty select means "no default category", which is `null` and not `''` —
      // §3.2 stores it nullable and RESTRICTs it, so a blank string would be an
      // id that does not exist rather than an absence.
      defaultCategoryId: this.draftCategoryId() === '' ? null : this.draftCategoryId(),
      isKnownSubscription: this.draftSubscription(),
      isTransferKind: this.draftTransfer(),
    };

    this.edit.emit({ merchantId: entry.merchant.id, displayName, patch });

    // Applied locally as well, so the row keeps saying what was just saved even
    // though the next queue read will not carry it. The page still re-reads; this
    // is the fallback for the row that has left the queue by answering it, not a
    // second source of truth for the ones still in it.
    const saved: ReviewMerchant = {
      ...entry,
      merchant: { ...entry.merchant, ...patch, source: 'user' },
    };
    this.justEdited.update((current) => [
      ...current.filter((edited) => edited.merchant.id !== entry.merchant.id),
      saved,
    ]);

    this.editing.set(null);
  }

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

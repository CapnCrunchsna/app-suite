/**
 * §6.3's "apply to all N matching", for a **category**.
 *
 * §6.3 gives that affordance to merchant edits only — "Critically, every merchant
 * edit offers *apply to all 47 matching descriptors*" — and says nothing about the
 * category edit sitting next to it. That was survivable while a category was
 * cosmetic. It stopped being survivable when §9ad made `overlap_group` editable:
 * §5.4's category-overlap half reads the **modal category of a series' charges**, so
 * a group is only as good as the consistency of the categorization underneath it,
 * and consistency one row at a time over a year of statements is not something
 * anybody finishes. §9ag records the reasoning.
 *
 * ## Three decisions, and the first is the one that matters
 *
 * **The scope is the merchant, not the descriptor.** This is where it deliberately
 * departs from `MerchantAssign`. That component scopes to
 * `description_normalized` because a merchant correction is a statement about
 * *identity* — `SPOTIFYUSA` **is** Spotify — and identity is a property of the
 * spelling. A category is a statement about what the spending **is**, and that is a
 * property of the merchant: Spotify is music streaming whether the bank wrote
 * `SPOTIFYUSA`, `SPOTIFY USA 4029357733` or `PAYPAL *SPOTIFYUSA`. Scoping a category
 * to one spelling would catch a third of the charges and give no hint that it had,
 * which is worse than not offering the bulk path at all — §5.4's modal rule would
 * then see exactly the inconsistency §9d warns about.
 *
 * A row with no merchant falls back to its descriptor, because that is the only
 * handle it has.
 *
 * **The offer comes after the single write, not before it.** `MerchantAssign` arms
 * first and applies on an explicit second click, because §4.3 makes a merchant
 * correction permanent and precedence-topping. A category assignment is one nullable
 * column and is undone by picking another category, so the one-row edit stays one
 * click and the *bulk* change — the consequential half — is what gets armed. The
 * house rule is to arm what is consequential, not to arm everything.
 *
 * **The count is fetched, never computed.** Same argument `MerchantAssign` makes:
 * the number on the button is what the user is authorising, and one derived from the
 * loaded page would be wrong by however far they have not scrolled.
 *
 * Presentational. The page owns the count request and the write.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** What the page is offering to do, once the single row has already been written. */
export interface CategoryBulkOffer {
  readonly categoryId: string;
  readonly categoryName: string;
  /** Merchant where the row has one, its normalized descriptor where it does not. */
  readonly scopeKind: 'merchant' | 'descriptor';
  readonly scopeLabel: string;
  /** Every row the filter matches, the one just written included. */
  readonly matchCount: number;
}

@Component({
  selector: 'll-category-bulk-offer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let o = offer();
    <div class="offer" role="status">
      <p class="offer__what">
        @if (o.scopeKind === 'merchant') {
          <strong>{{ o.scopeLabel }}</strong> has {{ o.matchCount }} charges in all. File every
          one under <strong>{{ o.categoryName }}</strong
          >?
        } @else {
          <code>{{ o.scopeLabel }}</code> appears on {{ o.matchCount }} rows. File every one
          under <strong>{{ o.categoryName }}</strong
          >?
        }
      </p>

      <div class="offer__actions">
        <button type="button" class="offer__apply" [disabled]="busy()" (click)="apply.emit()">
          Apply to all {{ o.matchCount }}
        </button>
        <button type="button" class="offer__no" [disabled]="busy()" (click)="dismiss.emit()">
          Just this row
        </button>
      </div>

      <p class="offer__note">
        The {{ o.matchCount }} include every account and date, and rows hidden by the
        internal-transfer and excluded filters.
        @if (o.scopeKind === 'merchant') {
          Every spelling of this merchant is covered, not just the one on this row.
        }
        A category you set by hand outranks anything a rule later proposes, and the duplicate
        check and the monthly trends both read it — run an analysis to see it applied.
      </p>
    </div>
  `,
  styleUrl: './category-bulk-offer.scss',
})
export class CategoryBulkOfferPanel {
  readonly offer = input.required<CategoryBulkOffer>();
  readonly busy = input(false);

  readonly apply = output<void>();
  readonly dismiss = output<void>();
}

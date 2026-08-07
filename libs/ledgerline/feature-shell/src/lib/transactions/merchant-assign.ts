/**
 * §6.3's merchant edit, and the bulk offer that is the point of it.
 *
 * "Critically, every merchant edit offers **'apply to all 47 matching
 * descriptors'** — the count comes from `POST /api/transactions/bulk?dryRun=true`,
 * and that bulk correction path is what makes normalization converge in minutes
 * instead of row by row."
 *
 * ## The three decisions in this component
 *
 * **The count is fetched, never computed.** It would be easy to count the matching
 * rows in the page already loaded and show that. It would also be wrong by however
 * many pages the user has not scrolled to, and the number is the basis on which
 * they authorise a permanent, precedence-topping change (§4.3). So it comes from
 * the dry run, over the whole store, or it is not shown.
 *
 * **The bulk scope is the descriptor, not the current view.** A merchant
 * correction is a statement about identity — `SPOTIFYUSA` *is* Spotify — and that
 * is true regardless of which account or month the table happens to be filtered
 * to. Scoping it to the visible filter would leave the same descriptor resolving
 * two different ways in one database. The count therefore asks with
 * `includeInternalTransfers` and `includeExcluded` on, so a row hidden by either
 * default is still counted and still corrected.
 *
 * **Nothing is applied on selection.** Choosing a merchant from the list arms the
 * change and fetches the count; the user then picks one row or all N. §4.3 makes
 * either permanent, so neither happens on a `change` event.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Merchant, Transaction } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';

export interface MerchantAssignment {
  readonly merchantId: string;
  /** True when the user chose "apply to all N matching descriptors". */
  readonly applyToAll: boolean;
  /** The count they were shown, so the page can report what happened against what
   *  was promised. */
  readonly matchCount: number;
}

@Component({
  selector: 'll-merchant-assign',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="assign">
      <div class="assign__row">
        <label class="assign__label" [attr.for]="selectId()">Merchant</label>
        <select
          class="assign__select"
          [id]="selectId()"
          [ngModel]="chosen()"
          (ngModelChange)="choose($event)"
        >
          <option value="">— pick a merchant —</option>
          @for (merchant of merchants(); track merchant.id) {
            <option [value]="merchant.id">
              {{ merchant.displayName }}
              @if (merchant.source === 'rule') {
                · provisional
              }
            </option>
          }
        </select>
        <button type="button" class="assign__cancel" (click)="cancelled.emit()">Cancel</button>
      </div>

      <p class="assign__descriptor">
        Correcting <code>{{ transaction().descriptionNormalized }}</code>
      </p>

      @if (chosen()) {
        <div class="assign__actions">
          <button type="button" class="assign__apply" (click)="applyOne()">
            Apply to this row only
          </button>

          @if (counting()) {
            <button type="button" class="assign__apply assign__apply--bulk" disabled>
              Counting matching descriptors…
            </button>
          } @else if (countError()) {
            <span class="assign__error">Could not count matching rows: {{ countError() }}</span>
          } @else if (matchCount() !== null) {
            <button
              type="button"
              class="assign__apply assign__apply--bulk"
              (click)="applyAll()"
              [disabled]="matchCount() === 0"
            >
              Apply to all {{ matchCount() }} matching
              {{ matchCount() === 1 ? 'descriptor' : 'descriptors' }}
            </button>
          }
        </div>

        <p class="assign__note">
          A correction is permanent and outranks anything a rule or a model later proposes. It
          writes an alias for this descriptor and queues a re-normalize, so past charges regroup and
          future statements resolve without being asked again.
          @if (matchCount() !== null && matchCount()! > 1) {
            The {{ matchCount() }} include every account and date, and rows hidden by the
            internal-transfer and excluded filters.
          }
        </p>
      }
    </div>
  `,
  styleUrl: './merchant-assign.scss',
})
export class MerchantAssign {
  private readonly api = inject(LedgerlineApiService);

  readonly transaction = input.required<Transaction>();
  readonly merchants = input<readonly Merchant[]>([]);

  readonly assigned = output<MerchantAssignment>();
  readonly cancelled = output<void>();

  protected readonly chosen = signal('');
  protected readonly matchCount = signal<number | null>(null);
  protected readonly counting = signal(false);
  protected readonly countError = signal<string | null>(null);

  protected readonly selectId = computed(() => `merchant-${this.transaction().id}`);

  constructor() {
    // The count is per descriptor, so re-running it when the row changes is what
    // keeps a reused component instance from showing the previous row's number.
    effect(() => {
      const descriptor = this.transaction().descriptionNormalized;
      this.chosen.set('');
      this.matchCount.set(null);
      this.countError.set(null);
      void this.count(descriptor);
    });
  }

  private async count(descriptorNormalized: string): Promise<void> {
    this.counting.set(true);
    try {
      const result = await this.api.countMatching({
        descriptorsNormalized: [descriptorNormalized],
        includeInternalTransfers: true,
        includeExcluded: true,
      });
      // A late response for a descriptor the user has moved on from must not
      // overwrite the current one.
      if (this.transaction().descriptionNormalized !== descriptorNormalized) return;
      this.matchCount.set(result.matchCount);
    } catch (cause) {
      if (this.transaction().descriptionNormalized !== descriptorNormalized) return;
      this.countError.set((cause as Error).message);
    } finally {
      this.counting.set(false);
    }
  }

  protected choose(merchantId: string): void {
    this.chosen.set(merchantId);
  }

  protected applyOne(): void {
    this.assigned.emit({
      merchantId: this.chosen(),
      applyToAll: false,
      matchCount: this.matchCount() ?? 1,
    });
  }

  protected applyAll(): void {
    this.assigned.emit({
      merchantId: this.chosen(),
      applyToAll: true,
      matchCount: this.matchCount() ?? 0,
    });
  }
}

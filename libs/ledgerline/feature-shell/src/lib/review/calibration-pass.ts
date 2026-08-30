/**
 * §7.6's afternoon, made into something you can actually sit down to (§9ab).
 *
 * "The first phase that ships analyzers also ships a fixture corpus — a hand-labelled
 * year of real statements with the expected findings written down — and every
 * threshold is re-derived against it before the numbers in this document are treated
 * as settled."
 *
 * ## The pass is one row at a time, and the keyboard is the point
 *
 * A year of statements is several hundred rows. A form with five dropdowns per row
 * would make §7.6's afternoon a week, so the whole interaction is single keys on a
 * focused row: `r` recurring, `f` fee, `t` transfer, `o` outlier, `n` nothing special,
 * `j`/`k` or the arrows to move. Anything that needs a merchant picked is a different,
 * slower action and belongs on §6.3's page, which already has one — this pass records
 * *what a row is*, not what it should be called.
 *
 * ## "Nothing special" is a real answer and has its own key
 *
 * §9ab's schema makes an unasserted flag and a flag asserted false different facts,
 * and this is where that distinction is earned or lost. A pass that only let you say
 * "yes" would produce a corpus of nothing but positives, against which every rule
 * scores perfectly — the misses are visible only because most rows are explicitly
 * ordinary. `n` writes four falses at once, which is what makes it fast enough to be
 * used on the eighty percent of rows where it is the truth.
 *
 * Presentational: the container owns every request.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { Transaction, TransactionLabel } from '@metrum/api-client';

/** What one keystroke asserts. `nothing` is the four-false shorthand. */
export type Assertion = 'recurring' | 'fee' | 'transfer' | 'outlier' | 'nothing' | 'clear';

export interface AssertionEvent {
  readonly transaction: Transaction;
  readonly assertion: Assertion;
}

@Component({
  selector: 'll-calibration-pass',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './calibration-pass.html',
  styleUrl: './calibration-pass.scss',
  host: {
    '(keydown)': 'onKey($event)',
    tabindex: '0',
  },
})
export class CalibrationPass {
  readonly rows = input.required<readonly Transaction[]>();
  readonly labels = input<Record<string, TransactionLabel>>({});
  readonly busy = input(false);
  readonly progress = input<{ labelled: number; total: number } | null>(null);

  readonly asserted = output<AssertionEvent>();

  protected readonly cursor = signal(0);

  protected readonly current = computed(() => this.rows()[this.cursor()] ?? null);

  protected labelFor(transaction: Transaction): TransactionLabel | null {
    return this.labels()[transaction.id] ?? null;
  }

  /**
   * What a row has been said to be, as words rather than five ticks.
   *
   * Only the assertions that are *true* are named, plus an explicit "nothing special"
   * where every flag is false. A row showing four crosses and one tick is a puzzle;
   * "recurring" is a sentence.
   */
  protected summaryOf(transaction: Transaction): string | null {
    const label = this.labelFor(transaction);
    if (!label) return null;

    const said: string[] = [];
    if (label.isRecurring) said.push('recurring');
    if (label.isFee) said.push('a fee');
    if (label.isTransfer) said.push('a transfer');
    if (label.isOutlier) said.push('unusual');

    if (said.length > 0) return said.join(', ');

    const anyAsserted =
      label.isRecurring !== null ||
      label.isFee !== null ||
      label.isTransfer !== null ||
      label.isOutlier !== null;

    return anyAsserted ? 'nothing special' : null;
  }

  /** True where the *app* disagrees with what you said about the merchant — the
   *  single most useful thing to see while passing, and the reason `chainMerchantId`
   *  is on the label at all. */
  protected disagrees(transaction: Transaction): boolean {
    const label = this.labelFor(transaction);
    return (
      label !== null &&
      label.expectedMerchantId !== null &&
      label.chainMerchantId !== null &&
      label.expectedMerchantId !== label.chainMerchantId
    );
  }

  protected select(index: number): void {
    this.cursor.set(Math.min(Math.max(index, 0), Math.max(this.rows().length - 1, 0)));
  }

  protected assert(assertion: Assertion): void {
    const transaction = this.current();
    if (!transaction || this.busy()) return;

    this.asserted.emit({ transaction, assertion });

    // Advance on anything that settles the row. `clear` deliberately does not —
    // withdrawing a judgement is usually the start of re-making it.
    if (assertion !== 'clear') this.select(this.cursor() + 1);
  }

  /**
   * The keyboard. Single keys, no modifiers, because a pass is hundreds of rows and
   * a chord per row is a chord too many.
   */
  protected onKey(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();

    const move: Record<string, number> = { j: 1, arrowdown: 1, k: -1, arrowup: -1 };
    if (key in move) {
      event.preventDefault();
      this.select(this.cursor() + move[key]);
      return;
    }

    const assertions: Record<string, Assertion> = {
      r: 'recurring',
      f: 'fee',
      t: 'transfer',
      o: 'outlier',
      n: 'nothing',
      x: 'clear',
    };
    if (key in assertions) {
      event.preventDefault();
      this.assert(assertions[key]);
    }
  }

  protected money(cents: number): string {
    return `$${(Math.abs(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

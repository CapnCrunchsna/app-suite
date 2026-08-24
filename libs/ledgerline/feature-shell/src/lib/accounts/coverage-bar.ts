/**
 * §6.2's coverage bar: "a strip of month cells showing which months you have
 * statements for".
 *
 * "Gaps are visible at a glance, which matters because most findings degrade
 * quietly with missing months and because §5.10 and §5.11 refuse to compute over
 * partial months at all."
 *
 * That sentence is the whole argument for the component. Every number on §6.4 is
 * a sum over the months that happen to be imported, and a missing month makes a
 * subscription look cancelled, a category look cheaper and a price step look like
 * it never held. The bar is the precondition for trusting any of it, so it is
 * rendered as *evidence* rather than decoration: one cell per month with no gaps
 * in the strip itself, and a legend that says what each state means.
 *
 * ## Three states, and the middle one is no longer the common one
 *
 * §7.2 makes a month covered only when a committed import's period spans it. A
 * profile that carries a `periodPattern` reads the period the statement itself
 * declares, so an ordinary January statement running the 3rd to the 30th now
 * spans January and the cell goes green (§9h). Before that, the periods were the
 * first and last row dates and almost every cell was `partial` (§9f).
 *
 * `partial` stays, because it is still the honest answer for a statement that
 * genuinely covers half a month — a mid-cycle export, two halves of one month, or
 * a bank whose preamble no profile reads yet. Painting those red would claim a
 * statement is missing when it is sitting in the database; painting them green
 * would promise §5.10 and §5.11 a complete month they are entitled to refuse. The
 * legend explains it rather than leaving a colour to be guessed at.
 *
 * Presentational. It renders what it is given and fetches nothing.
 */

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { AccountCoverage, CoverageMonth } from '@metrum/api-client';

/** `2026-01` → `Jan 2026`, for the tooltip. Built from the label rather than a
 *  `Date`, because these are calendar labels and constructing a `Date` invites a
 *  timezone shift (the same reason `monthOf` slices strings in `analyzers`). */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const STATE_TITLE: Record<CoverageMonth['state'], string> = {
  covered: 'a statement spans this whole month',
  partial: 'a statement covers part of this month',
  missing: 'no statement for this month',
};

/** `2026-01` → `Jan 2026`. */
const label = (month: string): string =>
  `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

@Component({
  selector: 'll-coverage-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let data = coverage();

    @if (data === null) {
      <p class="bar__empty">Loading coverage…</p>
    } @else if (data.months.length === 0) {
      <p class="bar__empty">
        No statements imported. Every finding for this account is computed over nothing.
      </p>
    } @else {
      <div class="bar" role="img" [attr.aria-label]="summary()">
        @for (month of data.months; track month.month) {
          <span
            class="cell"
            [class.cell--covered]="month.state === 'covered'"
            [class.cell--partial]="month.state === 'partial'"
            [class.cell--missing]="month.state === 'missing'"
            [attr.data-month]="month.month"
            [title]="titleFor(month)"
          ></span>
        }
      </div>

      <p class="bar__legend">
        <span class="bar__span">{{ span() }}</span>
        <span class="swatch swatch--covered"></span> spans the month
        <span class="swatch swatch--partial"></span> partial
        <span class="swatch swatch--missing"></span> missing
        @if (data.coverageEnd) {
          <span class="bar__end">· liveness measured to {{ data.coverageEnd }}</span>
        }
      </p>

      @if (data.gapMonths.length > 0) {
        <p class="bar__warning">
          {{ data.gapMonths.length }}
          {{ data.gapMonths.length === 1 ? 'month has' : 'months have' }}
          no statement at all ({{ gapSummary() }}). Findings over this account are computed as if
          nothing happened in {{ data.gapMonths.length === 1 ? 'it' : 'them' }}.
        </p>
      }

      @if (data.unmatchedTransferCount > 0) {
        <p class="bar__warning">
          {{ data.unmatchedTransferCount }}
          {{ data.unmatchedTransferCount === 1 ? 'transfer' : 'transfers' }}
          out of this account
          {{ data.unmatchedTransferCount === 1 ? 'has' : 'have' }}
          no counterpart in the system, so
          {{ data.unmatchedTransferCount === 1 ? 'it counts' : 'they count' }}
          as spending. Import the other side of the account
          {{ data.unmatchedTransferCount === 1 ? 'it went' : 'they went' }} to.
        </p>
      }
    }
  `,
  styleUrl: './coverage-bar.scss',
})
export class CoverageBar {
  readonly coverage = input<AccountCoverage | null>(null);

  protected titleFor(month: CoverageMonth): string {
    const rows = `${month.transactionCount} ${month.transactionCount === 1 ? 'row' : 'rows'}`;
    return `${label(month.month)} — ${STATE_TITLE[month.state]}, ${rows}`;
  }

  /**
   * The span the strip covers, in words.
   *
   * Named rather than left to per-cell year labels. A strip of a hundred and
   * twenty months cannot carry a readable date on every cell, and one of two
   * months carrying a floating `26` reads as a stray number rather than as an
   * axis — so the range is stated once and the cells stay unlabelled.
   */
  protected readonly span = computed(() => {
    const months = this.coverage()?.months ?? [];
    if (months.length === 0) return '';
    const first = label(months[0].month);
    const last = label(months[months.length - 1].month);
    return first === last ? first : `${first} – ${last}`;
  });

  /** Named for the screen reader, because a strip of coloured cells is not
   *  information without it. */
  protected readonly summary = computed(() => {
    const data = this.coverage();
    if (!data) return 'coverage unknown';

    const covered = data.months.filter((month) => month.state === 'covered').length;
    const partial = data.months.filter((month) => month.state === 'partial').length;
    return (
      `${data.months.length} months: ${covered} fully covered, ` +
      `${partial} partial, ${data.gapMonths.length} missing`
    );
  });

  /** The first few gaps by name. Truncated rather than listed in full: a
   *  three-year hole is a sentence, not a paragraph. */
  protected readonly gapSummary = computed(() => {
    const gaps = this.coverage()?.gapMonths ?? [];
    return gaps.length <= 3
      ? gaps.join(', ')
      : `${gaps.slice(0, 3).join(', ')} and ${gaps.length - 3} more`;
  });
}

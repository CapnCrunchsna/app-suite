/**
 * §6.5's month strip: "shows which days charges land — genuinely useful for cash flow."
 *
 * Thirty-one cells, one per day of the month, each carrying the subscriptions that bill
 * on it. The value is not the individual dates — the table already has those — it is the
 * *shape*: whether the month's outgoings are spread out or all land on the 1st, which is
 * the difference between a comfortable month and an overdraft.
 *
 * ## Day of month, taken from the charges rather than from `next_expected`
 *
 * `next_expected` is one projected date and §5.2 measures it from the account's coverage
 * end, so for a lapsed series it is a date in the past that never happened. The days a
 * series *has* billed on are observed fact, and the modal one is what it will bill on
 * again. Weekly and biweekly series have no stable day of month at all, which the strip
 * shows honestly by marking every day they have actually landed on.
 *
 * ## The 29th, 30th and 31st
 *
 * A subscription billing on the 31st does not bill in February, and one billing on the
 * 29th bills three times in four years on a date that does not exist in the others. The
 * strip renders all 31 cells regardless: shrinking to the current month's length would
 * make the same series jump position between months, and the point of the strip is that
 * the shape stays put.
 *
 * Presentational. It renders what it is given and fetches nothing.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Series } from '@metrum/api-client';

/** One day's worth of billing, as the strip renders it. */
export interface StripDay {
  readonly day: number;
  readonly series: readonly { readonly id: string; readonly label: string }[];
  readonly cents: number;
}

const DAYS_IN_STRIP = 31;

@Component({
  selector: 'll-month-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let strip = days();
    @let peak = busiestCents();

    <div class="strip" role="list" [attr.aria-label]="summary()">
      @for (entry of strip; track entry.day) {
        <button
          type="button"
          role="listitem"
          class="strip__day"
          [class.strip__day--empty]="entry.series.length === 0"
          [class.strip__day--loaded]="entry.series.length > 0"
          [style.--fill]="peak === 0 ? 0 : entry.cents / peak"
          [disabled]="entry.series.length === 0"
          [title]="titleFor(entry)"
          (click)="daySelected.emit(entry)"
        >
          <span class="strip__number">{{ entry.day }}</span>
          @if (entry.series.length > 0) {
            <span class="strip__bar"></span>
          }
        </button>
      }
    </div>

    <p class="strip__legend">
      @if (peak === 0) {
        No charge history yet — run an analysis to populate the ledger.
      } @else {
        Taller is more money. Busiest day: the
        {{ ordinal(busiestDay()) }}, {{ formatCents(peak) }} across
        {{ busiestCount() }}
        {{ busiestCount() === 1 ? 'subscription' : 'subscriptions' }}.
      }
    </p>
  `,
  styleUrl: './month-strip.scss',
})
export class MonthStrip {
  readonly series = input.required<readonly Series[]>();
  readonly merchantNames = input<ReadonlyMap<string, string>>(new Map());

  readonly daySelected = output<StripDay>();

  protected readonly formatCents = formatCents;

  /**
   * The day a series bills on, as the mode of the days it has actually billed on.
   *
   * The mode rather than the latest charge, because one statement pulled a day early
   * should not move a subscription's whole position on the strip. Ties break to the
   * earlier day, which is the conservative reading for cash flow — it says the money
   * leaves sooner.
   */
  private modalDayOf(entry: Series): number | null {
    if (entry.charges.length === 0) return null;

    const counts = new Map<number, number>();
    for (const charge of entry.charges) {
      const day = Number(charge.effectiveDate.slice(8, 10));
      if (!Number.isFinite(day) || day < 1 || day > DAYS_IN_STRIP) continue;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }

    let best: number | null = null;
    let bestCount = 0;
    for (const [day, count] of [...counts.entries()].sort(([a], [b]) => a - b)) {
      if (count > bestCount) {
        best = day;
        bestCount = count;
      }
    }
    return best;
  }

  protected readonly days = computed<StripDay[]>(() => {
    const buckets: StripDay[] = Array.from({ length: DAYS_IN_STRIP }, (_, index) => ({
      day: index + 1,
      series: [],
      cents: 0,
    }));

    for (const entry of this.series()) {
      // §6.5's strip is about money still going out. A cancelled subscription's
      // history is real but it is not next month's cash flow.
      if (entry.effectiveStatus === 'cancelled') continue;

      const day = this.modalDayOf(entry);
      if (day === null) continue;

      const bucket = buckets[day - 1];
      buckets[day - 1] = {
        day: bucket.day,
        series: [
          ...bucket.series,
          { id: entry.id, label: this.merchantNames().get(entry.merchantId) ?? entry.merchantId },
        ],
        cents: bucket.cents + Math.abs(entry.amountCentsCurrent ?? 0),
      };
    }

    return buckets;
  });

  private readonly busiest = computed(() =>
    this.days().reduce((top, entry) => (entry.cents > top.cents ? entry : top), {
      day: 0,
      series: [],
      cents: 0,
    } as StripDay),
  );

  protected readonly busiestCents = computed(() => this.busiest().cents);
  protected readonly busiestDay = computed(() => this.busiest().day);
  protected readonly busiestCount = computed(() => this.busiest().series.length);

  protected readonly summary = computed(() => {
    const loaded = this.days().filter((entry) => entry.series.length > 0);
    return loaded.length === 0
      ? 'No recurring charges to place in the month.'
      : `Recurring charges land on ${loaded.length} ${
          loaded.length === 1 ? 'day' : 'days'
        } of the month.`;
  });

  protected titleFor(entry: StripDay): string {
    if (entry.series.length === 0) return `${this.ordinal(entry.day)} — nothing recurring`;
    return `${this.ordinal(entry.day)} — ${formatCents(entry.cents)}: ${entry.series
      .map((s) => s.label)
      .join(', ')}`;
  }

  protected ordinal(day: number): string {
    const suffix =
      day % 100 >= 11 && day % 100 <= 13
        ? 'th'
        : day % 10 === 1
          ? 'st'
          : day % 10 === 2
            ? 'nd'
            : day % 10 === 3
              ? 'rd'
              : 'th';
    return `${day}${suffix}`;
  }
}

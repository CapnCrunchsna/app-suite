/**
 * §6.5's detail drawer.
 *
 * "The detail drawer holds the full charge history as a chart with price-change markers,
 * the price-step table, a user-entered cancellation URL and notes field, and a manual
 * 'mark cancelled' override — all three persisted via `PATCH /api/series/:id` [...] A
 * manual status always beats the computed one."
 *
 * Presentational, like every other child on these four pages: it renders what it is
 * given and emits what the user chose. The page owns every request.
 *
 * ## The chart is the charge list, not a re-derivation
 *
 * Both the charges and the price steps arrive on the series, stored by the analysis run
 * that fitted it (§9i). Nothing here infers a step from the amounts — §5.5 decided which
 * changes were material and which held, and a chart that marked its own steps would draw
 * markers the analyzer did not agree with, on the same screen as the table that lists
 * the ones it did.
 *
 * ## Why the override is three buttons and not a checkbox
 *
 * The stored value has three states — `active`, `lapsed`, `cancelled` — plus "no
 * override", and the fourth is not the absence of a preference but a distinct choice:
 * *let §5.2 decide*. A checkbox would collapse "I cancelled this" and "I have no opinion"
 * into one unchecked box, and the user would have no way back to the computed answer
 * once they had touched it.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { formatCents } from '@metrum/ledgerline-domain';
import type { Series, SeriesCharge } from '@metrum/api-client';

export type SeriesStatusChoice = 'active' | 'lapsed' | 'cancelled';

export interface SeriesEditEvent {
  readonly series: Series;
  readonly patch: {
    readonly userStatus?: SeriesStatusChoice | null;
    readonly cancellationUrl?: string | null;
    readonly notes?: string | null;
  };
}

/** One plotted charge, in the chart's own coordinate space. */
interface Point {
  readonly x: number;
  readonly y: number;
  readonly charge: SeriesCharge;
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 140;
const PAD_X = 8;
const PAD_Y = 12;

@Component({
  selector: 'll-series-detail',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './series-detail.html',
  styleUrl: './series-detail.scss',
})
export class SeriesDetail {
  readonly series = input.required<Series>();
  readonly merchantName = input<string | null>(null);
  readonly accountName = input<string | null>(null);
  readonly busy = input(false);

  readonly edited = output<SeriesEditEvent>();
  readonly closed = output<void>();

  protected readonly formatCents = formatCents;

  /**
   * Local edit buffers, re-seeded whenever the series changes.
   *
   * `linkedSignal` rather than a plain signal plus a reset: opening a different row
   * must not carry the last one's half-typed note, and a saved edit must show the
   * value that came back from the API rather than the one that was typed. Both are
   * "writable state derived from an input", which is the one thing linkedSignal is
   * for — and it keeps the reset out of a `computed`, where a side effect would be a
   * bug waiting for the first time Angular skipped an unread computation.
   */
  protected readonly urlDraft = linkedSignal(() => this.series().cancellationUrl ?? '');
  protected readonly notesDraft = linkedSignal(() => this.series().notes ?? '');

  // ------------------------------------------------------------- chart ---

  /**
   * The charge history as points, scaled to the drawer's box.
   *
   * The y-axis is deliberately **not** zero-based. A subscription that went from
   * $15.49 to $17.99 is a 16% rise, and against a zero baseline that is two marks
   * at almost the same height — the one thing the chart exists to show, flattened.
   * §5.5's price steps are the story here, so the axis frames the range the prices
   * actually occupy and the drawer states both bounds in the caption.
   */
  protected readonly points = computed<Point[]>(() => {
    const charges = this.series().charges;
    if (charges.length === 0) return [];

    const amounts = charges.map((charge) => Math.abs(charge.amountCents));
    const low = Math.min(...amounts);
    const high = Math.max(...amounts);
    const span = high - low || 1;
    const usableX = CHART_WIDTH - PAD_X * 2;
    const usableY = CHART_HEIGHT - PAD_Y * 2;

    return charges.map((charge, index) => ({
      x:
        charges.length === 1
          ? CHART_WIDTH / 2
          : PAD_X + (index / (charges.length - 1)) * usableX,
      y: PAD_Y + usableY - ((Math.abs(charge.amountCents) - low) / span) * usableY,
      charge,
    }));
  });

  protected readonly linePath = computed(() =>
    this.points()
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(' '),
  );

  /** The x positions of §5.5's steps, matched to the charge that starts each one.
   *  Matched by date rather than recomputed — see the header. */
  protected readonly stepMarkers = computed(() => {
    const points = this.points();
    return this.series()
      .priceSteps.map((step) => {
        const point = points.find((candidate) => candidate.charge.effectiveDate === step.at);
        return point ? { x: point.x, step } : null;
      })
      .filter((marker): marker is { x: number; step: Series['priceSteps'][number] } => marker !== null);
  });

  protected readonly amountRange = computed(() => {
    const amounts = this.series().charges.map((charge) => Math.abs(charge.amountCents));
    return amounts.length === 0
      ? null
      : { low: Math.min(...amounts), high: Math.max(...amounts) };
  });

  protected readonly chartWidth = CHART_WIDTH;
  protected readonly chartHeight = CHART_HEIGHT;

  // ----------------------------------------------------------- handlers ---

  protected saveUrl(): void {
    const next = this.urlDraft().trim();
    if (next === (this.series().cancellationUrl ?? '')) return;
    this.edited.emit({ series: this.series(), patch: { cancellationUrl: next } });
  }

  protected saveNotes(): void {
    const next = this.notesDraft().trim();
    if (next === (this.series().notes ?? '')) return;
    this.edited.emit({ series: this.series(), patch: { notes: next } });
  }

  /** Clicking the status already in force clears the override rather than
   *  re-asserting it, which is the only way back to §5.2's computed answer. */
  protected chooseStatus(choice: SeriesStatusChoice): void {
    const entry = this.series();
    const next = entry.userStatus === choice ? null : choice;
    this.edited.emit({ series: entry, patch: { userStatus: next } });
  }

  protected chargeTitle(charge: SeriesCharge): string {
    return `${charge.effectiveDate} — ${formatCents(Math.abs(charge.amountCents))}`;
  }
}

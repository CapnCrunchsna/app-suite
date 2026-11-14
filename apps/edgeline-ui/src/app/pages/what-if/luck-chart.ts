/**
 * Running P&L against the luck band (the What-if page, 2026-11-13).
 *
 * One plotted series, the actual running P&L. The expected line, from each bet's
 * CLV, is a reference drawn dashed, as a projection rather than as data, and the
 * two shaded bands are ±1 and ±2 sd of luck around it. A line inside the inner
 * band is ordinary; outside the outer one, luck stops being the explanation.
 *
 * Plain SVG in a fixed 800×240 coordinate space stretched to the container,
 * with `non-scaling-stroke` so lines stay 2px whatever the width. Axis labels
 * and the tooltip are HTML on top, so text is never stretched. The hover
 * crosshair works by pointer and by keyboard (arrows, Home, End), and the
 * page's bet table carries every value too, so the tooltip never gates one.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { formatLocalDay, formatSignedCents } from '@metrum/format';

import { toAmerican } from '../../formatting';
import { marketLabel, sportLabel } from '../../labels';
import type { Point } from './what-if-math';

const W = 800;
const H = 240;

interface Tick {
  readonly y: number;
  readonly label: string;
}

@Component({
  selector: 'el-luck-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="legend" aria-hidden="true">
      <li><span class="swatch swatch--actual"></span>Actual P&amp;L</li>
      <li><span class="swatch swatch--expected"></span>Expected at the close</li>
      <li><span class="swatch swatch--band1"></span>Luck range, ±1 sd (2 runs in 3)</li>
      <li><span class="swatch swatch--band2"></span>±2 sd (19 in 20)</li>
    </ul>
    @if (points().length < 2) {
      <p class="empty">Not enough bets in this view to draw a run.</p>
    } @else {
      <div
        class="plot"
        tabindex="0"
        role="img"
        [attr.aria-label]="summary()"
        (pointermove)="hover($event)"
        (pointerleave)="active.set(null)"
        (keydown)="key($event)"
        (blur)="active.set(null)"
      >
        <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" preserveAspectRatio="none" aria-hidden="true">
          @for (tick of ticks(); track tick.y) {
            <line class="grid" x1="0" [attr.x2]="width" [attr.y1]="tick.y" [attr.y2]="tick.y" />
          }
          <path class="band2" [attr.d]="band(2)" />
          <path class="band1" [attr.d]="band(1)" />
          <line class="zero" x1="0" [attr.x2]="width" [attr.y1]="y(0)" [attr.y2]="y(0)" />
          <path class="expected" [attr.d]="line('expected')" />
          <path class="actual" [attr.d]="line('actual')" />
          @if (hovered(); as point) {
            <line class="cross" [attr.x1]="x(point.index)" [attr.x2]="x(point.index)" y1="0" [attr.y2]="height" />
          }
        </svg>
        @for (tick of ticks(); track tick.y) {
          <span class="tick" [style.top.%]="(tick.y / height) * 100">{{ tick.label }}</span>
        }
        @if (hovered(); as point) {
          <span
            class="dot"
            [style.left.%]="(x(point.index) / width) * 100"
            [style.top.%]="(y(point.actualCents) / height) * 100"
          ></span>
          <div class="tip" [class.tip--left]="point.index > points().length / 2" [style.left.%]="(x(point.index) / width) * 100">
            <strong>Bet {{ point.index }} · {{ day(point.bet.row.starts_at) }}</strong>
            <span>{{ pick(point) }}</span>
            <span>Running P&amp;L <b>{{ money(point.actualCents) }}</b></span>
            <span>Expected {{ money(point.expectedCents) }}</span>
            <span>Luck range {{ money(point.expectedCents - point.sdCents) }} to {{ money(point.expectedCents + point.sdCents) }}</span>
          </div>
        }
      </div>
      <div class="xaxis" aria-hidden="true">
        <span>{{ day(points()[0].bet.row.starts_at) }}</span>
        <span>{{ points().length }} bets, in the order the games started</span>
        <span>{{ day(points()[points().length - 1].bet.row.starts_at) }}</span>
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 10px; padding: 0; list-style: none;
      color: var(--text-dim); font-size: 0.8rem; }
    .legend li { display: flex; align-items: center; gap: 6px; }
    .swatch { display: inline-block; width: 18px; height: 10px; border-radius: 2px; }
    .swatch--actual { height: 2px; background: var(--accent); }
    .swatch--expected { height: 0; border-top: 2px dashed var(--text-dim); }
    .swatch--band1 { background: color-mix(in srgb, var(--text-dim) 30%, transparent); }
    .swatch--band2 { background: color-mix(in srgb, var(--text-dim) 14%, transparent); }
    .plot { position: relative; height: 260px; margin-left: 64px; outline-offset: 4px; touch-action: pan-y; }
    svg { display: block; width: 100%; height: 100%; overflow: visible; }
    path, line { vector-effect: non-scaling-stroke; fill: none; }
    .grid { stroke: var(--border); stroke-width: 1; }
    .zero { stroke: var(--text-dim); stroke-width: 1; }
    .band2 { fill: color-mix(in srgb, var(--text-dim) 14%, transparent); }
    .band1 { fill: color-mix(in srgb, var(--text-dim) 30%, transparent); }
    .expected { stroke: var(--text-dim); stroke-width: 2; stroke-dasharray: 5 4; }
    .actual { stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; }
    .cross { stroke: var(--text-dim); stroke-width: 1; }
    .tick { position: absolute; right: calc(100% + 8px); transform: translateY(-50%);
      color: var(--text-dim); font-size: 0.75rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dot { position: absolute; width: 10px; height: 10px; border: 2px solid var(--surface); border-radius: 50%;
      background: var(--accent); transform: translate(-50%, -50%); pointer-events: none; }
    .tip { position: absolute; top: 4px; display: flex; flex-direction: column; gap: 1px; min-width: 210px;
      margin-left: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius);
      background: var(--surface-2); font-size: 0.8rem; pointer-events: none; z-index: 1; }
    .tip--left { transform: translateX(calc(-100% - 24px)); }
    .tip b { font-variant-numeric: tabular-nums; }
    .xaxis { display: flex; justify-content: space-between; gap: 12px; margin: 6px 0 0 64px;
      color: var(--text-dim); font-size: 0.75rem; }
  `,
})
export class LuckChart {
  readonly points = input.required<readonly Point[]>();
  protected readonly width = W;
  protected readonly height = H;
  protected readonly active = signal<number | null>(null);

  /** The y domain: every line and both bands, and zero. */
  private readonly domain = computed(() => {
    let lo = 0, hi = 0;
    for (const p of this.points()) {
      lo = Math.min(lo, p.actualCents, p.expectedCents - 2 * p.sdCents);
      hi = Math.max(hi, p.actualCents, p.expectedCents + 2 * p.sdCents);
    }
    const pad = (hi - lo) * 0.06 || 100;
    return { lo: lo - pad, hi: hi + pad };
  });

  protected readonly ticks = computed<Tick[]>(() => {
    const { lo, hi } = this.domain();
    const raw = (hi - lo) / 5;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
    const ticks: Tick[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ticks.push({ y: this.y(v), label: formatSignedCents(Math.round(v)).replace(/\.00$/, '') });
    }
    return ticks;
  });

  protected readonly hovered = computed(() => {
    const index = this.active();
    return index === null ? null : (this.points()[index] ?? null);
  });

  protected readonly summary = computed(() => {
    const points = this.points();
    const last = points[points.length - 1];
    if (!last) return '';
    return `Running P&L over ${points.length} bets ends at ${this.money(last.actualCents)}, against ` +
      `${this.money(last.expectedCents)} expected and a luck range of ${this.money(last.expectedCents - last.sdCents)} ` +
      `to ${this.money(last.expectedCents + last.sdCents)}. Use the arrow keys to read each bet.`;
  });

  protected x(index: number): number {
    return (index / Math.max(this.points().length, 1)) * W;
  }

  protected y(cents: number): number {
    const { lo, hi } = this.domain();
    return H - ((cents - lo) / (hi - lo)) * H;
  }

  /** From the origin (bet 0, nothing staked) through every bet. */
  protected line(which: 'actual' | 'expected'): string {
    const pts = this.points().map((p) => [this.x(p.index), this.y(which === 'actual' ? p.actualCents : p.expectedCents)]);
    return `M${this.x(0)},${this.y(0)}` + pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('');
  }

  protected band(k: number): string {
    const points = this.points();
    const upper = points.map((p) => `L${this.x(p.index).toFixed(1)},${this.y(p.expectedCents + k * p.sdCents).toFixed(1)}`);
    const lower = [...points].reverse().map((p) => `L${this.x(p.index).toFixed(1)},${this.y(p.expectedCents - k * p.sdCents).toFixed(1)}`);
    return `M${this.x(0)},${this.y(0)}${upper.join('')}${lower.join('')}Z`;
  }

  protected hover(event: PointerEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const n = this.points().length;
    const index = Math.round(((event.clientX - box.left) / box.width) * n) - 1;
    this.active.set(Math.min(n - 1, Math.max(0, index)));
  }

  protected key(event: KeyboardEvent): void {
    const n = this.points().length;
    const now = this.active() ?? n - 1;
    const next =
      event.key === 'ArrowLeft' ? now - 1 : event.key === 'ArrowRight' ? now + 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : null;
    if (next === null) return;
    event.preventDefault();
    this.active.set(Math.min(n - 1, Math.max(0, next)));
  }

  protected money(cents: number): string {
    return formatSignedCents(Math.round(cents));
  }

  protected day(iso: string): string {
    return formatLocalDay(iso);
  }

  protected pick(point: Point): string {
    const row = point.bet.row;
    return `${sportLabel(row.sport_key)} · ${row.selection} ${marketLabel(row.market_key).toLowerCase()} ` +
      `${toAmerican(row.price_decimal)} · ${row.outcome}`;
  }
}

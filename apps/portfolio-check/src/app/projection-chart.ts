import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { YearPoint } from './calc/projection';
import { money, moneyShort } from './format';

const W = 640;
const H = 260;
const PAD = { top: 16, right: 92, bottom: 28, left: 64 };

/**
 * Two lines over the horizon: the current setup and the index portfolio.
 *
 * Identity is carried twice — hue (accent vs ai token) and dash (current setup is
 * dashed) — plus a legend and end-of-line labels, so it never rests on colour.
 * Hover gives a crosshair and both values for that year; the milestone table
 * beside it is the non-visual view of the same numbers.
 */
@Component({
  selector: 'pc-projection-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="legend" aria-hidden="true">
      <span class="legend__item"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" class="line line--current" /></svg>Current setup</span>
      <span class="legend__item"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" class="line line--index" /></svg>Index portfolio</span>
    </div>
    <div class="wrap">
      <svg
        [attr.viewBox]="'0 0 ' + w + ' ' + h"
        role="img"
        [attr.aria-label]="summary()"
        (pointermove)="hover($event)"
        (pointerleave)="hovered.set(null)"
      >
        @for (t of yTicks(); track t.value) {
          <line class="grid" [attr.x1]="pad.left" [attr.x2]="w - pad.right" [attr.y1]="t.y" [attr.y2]="t.y" />
          <text class="axis" [attr.x]="pad.left - 8" [attr.y]="t.y + 4" text-anchor="end">{{ t.label }}</text>
        }
        @for (t of xTicks(); track t.year) {
          <text class="axis" [attr.x]="t.x" [attr.y]="h - 8" text-anchor="middle">{{ t.label }}</text>
        }
        <path class="line line--index" [attr.d]="indexPath()" />
        <path class="line line--current" [attr.d]="currentPath()" />
        @if (ends(); as e) {
          <text class="end" [attr.x]="w - pad.right + 8" [attr.y]="e.index + 4">Index</text>
          <text class="end" [attr.x]="w - pad.right + 8" [attr.y]="e.current + 4">Current</text>
        }
        @if (hoverPoint(); as p) {
          <line class="crosshair" [attr.x1]="p.x" [attr.x2]="p.x" [attr.y1]="pad.top" [attr.y2]="h - pad.bottom" />
          <circle class="dot dot--index" [attr.cx]="p.x" [attr.cy]="p.yIndex" r="4" />
          <circle class="dot dot--current" [attr.cx]="p.x" [attr.cy]="p.yCurrent" r="4" />
        }
      </svg>
      @if (hoverPoint(); as p) {
        <div class="tip" [style.left.%]="(p.x / w) * 100">
          <strong>Year {{ p.year }}</strong>
          <span>Index {{ money(p.index) }}</span>
          <span>Current {{ money(p.current) }}</span>
          <span class="tip__gap">Gap {{ money(p.index - p.current) }}</span>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .legend { display: flex; gap: 18px; margin-bottom: 6px; color: var(--text-dim); font-size: 0.82rem; }
    .legend__item { display: inline-flex; align-items: center; gap: 6px; }
    .wrap { position: relative; }
    svg { display: block; width: 100%; height: auto; overflow: visible; }
    .grid { stroke: var(--border); stroke-width: 1; opacity: 0.6; }
    .axis, .end { fill: var(--text-dim); font-size: 11px; }
    .end { fill: var(--text); font-size: 12px; }
    .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .line--index { stroke: var(--accent); }
    .line--current { stroke: var(--ai); stroke-dasharray: 6 4; }
    .crosshair { stroke: var(--text-dim); stroke-width: 1; }
    .dot { stroke: var(--surface); stroke-width: 2; }
    .dot--index { fill: var(--accent); }
    .dot--current { fill: var(--ai); }
    .tip {
      position: absolute; top: 0; transform: translateX(-50%); pointer-events: none;
      display: flex; flex-direction: column; padding: 6px 10px; white-space: nowrap;
      border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2);
      font-size: 0.8rem; font-variant-numeric: tabular-nums;
    }
    .tip__gap { color: var(--text-dim); }
  `,
})
export class ProjectionChart {
  readonly current = input.required<readonly YearPoint[]>();
  readonly index = input.required<readonly YearPoint[]>();

  protected readonly w = W;
  protected readonly h = H;
  protected readonly pad = PAD;
  protected readonly money = money;
  protected readonly hovered = signal<number | null>(null);

  private readonly years = computed(() => Math.max(1, this.current().length - 1));
  private readonly maxY = computed(() => {
    const max = Math.max(...this.index().map((p) => p.balance), ...this.current().map((p) => p.balance), 1);
    const step = niceStep(max / 4);
    return Math.ceil(max / step) * step;
  });

  private x(year: number): number {
    return PAD.left + (year / this.years()) * (W - PAD.left - PAD.right);
  }

  private y(value: number): number {
    return H - PAD.bottom - (Math.max(0, value) / this.maxY()) * (H - PAD.top - PAD.bottom);
  }

  private path(points: readonly YearPoint[]): string {
    return points.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.year).toFixed(1)},${this.y(p.balance).toFixed(1)}`).join('');
  }

  protected readonly indexPath = computed(() => this.path(this.index()));
  protected readonly currentPath = computed(() => this.path(this.current()));

  protected readonly yTicks = computed(() => {
    const max = this.maxY();
    const step = niceStep(max / 4);
    const ticks = [];
    for (let v = 0; v <= max + 1e-6; v += step) ticks.push({ value: v, y: this.y(v), label: moneyShort(v) });
    return ticks;
  });

  protected readonly xTicks = computed(() => {
    const n = this.years();
    const every = n <= 10 ? 1 : 5;
    const ticks = [];
    for (let year = 0; year <= n; year += every) ticks.push({ year, x: this.x(year), label: year === 0 ? 'Now' : `${year}y` });
    return ticks;
  });

  protected readonly ends = computed(() => {
    const i = this.index().at(-1);
    const c = this.current().at(-1);
    if (!i || !c) return null;
    let index = this.y(i.balance);
    let current = this.y(c.balance);
    // Keep the two end labels from printing on top of each other.
    if (Math.abs(index - current) < 14) {
      const mid = (index + current) / 2;
      index = mid - 7;
      current = mid + 7;
    }
    return { index, current };
  });

  protected readonly summary = computed(() => {
    const i = this.index().at(-1);
    const c = this.current().at(-1);
    if (!i || !c) return 'Projection';
    return `Projected balance after ${i.year} years: index portfolio ${money(i.balance)}, current setup ${money(c.balance)}.`;
  });

  protected readonly hoverPoint = computed(() => {
    const year = this.hovered();
    if (year === null) return null;
    const i = this.index()[year];
    const c = this.current()[year];
    if (!i || !c) return null;
    return { year, x: this.x(year), yIndex: this.y(i.balance), yCurrent: this.y(c.balance), index: i.balance, current: c.balance };
  });

  protected hover(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const t = (px - PAD.left) / (W - PAD.left - PAD.right);
    this.hovered.set(Math.min(this.years(), Math.max(0, Math.round(t * this.years()))));
  }
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

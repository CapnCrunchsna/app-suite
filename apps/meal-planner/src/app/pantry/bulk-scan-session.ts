/**
 * One bulk-scan session (§7): unloading the groceries, a beep per item.
 *
 * ## Repeats
 *
 * The scanner reports a barcode on every frame it can read it — many times a second
 * while a box sits in view. So a sighting counts only if that barcode has not been seen
 * for `REPEAT_MS`; holding one box up counts once, and scanning a second identical box
 * after moving the first away counts twice. Typed codes (the browser build) are
 * deliberate and always count.
 *
 * ## Unknowns never interrupt
 *
 * Each new barcode is looked up in the background while scanning continues. Whatever the
 * catalog and Open Food Facts could not settle — no match, or a match missing its package
 * size or calories — waits in the list for the review step, instead of stopping the
 * person mid-unload with a form.
 */

import { computed, signal } from '@angular/core';
import { draftFromPrefill, type BarcodeResolution } from './barcode-lookup';

export interface BulkLine {
  readonly barcode: string;
  /** Null while the lookup is still running. */
  readonly resolution: BarcodeResolution | null;
  readonly packages: number;
}

export const REPEAT_MS = 2500;

export class BulkScanSession {
  readonly lines = signal<readonly BulkLine[]>([]);
  readonly totalPackages = computed(() => this.lines().reduce((sum, line) => sum + line.packages, 0));
  readonly lookingUp = computed(() => this.lines().some((line) => line.resolution === null));
  readonly unresolved = computed(() => this.lines().filter((line) => needsDetails(line)).length);

  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly resolve: (barcode: string) => Promise<BarcodeResolution>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a sighting; true when it counted as another item. */
  sight(barcode: string, deliberate = false): boolean {
    const now = this.now();
    const last = this.lastSeen.get(barcode);
    this.lastSeen.set(barcode, now);
    if (!deliberate && last !== undefined && now - last < REPEAT_MS) return false;

    if (this.lines().some((line) => line.barcode === barcode)) {
      this.patch(barcode, (line) => ({ ...line, packages: line.packages + 1 }));
      return true;
    }
    this.lines.update((lines) => [...lines, { barcode, resolution: null, packages: 1 }]);
    this.resolve(barcode)
      .catch((): BarcodeResolution => ({ kind: 'unknown', offline: true, barcode }))
      .then((resolution) => this.settle(barcode, resolution));
    return true;
  }

  settle(barcode: string, resolution: BarcodeResolution): void {
    this.patch(barcode, (line) => ({ ...line, resolution }));
  }

  setPackages(barcode: string, packages: number): void {
    this.patch(barcode, (line) => ({ ...line, packages: Math.max(1, Math.round(packages)) }));
  }

  remove(barcode: string): void {
    this.lines.update((lines) => lines.filter((line) => line.barcode !== barcode));
  }

  private patch(barcode: string, change: (line: BulkLine) => BulkLine): void {
    this.lines.update((lines) => lines.map((line) => (line.barcode === barcode ? change(line) : line)));
  }
}

/** A line the person must finish before it can be committed. */
export function needsDetails(line: BulkLine): boolean {
  const r = line.resolution;
  if (r === null) return false;
  if (r.kind === 'unknown') return true;
  return r.kind === 'found' && draftFromPrefill(r.prefill) === null;
}

/** The name a line shows in the review list. */
export function lineLabel(line: BulkLine): string {
  const r = line.resolution;
  if (r === null) return 'Looking up…';
  if (r.kind === 'known') return r.product.name;
  if (r.kind === 'found') return r.prefill.name || 'Unnamed product';
  return r.offline ? 'Could not look up' : 'Not in Open Food Facts';
}

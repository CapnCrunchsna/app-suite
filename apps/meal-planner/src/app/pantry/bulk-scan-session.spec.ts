import type { Product } from '@metrum/meal-planner-domain';
import type { ProductPrefill } from '@metrum/meal-planner-import';
import type { BarcodeResolution } from './barcode-lookup';
import { BulkScanSession, REPEAT_MS, needsDetails } from './bulk-scan-session';

const eggs = { id: 'p1', name: 'Eggs' } as Product;
const prefill = (over: Partial<ProductPrefill> = {}): ProductPrefill => ({
  barcode: '2',
  name: 'Oats',
  brand: null,
  packageUnit: 'G',
  packageAmount: 1000,
  kcal: 379,
  proteinG: 13,
  source: 'off',
  ...over,
});

function session(results: Record<string, BarcodeResolution>) {
  let t = 0;
  const s = new BulkScanSession(async (code) => results[code] ?? { kind: 'unknown', offline: false, barcode: code }, () => t);
  return { s, advance: (ms: number) => (t += ms) };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BulkScanSession', () => {
  it('counts a box held in view once, and a second identical box after a pause', () => {
    const { s, advance } = session({});
    expect(s.sight('1')).toBe(true);
    advance(100);
    expect(s.sight('1')).toBe(false);
    advance(REPEAT_MS - 1);
    // Still in view: each sighting pushes the window along.
    expect(s.sight('1')).toBe(false);
    advance(REPEAT_MS);
    expect(s.sight('1')).toBe(true);
    expect(s.lines()).toHaveLength(1);
    expect(s.totalPackages()).toBe(2);
  });

  it('always counts a typed code', () => {
    const { s } = session({});
    s.sight('1', true);
    s.sight('1', true);
    expect(s.totalPackages()).toBe(2);
  });

  it('looks each new barcode up in the background and keeps scanning', async () => {
    const { s } = session({ '1': { kind: 'known', product: eggs }, '2': { kind: 'found', prefill: prefill() } });
    s.sight('1');
    s.sight('2');
    expect(s.lookingUp()).toBe(true);
    await settled();
    expect(s.lookingUp()).toBe(false);
    expect(s.lines().map((l) => l.resolution?.kind)).toEqual(['known', 'found']);
    expect(s.unresolved()).toBe(0);
  });

  it('holds back unknown codes and incomplete matches for the review', async () => {
    const { s } = session({ '3': { kind: 'found', prefill: prefill({ barcode: '3', packageAmount: null }) } });
    s.sight('3');
    s.sight('4');
    await settled();
    expect(s.lines().map(needsDetails)).toEqual([true, true]);
    expect(s.unresolved()).toBe(2);
    s.settle('3', { kind: 'known', product: eggs });
    expect(s.unresolved()).toBe(1);
    s.remove('4');
    expect(s.unresolved()).toBe(0);
  });

  it('treats a failed lookup as offline rather than losing the item', async () => {
    const s = new BulkScanSession(async () => {
      throw new Error('boom');
    });
    s.sight('9');
    await settled();
    expect(s.lines()[0].resolution).toEqual({ kind: 'unknown', offline: true, barcode: '9' });
  });

  it('keeps package counts whole and at least one', () => {
    const { s } = session({});
    s.sight('1');
    s.setPackages('1', 0);
    expect(s.lines()[0].packages).toBe(1);
    s.setPackages('1', 3.4);
    expect(s.lines()[0].packages).toBe(3);
  });
});

/**
 * §7 steps 1–4 for one barcode: the local catalog first (a barcode seen once is never
 * fetched again), then Open Food Facts, then nothing — in which case the person adds it
 * by hand, told whether the product is unknown or the lookup simply could not happen.
 */

import { Injectable, inject } from '@angular/core';
import { productProblems, type Product, type ProductDraft } from '@metrum/meal-planner-domain';
import { lookupOpenFoodFacts, type ProductPrefill } from '@metrum/meal-planner-import';
import { Store } from '../data/store';
import { httpGet, offHeaders } from '../platform/http';

export type BarcodeResolution =
  | { readonly kind: 'known'; readonly product: Product }
  | { readonly kind: 'found'; readonly prefill: ProductPrefill }
  | { readonly kind: 'unknown'; readonly offline: boolean; readonly barcode: string };

@Injectable({ providedIn: 'root' })
export class BarcodeLookup {
  private readonly store = inject(Store);

  async resolve(barcode: string): Promise<BarcodeResolution> {
    const { products } = await this.store.ready();
    const local = await products.byBarcode(barcode);
    if (local) return { kind: 'known', product: local };
    const result = await lookupOpenFoodFacts(httpGet, barcode, offHeaders());
    if (result.kind === 'found') return { kind: 'found', prefill: result.prefill };
    return { kind: 'unknown', offline: result.kind === 'unreachable', barcode };
  }
}

/** A prefill complete enough to save without the person touching it, or null. */
export function draftFromPrefill(prefill: ProductPrefill): ProductDraft | null {
  if (prefill.packageUnit === null || prefill.packageAmount === null) return null;
  const draft: ProductDraft = {
    barcode: prefill.barcode,
    name: prefill.name,
    brand: prefill.brand,
    packageUnit: prefill.packageUnit,
    packageAmount: prefill.packageAmount,
    kcal: prefill.kcal,
    proteinG: prefill.proteinG,
    source: prefill.source,
  };
  if (draft.kcal === null || productProblems(draft).length > 0) return null;
  return draft;
}

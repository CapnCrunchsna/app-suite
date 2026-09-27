/**
 * "Choose a product" for an ingredient row: the catalog search, falling through to the
 * product form when the thing is not in the catalog yet. Shared by the Meal Builder and
 * the import review.
 */

import { Injectable, inject } from '@angular/core';
import { ModalController } from '@ionic/angular';
import type { Product } from '@metrum/meal-planner-domain';
import type { ProductPrefill } from '@metrum/meal-planner-import';
import { ProductForm } from '../components/product-form';
import { CatalogSearch } from '../pantry/catalog-search';
import { USDA_NOTICE } from '../pantry/pantry-flows';

@Injectable({ providedIn: 'root' })
export class ProductPicker {
  private readonly modals = inject(ModalController);

  async pick(): Promise<Product | null> {
    const search = await this.modals.create({ component: CatalogSearch });
    await search.present();
    const { data, role } = await search.onDidDismiss<Product | ProductPrefill>();
    if (role === 'new') return this.create({});
    if (role === 'usda' && data) return this.create(data as ProductPrefill, USDA_NOTICE);
    return role === 'pick' && data ? (data as Product) : null;
  }

  async create(prefill: Partial<ProductPrefill>, notice?: string): Promise<Product | null> {
    const form = await this.modals.create({ component: ProductForm, componentProps: { prefill, notice: notice ?? null } });
    await form.present();
    const { data, role } = await form.onDidDismiss<Product>();
    return role === 'saved' && data ? data : null;
  }
}

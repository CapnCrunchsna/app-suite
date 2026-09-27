/**
 * The four ways food gets into the pantry (§10's "+" sheet), each a short chain of
 * modals: scan → look up → confirm the product → how many. Kept out of the page so the
 * page is a list, and so Meals can reuse the product form chain in Phase 2.
 *
 * Every method resolves true when the pantry changed, so the caller knows to reload.
 */

import { Injectable, inject, type Type } from '@angular/core';
import { LoadingController, ModalController } from '@ionic/angular';
import type { PantryEntry } from '@metrum/meal-planner-data';
import { productLabel, type Product } from '@metrum/meal-planner-domain';
import type { ProductPrefill } from '@metrum/meal-planner-import';
import { AddToPantry, type AddToPantryResult } from '../components/add-to-pantry';
import { ProductForm } from '../components/product-form';
import { Store } from '../data/store';
import { Notify } from '../shared/notify';
import { BarcodeLookup } from './barcode-lookup';
import { BulkReview } from './bulk-review';
import { BulkScanSession } from './bulk-scan-session';
import { CatalogSearch } from './catalog-search';
import { PantryEdit } from './pantry-edit';
import { ScanModal } from './scan-modal';

interface Dismissed<T> {
  readonly data?: T;
  readonly role?: string;
}

@Injectable({ providedIn: 'root' })
export class PantryFlows {
  private readonly modals = inject(ModalController);
  private readonly notify = inject(Notify);
  private readonly loading = inject(LoadingController);
  private readonly store = inject(Store);
  private readonly lookup = inject(BarcodeLookup);

  async scanOne(): Promise<boolean> {
    const scan = await this.present<string>(ScanModal, { mode: 'single' }, { cssClass: 'barcode-scanner-modal' });
    if (scan.role !== 'scanned' || !scan.data) return false;
    const code = scan.data;

    const spinner = await this.loading.create({ message: 'Looking up…' });
    await spinner.present();
    const resolution = await this.lookup.resolve(code).finally(() => spinner.dismiss());

    let product: Product | null;
    if (resolution.kind === 'known') {
      product = resolution.product;
    } else if (resolution.kind === 'found') {
      product = await this.productForm({ prefill: resolution.prefill, notice: 'Found on Open Food Facts. Check the details.' });
    } else {
      product = await this.productForm({
        prefill: { barcode: code },
        notice: resolution.offline
          ? 'Couldn’t reach Open Food Facts. Add the details from the label.'
          : 'This barcode isn’t in Open Food Facts. Add the details from the label.',
      });
    }
    return product ? this.addToPantry(product) : false;
  }

  async bulkScan(): Promise<boolean> {
    const session = new BulkScanSession((code) => this.lookup.resolve(code));
    const scan = await this.present(ScanModal, { mode: 'bulk', session }, { cssClass: 'barcode-scanner-modal' });
    if (scan.role !== 'done' || session.lines().length === 0) return false;
    const review = await this.present<number>(BulkReview, { session });
    if (review.role !== 'committed') return false;
    await this.notify.toast(`Added ${review.data} ${review.data === 1 ? 'item' : 'items'} to the pantry`);
    return true;
  }

  async fromCatalog(): Promise<boolean> {
    const picked = await this.present<Product>(CatalogSearch, {});
    if (picked.role === 'new') return this.addManually();
    return picked.role === 'pick' && picked.data ? this.addToPantry(picked.data) : false;
  }

  async addManually(): Promise<boolean> {
    const product = await this.productForm({});
    return product ? this.addToPantry(product) : false;
  }

  async edit(entry: PantryEntry): Promise<boolean> {
    const edited = await this.present<{ quantity: number; expiresOn: string | null }>(PantryEdit, { entry });
    if (edited.role === 'edit-product') {
      const form = await this.present<Product>(ProductForm, { product: entry.product });
      return form.role === 'saved' || form.role === 'deleted';
    }
    if (edited.role !== 'save' || !edited.data) return false;
    const { pantry } = await this.store.ready();
    await pantry.update(entry.item.id, edited.data);
    return true;
  }

  private async productForm(props: { prefill?: Partial<ProductPrefill>; notice?: string }): Promise<Product | null> {
    const form = await this.present<Product>(ProductForm, props);
    return form.role === 'saved' && form.data ? form.data : null;
  }

  private async addToPantry(product: Product): Promise<boolean> {
    const sheet = await this.present<AddToPantryResult>(
      AddToPantry,
      { product },
      { breakpoints: [0, 0.6], initialBreakpoint: 0.6 },
    );
    if (sheet.role !== 'confirm' || !sheet.data) return false;
    const { pantry } = await this.store.ready();
    await pantry.add({ productId: product.id, packages: sheet.data.packages, expiresOn: sheet.data.expiresOn });
    await this.notify.toast(`Added ${sheet.data.packages > 1 ? `${sheet.data.packages} × ` : ''}${productLabel(product)}`);
    return true;
  }

  private async present<T>(
    component: Type<unknown>,
    componentProps: Record<string, unknown>,
    options: { cssClass?: string; breakpoints?: number[]; initialBreakpoint?: number } = {},
  ): Promise<Dismissed<T>> {
    const modal = await this.modals.create({ component, componentProps, ...options });
    await modal.present();
    return modal.onDidDismiss<T>();
  }
}

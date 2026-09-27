/**
 * The product form (§7 step 4): manual entry, the review of an Open Food Facts match,
 * and editing an existing product.
 *
 * §7 asks that it be completable in about twenty seconds, so it has exactly the fields a
 * product needs and no more. The nutrition basis is never asked: it follows from the
 * unit (`basisFor`), and the kcal label says which it is — "per item" or "per 100 g".
 *
 * Dismisses with the saved `Product`, or with role `cancel`.
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import {
  nutritionUnitLabel,
  productProblems,
  type BaseUnit,
  type Product,
  type ProductDraft,
  type ProductSource,
} from '@metrum/meal-planner-domain';
import type { ProductPrefill } from '@metrum/meal-planner-import';
import { Store } from '../data/store';
import { eventValue, parseNumber } from '../shared/events';

const AMOUNT_LABEL: Record<BaseUnit, string> = {
  COUNT: 'Items per package',
  G: 'Grams per package',
  ML: 'Millilitres per package',
};

@Component({
  selector: 'mp-product-form',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonList,
    IonItem,
    IonInput,
    IonLabel,
    IonNote,
    IonSegment,
    IonSegmentButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-form.html',
})
export class ProductForm implements OnInit {
  /** Editing this product; null to create one. */
  readonly product = input<Product | null>(null);
  /** Starting values for a new product (a scan, an OFF match). */
  readonly prefill = input<Partial<ProductPrefill> | null>(null);
  /** A line shown above the fields, e.g. why the form opened. */
  readonly notice = input<string | null>(null);

  private readonly modals = inject(ModalController);
  private readonly store = inject(Store);

  protected readonly name = signal('');
  protected readonly brand = signal('');
  protected readonly barcode = signal('');
  protected readonly unit = signal<BaseUnit>('G');
  protected readonly amount = signal('');
  protected readonly kcal = signal('');
  protected readonly protein = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly editing = computed(() => this.product() !== null);
  protected readonly amountLabel = computed(() => AMOUNT_LABEL[this.unit()]);
  protected readonly nutritionLabel = computed(() => nutritionUnitLabel(this.unit()));

  private source: ProductSource = 'manual';

  protected readonly draft = computed<ProductDraft>(() => ({
    barcode: this.barcode().trim() || null,
    name: this.name(),
    brand: this.brand().trim() || null,
    packageUnit: this.unit(),
    packageAmount: parseNumber(this.amount()) ?? NaN,
    kcal: parseNumber(this.kcal()),
    proteinG: parseNumber(this.protein()),
    source: this.source,
  }));
  protected readonly problems = computed(() => productProblems(this.draft()));

  ngOnInit(): void {
    const from = this.product() ?? this.prefill();
    if (!from) return;
    this.name.set(from.name ?? '');
    this.brand.set(from.brand ?? '');
    this.barcode.set(from.barcode ?? '');
    if (from.packageUnit) this.unit.set(from.packageUnit);
    this.amount.set(from.packageAmount == null ? '' : String(from.packageAmount));
    this.kcal.set(from.kcal == null ? '' : String(from.kcal));
    this.protein.set(from.proteinG == null ? '' : String(from.proteinG));
    if (!this.product() && from.source) this.source = from.source;
  }

  protected setUnit(event: Event): void {
    const value = eventValue(event);
    if (value === 'COUNT' || value === 'G' || value === 'ML') this.unit.set(value);
  }

  protected readonly eventValue = eventValue;

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }

  protected async save(): Promise<void> {
    if (this.problems().length > 0 || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const { products } = await this.store.ready();
      const existing = this.product();
      const saved = existing ? await products.update(existing.id, this.draft()) : await products.create(this.draft());
      await this.modals.dismiss(saved, 'saved');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the product.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const existing = this.product();
    if (!existing) return;
    const { products } = await this.store.ready();
    await products.remove(existing.id);
    await this.modals.dismiss(existing, 'deleted');
  }
}

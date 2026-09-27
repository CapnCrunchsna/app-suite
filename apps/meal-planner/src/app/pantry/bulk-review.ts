/**
 * Bulk scan's review (§7): "edit quantities, resolve queued unknowns, remove mistakes"
 * before anything is written.
 *
 * Commit waits for every lookup to finish and every line to be complete. A line that
 * needs details opens the product form in place; a mistaken scan is removed. The commit
 * itself is one transaction (`PantryRepo.addPurchases`), new products included.
 *
 * Dismisses with the number of items added (role `committed`), or role `cancel`.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import type { Purchase } from '@metrum/meal-planner-data';
import type { Product } from '@metrum/meal-planner-domain';
import { addIcons } from 'ionicons';
import { addOutline, closeCircleOutline, removeOutline } from 'ionicons/icons';
import { ProductForm } from '../components/product-form';
import { Store } from '../data/store';
import { draftFromPrefill } from './barcode-lookup';
import { lineLabel, needsDetails, type BulkLine, type BulkScanSession } from './bulk-scan-session';

@Component({
  selector: 'mp-bulk-review',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonFooter,
    IonList,
    IonItem,
    IonLabel,
    IonNote,
    IonIcon,
    IonSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-button (click)="cancel()">Discard</ion-button></ion-buttons>
        <ion-title>Review {{ session().totalPackages() }} items</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content>
      <ion-list>
        @for (line of session().lines(); track line.barcode) {
          <ion-item [button]="needs(line)" [detail]="needs(line)" (click)="needs(line) && resolve(line)">
            @if (line.resolution === null) {
              <ion-spinner slot="start" name="dots" />
            }
            <ion-label>
              {{ label(line) }}
              <p>
                @if (needs(line)) {
                  <span class="needs">Needs details — tap to finish</span>
                } @else if (line.resolution?.kind === 'found') {
                  New, from Open Food Facts
                } @else {
                  {{ line.barcode }}
                }
              </p>
            </ion-label>
            <ion-button slot="end" fill="clear" aria-label="One fewer" [disabled]="line.packages <= 1" (click)="step($event, line, -1)">
              <ion-icon slot="icon-only" name="remove-outline" />
            </ion-button>
            <span slot="end" class="stepper-value numbers">{{ line.packages }}</span>
            <ion-button slot="end" fill="clear" aria-label="One more" (click)="step($event, line, 1)">
              <ion-icon slot="icon-only" name="add-outline" />
            </ion-button>
            <ion-button slot="end" fill="clear" color="medium" aria-label="Remove this scan" (click)="remove($event, line)">
              <ion-icon slot="icon-only" name="close-circle-outline" />
            </ion-button>
          </ion-item>
        } @empty {
          <div class="empty-state"><p>Nothing scanned.</p></div>
        }
      </ion-list>
      @if (error()) {
        <p class="ion-padding error" role="alert">{{ error() }}</p>
      }
    </ion-content>
    <ion-footer>
      <ion-toolbar>
        @if (session().unresolved() > 0) {
          <ion-note class="ion-padding-horizontal">
            {{ session().unresolved() }} still {{ session().unresolved() === 1 ? 'needs' : 'need' }} details, or can be removed.
          </ion-note>
        }
        <ion-button expand="block" class="ion-margin" [disabled]="!ready() || saving()" (click)="commit()">
          Add {{ session().totalPackages() }} to pantry
        </ion-button>
      </ion-toolbar>
    </ion-footer>
  `,
})
export class BulkReview {
  readonly session = input.required<BulkScanSession>();

  private readonly modals = inject(ModalController);
  private readonly store = inject(Store);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ready = computed(
    () =>
      this.session().lines().length > 0 && !this.session().lookingUp() && this.session().unresolved() === 0,
  );
  protected readonly needs = needsDetails;
  protected readonly label = lineLabel;

  constructor() {
    addIcons({ addOutline, removeOutline, closeCircleOutline });
  }

  protected step(event: Event, line: BulkLine, delta: number): void {
    event.stopPropagation();
    this.session().setPackages(line.barcode, line.packages + delta);
  }

  protected remove(event: Event, line: BulkLine): void {
    event.stopPropagation();
    this.session().remove(line.barcode);
  }

  protected async resolve(line: BulkLine): Promise<void> {
    const r = line.resolution;
    const prefill = r?.kind === 'found' ? r.prefill : { barcode: line.barcode };
    const form = await this.modals.create({
      component: ProductForm,
      componentProps: {
        prefill,
        notice:
          r?.kind === 'found'
            ? 'Open Food Facts is missing some details for this one.'
            : 'Not found — add what the label says.',
      },
    });
    await form.present();
    const { data, role } = await form.onDidDismiss<Product>();
    if (role === 'saved' && data) this.session().settle(line.barcode, { kind: 'known', product: data });
  }

  protected async commit(): Promise<void> {
    if (!this.ready() || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const purchases: Purchase[] = this.session()
        .lines()
        .map((line) => {
          const r = line.resolution;
          const product = r?.kind === 'known' ? r.product.id : r?.kind === 'found' ? draftFromPrefill(r.prefill) : null;
          if (!product) throw new Error(`${line.barcode} is not ready`);
          return { product, packages: line.packages, expiresOn: null };
        });
      const { pantry, products } = await this.store.ready();
      await pantry.addPurchases(purchases, products);
      await this.modals.dismiss(this.session().totalPackages(), 'committed');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not add the items.');
    } finally {
      this.saving.set(false);
    }
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }
}

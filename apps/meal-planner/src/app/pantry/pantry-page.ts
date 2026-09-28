/**
 * The Pantry tab (meal-planner-spec.md §10).
 *
 * A searchable list of what is on the shelf. Swipe left removes a row in one motion —
 * no confirmation, because the toast's Undo is the confirmation, and a question asked on
 * every removal is one people stop reading. Swipe right (or tap) edits. The "+" button
 * holds the four ways in.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { ViewWillEnter } from '@ionic/angular';
import { ActionSheetController } from '@ionic/angular/action-sheet-controller';
import { IonButton } from '@ionic/angular/ion-button';
import { IonContent } from '@ionic/angular/ion-content';
import { IonFab } from '@ionic/angular/ion-fab';
import { IonFabButton } from '@ionic/angular/ion-fab-button';
import { IonHeader } from '@ionic/angular/ion-header';
import { IonIcon } from '@ionic/angular/ion-icon';
import { IonItem } from '@ionic/angular/ion-item';
import { IonItemOption } from '@ionic/angular/ion-item-option';
import { IonItemOptions } from '@ionic/angular/ion-item-options';
import { IonItemSliding } from '@ionic/angular/ion-item-sliding';
import { IonLabel } from '@ionic/angular/ion-label';
import { IonList } from '@ionic/angular/ion-list';
import { IonNote } from '@ionic/angular/ion-note';
import { IonSearchbar } from '@ionic/angular/ion-searchbar';
import { IonSpinner } from '@ionic/angular/ion-spinner';
import { IonTitle } from '@ionic/angular/ion-title';
import { IonToolbar } from '@ionic/angular/ion-toolbar';
import type { PantryEntry } from '@metrum/meal-planner-data';
import { distinctBrand, formatRemaining } from '@metrum/meal-planner-domain';
import { addIcons } from 'ionicons';
import { add, barcodeOutline, createOutline, trashOutline } from 'ionicons/icons';
import { Store } from '../data/store';
import { eventValue } from '../shared/events';
import { Notify } from '../shared/notify';
import { PantryFlows } from './pantry-flows';

@Component({
  selector: 'mp-pantry-page',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonSearchbar,
    IonContent,
    IonList,
    IonItemSliding,
    IonItem,
    IonItemOptions,
    IonItemOption,
    IonLabel,
    IonNote,
    IonIcon,
    IonButton,
    IonFab,
    IonFabButton,
    IonSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pantry-page.html',
})
export class PantryPage implements ViewWillEnter {
  private readonly store = inject(Store);
  private readonly flows = inject(PantryFlows);
  private readonly sheets = inject(ActionSheetController);
  private readonly notify = inject(Notify);

  protected readonly entries = signal<PantryEntry[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly value = eventValue;

  protected readonly visible = computed(() => {
    const words = this.filter().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.entries();
    return this.entries().filter(({ product }) => {
      const text = `${product.name} ${product.brand ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });

  constructor() {
    addIcons({ add, barcodeOutline, createOutline, trashOutline });
  }

  ionViewWillEnter(): void {
    void this.reload();
  }

  protected remaining(entry: PantryEntry): string {
    return formatRemaining(entry.item.quantity, entry.product.packageUnit, entry.product.packageAmount);
  }

  /** "Kirkland · expires 2026-10-01", either half, or nothing. */
  protected detail(entry: PantryEntry): string | null {
    const parts = [distinctBrand(entry.product), entry.item.expiresOn ? `expires ${entry.item.expiresOn}` : null];
    return parts.filter(Boolean).join(' · ') || null;
  }

  protected async remove(entry: PantryEntry, sliding: IonItemSliding): Promise<void> {
    await sliding.close();
    const { pantry } = await this.store.ready();
    const undo = await pantry.remove(entry.item.id);
    this.entries.update((list) => list.filter((e) => e.item.id !== entry.item.id));
    await this.notify.toast(`Removed ${entry.product.name}`, {
      undo: async () => {
        await pantry.restore(undo);
        await this.reload();
      },
    });
  }

  protected async edit(entry: PantryEntry, sliding?: IonItemSliding): Promise<void> {
    await sliding?.close();
    if (await this.flows.edit(entry)) await this.reload();
  }

  protected async scan(): Promise<void> {
    if (await this.flows.scanOne()) await this.reload();
  }

  protected async openAdd(): Promise<void> {
    const sheet = await this.sheets.create({
      header: 'Add to pantry',
      buttons: [
        { text: 'Scan barcode', data: 'scan' },
        { text: 'Bulk scan', data: 'bulk' },
        { text: 'Search catalog', data: 'catalog' },
        { text: 'Add manually', data: 'manual' },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<string>();
    const changed =
      data === 'scan'
        ? await this.flows.scanOne()
        : data === 'bulk'
          ? await this.flows.bulkScan()
          : data === 'catalog'
            ? await this.flows.fromCatalog()
            : data === 'manual'
              ? await this.flows.addManually()
              : false;
    if (changed) await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      const { pantry } = await this.store.ready();
      this.entries.set(await pantry.list());
      this.failure.set(null);
    } catch (error) {
      this.failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loaded.set(true);
    }
  }
}

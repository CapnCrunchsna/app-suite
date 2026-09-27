/**
 * The scan overlay, for one barcode or a bulk session (§7).
 *
 * On a phone the camera runs behind a transparent page (see `Scanner`) and this modal is
 * the only thing drawn over it: a viewfinder, a count, and the way out. In the browser
 * build there is no camera, so the same overlay takes typed barcodes — which is what
 * lets the whole scan-to-pantry path, Open Food Facts included, be exercised on a laptop.
 *
 * Single mode dismisses with the code (role `scanned`). Bulk mode feeds the session and
 * dismisses with role `done` or `cancel`.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonInput,
  IonItem,
  IonTitle,
  IonToolbar,
  ModalController,
  type ViewDidEnter,
  type ViewWillLeave,
} from '@ionic/angular';
import { Scanner } from '../platform/scanner';
import { eventValue } from '../shared/events';
import { lineLabel, type BulkScanSession } from './bulk-scan-session';

const PRODUCT_CODE = /^\d{6,14}$/;

@Component({
  selector: 'mp-scan-modal',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonButton, IonContent, IonFooter, IonItem, IonInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scan-modal.scss',
  templateUrl: './scan-modal.html',
})
export class ScanModal implements ViewDidEnter, ViewWillLeave {
  readonly mode = input<'single' | 'bulk'>('single');
  readonly session = input<BulkScanSession | null>(null);

  private readonly scanner = inject(Scanner);
  private readonly modals = inject(ModalController);

  protected readonly camera = this.scanner.available;
  protected readonly typed = signal('');
  protected readonly problem = signal<string | null>(null);
  protected readonly flash = signal(false);
  protected readonly value = eventValue;

  protected readonly count = computed(() => this.session()?.totalPackages() ?? 0);
  protected readonly lastLabel = computed(() => {
    const lines = this.session()?.lines() ?? [];
    return lines.length > 0 ? lineLabel(lines[lines.length - 1]) : null;
  });
  protected readonly typedValid = computed(() => PRODUCT_CODE.test(this.typed().trim()));

  private finished = false;

  async ionViewDidEnter(): Promise<void> {
    if (!this.camera) return;
    if (!(await this.scanner.ensurePermission())) {
      void this.modals.dismiss(null, 'cancel');
      return;
    }
    try {
      await this.scanner.start((code) => this.onCode(code, false));
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : 'The camera could not start.');
    }
  }

  async ionViewWillLeave(): Promise<void> {
    await this.scanner.stop();
  }

  protected submitTyped(): void {
    const code = this.typed().trim();
    if (!PRODUCT_CODE.test(code)) return;
    this.typed.set('');
    this.onCode(code, true);
  }

  protected done(): void {
    void this.modals.dismiss(null, 'done');
  }

  protected cancel(): void {
    void this.modals.dismiss(null, 'cancel');
  }

  private onCode(code: string, deliberate: boolean): void {
    if (this.mode() === 'single') {
      if (this.finished) return;
      this.finished = true;
      void this.modals.dismiss(code, 'scanned');
      return;
    }
    if (this.session()?.sight(code, deliberate)) {
      navigator.vibrate?.(40);
      this.flash.set(true);
      setTimeout(() => this.flash.set(false), 250);
    }
  }
}

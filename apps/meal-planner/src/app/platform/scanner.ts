/**
 * The camera barcode scanner (meal-planner-spec.md §7), over
 * `@capacitor-mlkit/barcode-scanning`'s `startScan`.
 *
 * `startScan` draws the camera *behind* the WebView, so while it runs the page is made
 * transparent (`body.barcode-scanner-active` in styles.scss) and only the scan overlay —
 * a modal with the `barcode-scanner-modal` class — stays visible. The plugin's ready-made
 * `scan()` UI was not used: it is marked experimental, and Android may kill the app while
 * it is open and lose the result. `startScan` is also the flow §7 describes, with the
 * camera permission asked for on first use.
 *
 * Only product codes are decoded (EAN/UPC), which is faster and cannot mistake a QR code
 * on a flyer for a grocery item.
 */

import { Injectable, inject } from '@angular/core';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import type { PluginListenerHandle } from '@capacitor/core';
import { AlertController } from '@ionic/angular/alert-controller';
import { isNative } from './http';

const ACTIVE_CLASS = 'barcode-scanner-active';

@Injectable({ providedIn: 'root' })
export class Scanner {
  private readonly alerts = inject(AlertController);
  private listener: PluginListenerHandle | null = null;

  /** Camera scanning exists only in the native build; the browser build types codes instead. */
  get available(): boolean {
    return isNative();
  }

  /** Asks once, with a one-line reason (§7). False if the person said no. */
  async ensurePermission(): Promise<boolean> {
    const { camera } = await BarcodeScanner.checkPermissions();
    if (camera === 'granted' || camera === 'limited') return true;
    if (camera === 'denied') {
      await this.explainDenied();
      return false;
    }
    const alert = await this.alerts.create({
      header: 'Camera access',
      message: 'The camera is used only to read barcodes on food you add to your pantry.',
      buttons: [{ text: 'Not now', role: 'cancel' }, { text: 'Continue' }],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role === 'cancel') return false;
    const result = await BarcodeScanner.requestPermissions();
    return result.camera === 'granted' || result.camera === 'limited';
  }

  async start(onCode: (code: string) => void): Promise<void> {
    await this.stop();
    document.body.classList.add(ACTIVE_CLASS);
    this.listener = await BarcodeScanner.addListener('barcodesScanned', (event) => {
      for (const barcode of event.barcodes) {
        const code = (barcode.rawValue ?? barcode.displayValue ?? '').trim();
        if (code) onCode(code);
      }
    });
    await BarcodeScanner.startScan({
      formats: [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE],
    });
  }

  async stop(): Promise<void> {
    document.body.classList.remove(ACTIVE_CLASS);
    const listener = this.listener;
    this.listener = null;
    await listener?.remove();
    if (this.available) await BarcodeScanner.stopScan().catch(() => undefined);
  }

  private async explainDenied(): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Camera is off for this app',
      message: 'Barcode scanning needs the camera. You can turn it on in the app’s settings, or add food by searching or by hand.',
      buttons: [
        { text: 'Close', role: 'cancel' },
        { text: 'Open settings', handler: () => void BarcodeScanner.openSettings() },
      ],
    });
    await alert.present();
    await alert.onDidDismiss();
  }
}

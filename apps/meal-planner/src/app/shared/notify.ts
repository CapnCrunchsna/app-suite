/**
 * The app's one kind of toast: a short confirmation, or — with `undo` — the five seconds
 * in which a one-tap action can be taken back. Undo is how removals avoid asking "are
 * you sure?" (§10), so it is offered the same way everywhere.
 */

import { Injectable, inject } from '@angular/core';
import { ToastController } from '@ionic/angular';

@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly toasts = inject(ToastController);

  async toast(message: string, options: { undo?: () => Promise<void>; seconds?: number } = {}): Promise<void> {
    const { undo } = options;
    const toast = await this.toasts.create({
      message,
      duration: (options.seconds ?? (undo ? 5 : 2)) * 1000,
      position: 'bottom',
      buttons: undo ? [{ text: 'Undo', role: 'undo' }] : [],
    });
    await toast.present();
    if (!undo) return;
    const { role } = await toast.onDidDismiss();
    if (role === 'undo') await undo();
  }
}

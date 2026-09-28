/**
 * Ask before a modal's unsaved work is thrown away by anything other than its own buttons.
 *
 * Android's Back button, a swipe or a backdrop tap dismisses an Ionic modal. For a form
 * that is right; for the import review — a fetched recipe with lines already linked —
 * one stray Back loses minutes of work. Save and Cancel pass straight through: those are
 * decisions, not accidents.
 */

import { inject } from '@angular/core';
import { AlertController } from '@ionic/angular/alert-controller';
import { IonModalToken } from '@ionic/angular/ion-modal-token';

export function guardDiscard(isDirty: () => boolean, what: string): void {
  const modal = inject(IonModalToken, { optional: true });
  const alerts = inject(AlertController);
  if (!modal) return;
  modal.canDismiss = async (_data?: unknown, role?: string) => {
    if (role === 'saved' || role === 'cancel' || !isDirty()) return true;
    const alert = await alerts.create({
      header: `Discard ${what}?`,
      message: 'What you have entered here will be lost.',
      buttons: [
        { text: 'Keep editing', role: 'cancel' },
        { text: 'Discard', role: 'destructive' },
      ],
    });
    await alert.present();
    const { role: choice } = await alert.onDidDismiss();
    return choice === 'destructive';
  };
}

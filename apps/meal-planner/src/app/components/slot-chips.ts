/**
 * Which day slots a meal may fill (§10's "eligible-slot chips"), shared by the Meal
 * Builder and the import review. At least one stays selected: a meal eligible for no
 * slot is one the planner can never offer, which looks exactly like a bug.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonChip } from '@ionic/angular/ion-chip';
import { IonLabel } from '@ionic/angular/ion-label';
import { SLOT_TYPES, type SlotType } from '@metrum/meal-planner-domain';

export const SLOT_LABEL: Readonly<Record<SlotType, string>> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

@Component({
  selector: 'mp-slot-chips',
  imports: [IonChip, IonLabel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (slot of all; track slot) {
      <ion-chip
        [outline]="!selected().includes(slot)"
        [color]="selected().includes(slot) ? 'primary' : 'medium'"
        [attr.aria-pressed]="selected().includes(slot)"
        role="button"
        (click)="toggle(slot)"
      >
        <ion-label>{{ label[slot] }}</ion-label>
      </ion-chip>
    }
  `,
})
export class SlotChips {
  readonly selected = input.required<readonly SlotType[]>();
  readonly changed = output<SlotType[]>();

  protected readonly all = SLOT_TYPES;
  protected readonly label = SLOT_LABEL;

  protected toggle(slot: SlotType): void {
    const current = this.selected();
    const next = current.includes(slot) ? current.filter((s) => s !== slot) : [...current, slot];
    if (next.length === 0) return;
    this.changed.emit(SLOT_TYPES.filter((s) => next.includes(s)));
  }
}

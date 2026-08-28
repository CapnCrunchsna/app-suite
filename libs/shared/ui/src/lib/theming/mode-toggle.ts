import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ThemeService } from './theme.service.js';
import type { ThemeMode } from './theme.js';

/**
 * Light / Dark / System, as three buttons rather than a switch.
 *
 * A two-state switch cannot express "follow the OS", and defaulting to the OS is
 * the only setting that is right for someone who has never opened this control.
 * Three buttons show all three states at once and say which one is live — a
 * cycling single button makes you click twice to find out what it does.
 *
 * The mode is shown, not just the resolution: with `System` selected the label
 * says `System`, not `Dark`. Those are different facts, and a user who set
 * "system" wants to see that they did.
 */
@Component({
  selector: 'ui-mode-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modes" role="group" aria-label="Colour mode">
      @for (option of options; track option.mode) {
        <button
          type="button"
          class="modes__button"
          [class.modes__button--active]="mode() === option.mode"
          [attr.aria-pressed]="mode() === option.mode"
          [title]="option.title"
          (click)="choose(option.mode)"
        >
          {{ option.label }}
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .modes {
      display: inline-flex;
      padding: 2px;
      border: 1px solid var(--border, #1f4a47);
      border-radius: 999px;
      background: var(--surface-2, #143034);
    }

    .modes__button {
      padding: 2px 10px;
      border: none;
      border-radius: 999px;
      background: none;
      color: var(--text-dim, #7ea8a1);
      font: inherit;
      font-size: 0.72rem;
      line-height: 1.5;
      cursor: pointer;
    }

    .modes__button:hover {
      color: var(--text, #dcefeb);
    }

    /* Filled rather than outlined: an outline inside a pill that already has one
       reads as a second control instead of as the selected third of this one. */
    .modes__button--active {
      background: var(--accent, #2dd4bf);
      color: var(--on-accent, #06201c);
      font-weight: 600;
    }
  `,
})
export class ModeToggle {
  private readonly theming = inject(ThemeService);

  protected readonly mode = this.theming.mode;

  protected readonly options: readonly { mode: ThemeMode; label: string; title: string }[] = [
    { mode: 'light', label: 'Light', title: 'Always light' },
    { mode: 'dark', label: 'Dark', title: 'Always dark' },
    { mode: 'system', label: 'System', title: 'Follow this device’s appearance setting' },
  ];

  protected choose(mode: ThemeMode): void {
    this.theming.setMode(mode);
  }
}

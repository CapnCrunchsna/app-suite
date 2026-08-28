import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ModeToggle } from './mode-toggle.js';
import { ThemeService } from './theme.service.js';

/**
 * Both axes in one control: which palette, and light or dark within it.
 *
 * A `<select>` for the theme and buttons for the mode, because the two lists grow
 * differently. Modes are three, forever, and are worth showing at once. Themes
 * are one per app in the suite and counting — a row of buttons that grows every
 * time someone ships an app is a header that eventually wraps.
 *
 * **The theme picker hides itself when there is only one theme.** A select with a
 * single option is a control that cannot do anything, and it would be the normal
 * case for the first app to adopt this. The mode toggle always renders: it always
 * has three things to say.
 */
@Component({
  selector: 'ui-theme-switcher',
  imports: [ModeToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="switcher">
      @if (multiple()) {
        <label class="switcher__theme">
          <span class="switcher__label">Theme</span>
          <!-- [selected] on each option, not [value] on the select. The select's
               value is applied before the loop has created any options, so the
               browser has nothing to match and resets to index 0 — invisible
               until a stored choice is restored, at which point the control
               names the wrong theme while the page is painted with the right
               one. -->
          <select class="switcher__select" (change)="choose($event)" [title]="note()">
            @for (theme of themes(); track theme.id) {
              <option [value]="theme.id" [selected]="theme.id === themeId()">
                {{ theme.label }}
              </option>
            }
          </select>
        </label>
      }

      <ui-mode-toggle />
    </div>
  `,
  styles: `
    :host {
      display: inline-block;
    }

    .switcher {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }

    .switcher__theme {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .switcher__label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim, #7ea8a1);
    }

    .switcher__select {
      padding: 2px 6px;
      border: 1px solid var(--border, #1f4a47);
      border-radius: 6px;
      background: var(--surface-2, #143034);
      color: var(--text, #dcefeb);
      font: inherit;
      font-size: 0.76rem;
      cursor: pointer;
    }
  `,
})
export class ThemeSwitcher {
  private readonly theming = inject(ThemeService);

  protected readonly themes = this.theming.themes;
  protected readonly themeId = this.theming.themeId;
  protected readonly multiple = computed(() => this.themes().length > 1);

  /** The active theme's own line, on the control that changes it. */
  protected readonly note = computed(() => this.theming.theme().note ?? '');

  protected choose(event: Event): void {
    this.theming.setTheme((event.target as HTMLSelectElement).value);
  }
}

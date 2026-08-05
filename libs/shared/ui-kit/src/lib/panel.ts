import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A titled surface — the one primitive every §6 page is laid out on.
 *
 * Presentational only, per §2.2's hard rule for `type:ui`: no injected
 * services, no HTTP, no app state, no knowledge that Ledgerline exists.
 * Colours come from the CSS custom properties the host app defines, so this
 * lib carries no palette of its own.
 *
 * Template and styles are inline on purpose. This lib's `build` target is
 * plain `tsc` (the `@nx/js/typescript` plugin, keyed on `tsconfig.lib.json`),
 * which does not copy sibling `.html`/`.scss` files into `dist/`.
 */
@Component({
  selector: 'ui-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (heading()) {
      <h2 class="panel__heading">{{ heading() }}</h2>
    }
    <div class="panel__body"><ng-content /></div>
  `,
  styles: `
    :host {
      display: block;
      background: var(--surface, #0f2124);
      border: 1px solid var(--border, #1f4a47);
      border-radius: var(--radius, 10px);
      box-shadow: var(--shadow, 0 1px 3px rgb(0 0 0 / 50%));
    }

    .panel__heading {
      margin: 0;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border, #1f4a47);
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    .panel__body {
      padding: 20px;
    }
  `,
})
export class Panel {
  /** Rendered as the panel's header row. Omit for an untitled surface. */
  readonly heading = input('');
}

/**
 * §6.8's Data section: "database path, backup, export to JSON/CSV, wipe".
 *
 * Presentational; the page owns every request. The one thing this component decides for
 * itself is the confirmation state, because a half-typed phrase is not something the
 * page needs to know about and re-rendering it through the parent would clear the box
 * on every keystroke.
 *
 * ## Backup sits above wipe, and that is the layout doing a job
 *
 * §2.3 lists three operations and one of them cannot be undone. The API takes its own
 * backup immediately before deleting anything (§9j), so the honest thing to show is
 * that the safety net exists rather than a row of equally-weighted buttons — the wipe
 * is last, boxed, and states what it keeps as well as what it destroys.
 *
 * The phrase has to be typed in full. A single-word confirmation is one autocomplete
 * away, and a dialog with an OK button is the thing people click through.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Settings } from '@metrum/api-client';

export type DataAction =
  | { readonly kind: 'backup' }
  | { readonly kind: 'export'; readonly format: 'json' | 'csv' }
  | { readonly kind: 'wipe' };

/** Mirrors the API's own constant. Duplicated deliberately rather than put on the wire:
 *  a confirmation phrase the server *sends you* is one the client can echo back without
 *  a human ever reading it. */
export const WIPE_PHRASE = 'DELETE EVERYTHING';

@Component({
  selector: 'll-data-settings',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-settings.html',
  styleUrl: './data-settings.scss',
})
export class DataSettings {
  readonly settings = input.required<Settings>();
  readonly busy = input(false);
  /** Where the last backup went, so "done" has a path attached. */
  readonly lastBackupPath = input<string | null>(null);

  readonly acted = output<DataAction>();

  protected readonly phrase = signal('');
  protected readonly armed = computed(() => this.phrase() === WIPE_PHRASE);
  protected readonly wipePhrase = WIPE_PHRASE;

  protected readonly inMemory = computed(() => this.settings().databaseFile === ':memory:');

  protected backup(): void {
    this.acted.emit({ kind: 'backup' });
  }

  protected export(format: 'json' | 'csv'): void {
    this.acted.emit({ kind: 'export', format });
  }

  protected wipe(): void {
    if (!this.armed()) return;
    this.acted.emit({ kind: 'wipe' });
    this.phrase.set('');
  }
}

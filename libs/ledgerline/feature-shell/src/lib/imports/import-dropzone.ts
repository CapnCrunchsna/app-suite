/**
 * §6.1's first half: "Full-page dropzone accepting multiple files at once. Each
 * file gets a row with progress and a detected badge."
 *
 * Presentational. It turns a drop into a `File[]` and renders the rows the page
 * gives it back; it makes no request and holds no import state.
 *
 * ## Two things here are not decoration
 *
 * **A re-upload is "already imported", not a new file.** §3.3's first idempotency
 * layer short-circuits a byte-identical re-upload and the API says so with
 * `created: false`. Rendering that row the same as a fresh one would make
 * re-dragging a folder look like it doubled the month — the exact impression the
 * merge rule exists to prevent, arriving through the UI instead of the data.
 *
 * **A refused file shows the API's own reason.** A dropped PDF comes back
 * `failed` with "PDF ingest is not built yet (roadmap v0.4). Export the statement
 * as CSV." That sentence is the whole feature; a badge of our own wording would be
 * a second description of a rule this UI does not own.
 */

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { FormatProfile, StatementImport } from '@metrum/api-client';

/** One dropped file, from the moment it leaves the mouse to the moment the API
 *  has said what it is. `key` is local and stable; `importId` is the server's. */
export interface StagedFileRow {
  readonly key: string;
  readonly filename: string;
  readonly sizeBytes: number;
  /** `uploading` until the POST resolves; `failed` only for a request that never
   *  produced an import at all. A file the *API* refused is `staged` with an
   *  import whose own status is `failed`. */
  readonly state: 'uploading' | 'staged' | 'failed';
  readonly importId: string | null;
  /** §3.3 layer one: false when this file was already on disk, byte for byte. */
  readonly created: boolean;
  readonly status: StatementImport['status'] | null;
  readonly formatProfileId: string | null;
  readonly errorDetail: string | null;
  /** Set only when the request itself failed — no import exists to explain it. */
  readonly requestError: string | null;
}

@Component({
  selector: 'll-import-dropzone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="zone"
      [class.zone--over]="over()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      <p class="zone__headline">Drop statement files here</p>
      <p class="zone__hint">
        CSV, several at once. Nothing enters the database until you review and commit — §2.5.
      </p>
      <label class="zone__browse">
        <input
          type="file"
          class="zone__input"
          multiple
          accept=".csv,text/csv,text/plain"
          (change)="onPicked($event)"
        />
        <span class="zone__browse-text">or choose files</span>
      </label>
    </div>

    @if (files().length > 0) {
      <ul class="staged">
        @for (file of files(); track file.key) {
          <li
            class="staged__row"
            [class.staged__row--selected]="file.importId !== null && file.importId === selectedId()"
            [class.staged__row--failed]="file.state === 'failed' || file.status === 'failed'"
          >
            <button
              type="button"
              class="staged__name"
              [disabled]="file.importId === null"
              (click)="file.importId && selected.emit(file.importId)"
              [title]="file.importId ? 'Review this import' : 'Not staged yet'"
            >
              {{ file.filename }}
            </button>

            <span class="staged__size">{{ kb(file.sizeBytes) }}</span>

            <span class="staged__progress" [attr.data-state]="file.state">
              <span class="staged__bar" [class.staged__bar--done]="file.state !== 'uploading'">
              </span>
            </span>

            <span class="staged__badges">
              @if (file.state === 'uploading') {
                <span class="badge badge--busy">uploading…</span>
              } @else if (file.state === 'failed') {
                <span class="badge badge--bad">{{ file.requestError }}</span>
              } @else {
                @if (!file.created) {
                  <span
                    class="badge badge--known"
                    title="§3.3: byte-identical, so nothing was re-staged."
                  >
                    already imported
                  </span>
                }
                @switch (file.status) {
                  @case ('needs_mapping') {
                    <span class="badge badge--warn">⚠ needs mapping</span>
                  }
                  @case ('failed') {
                    <span class="badge badge--bad">{{ file.errorDetail }}</span>
                  }
                  @case ('committed') {
                    <span class="badge badge--ok"
                      >CSV · {{ profileName(file.formatProfileId) }}</span
                    >
                    <span class="badge badge--known">committed</span>
                  }
                  @default {
                    <span class="badge badge--ok"
                      >CSV · {{ profileName(file.formatProfileId) }}</span
                    >
                  }
                }
              }
            </span>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './import-dropzone.scss',
})
export class ImportDropzone {
  readonly files = input<readonly StagedFileRow[]>([]);
  readonly profiles = input<readonly FormatProfile[]>([]);
  readonly selectedId = input<string | null>(null);

  readonly dropped = output<File[]>();
  readonly selected = output<string>();

  protected readonly over = signal(false);

  protected onDragOver(event: DragEvent): void {
    // Without this the browser navigates away to the dropped file, which loses
    // the app and every staged row with it.
    event.preventDefault();
    this.over.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
  }

  /**
   * `stopPropagation` matters: §6.1 asks for a *full-page* dropzone, so the page
   * host listens for a drop as well. Without this, a drop on the visible target
   * would be handled here and again there, and every file would upload twice.
   */
  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.over.set(false);
    this.dropped.emit([...(event.dataTransfer?.files ?? [])]);
  }

  protected onPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.dropped.emit([...(input.files ?? [])]);
    // So picking the same file twice in a row still fires a `change`.
    input.value = '';
  }

  protected kb(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
  }

  /** The badge §6.1 spells out as `CSV · Chase profile`. Falls back to the id
   *  rather than to "unknown": an id is at least something to search for. */
  protected profileName(profileId: string | null): string {
    if (!profileId) return 'no profile';
    const profile = this.profiles().find((candidate) => candidate.id === profileId);
    return profile ? profile.institution : profileId;
  }
}

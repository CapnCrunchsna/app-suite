/**
 * §6.8, the Settings page.
 *
 * §6.8 names six sections. Two are built here and four are not, and which is which is
 * decided by what exists underneath rather than by what was quickest:
 *
 * - **Analyzers** — built. §7.4's machinery has existed since the analyzers landed
 *   ("Every threshold in §5 is a default in a config object; Settings overrides it"),
 *   and nothing could write the override, so the thresholds were data in principle and
 *   constants in practice. This is the section that makes §7.6's calibration a normal
 *   afternoon rather than a series of commits.
 * - **Data** — built: database path, backup, export, and §2.3's wipe.
 * - **LLM provider** and **Redaction** — not buildable. §2.4's provider seam does not
 *   exist in any form; there is no `none`/`claude-cli`/`ollama` to choose between and
 *   no health probe to call. A picker over three options that all do nothing would be
 *   a lie with a dropdown on it.
 * - **Merchant aliases** and **Categories** — not built. Both need write endpoints
 *   §2.3 lists and §1 counts as missing: the review queue, and category CRUD with
 *   overlap groups.
 *
 * The four are rendered as stated absences rather than omitted, for the same reason the
 * shell's rail renders an unbuilt section as a span: a page that quietly lacks four of
 * its six parts reads as a page that is finished.
 *
 * Same split as the other five pages: the container owns all state and every request,
 * the children are presentational, and `LedgerlineApiService` is the one seam.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  resource,
  signal,
} from '@angular/core';
import { Panel } from '@metrum/ui';
import { LedgerlineApiError } from '@metrum/api-client';
import type { Settings } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AnalyzerSettings } from './analyzer-settings.js';
import type { SettingChange } from './analyzer-settings.js';
import { DataSettings } from './data-settings.js';
import type { DataAction } from './data-settings.js';

/** §6.8's sections with nothing behind them yet, and the reason in each case. Stated
 *  rather than omitted — see the header. */
const UNBUILT = [
  {
    title: 'LLM provider',
    detail:
      '§2.4’s provider seam is not built. There is no none / claude-cli / ollama to choose ' +
      'between and no health probe to call, so there is nothing here to configure — the app ' +
      'runs entirely locally today, which is what the `none` provider would mean anyway.',
  },
  {
    title: 'Redaction',
    detail:
      'Belongs to the LLM provider above: redaction exists to strip account numbers and ' +
      'counterparty names from text on its way off this machine, and nothing sends any.',
  },
  {
    title: 'Merchant aliases',
    detail:
      '§6.3 already carries the correction path that matters — edit a merchant, apply it to ' +
      'every matching descriptor, and §4.3’s re-normalize job sweeps the history. The review ' +
      'queue for LLM proposals needs the endpoints §2.3 lists and §1 counts as missing.',
  },
  {
    title: 'Categories',
    detail:
      'The taxonomy is seeded and readable (§5’s categories, `GET /api/categories`), but ' +
      'editing it and assigning §5.4’s overlap groups needs write endpoints that do not exist.',
  },
] as const;

@Component({
  selector: 'll-settings-page',
  imports: [Panel, AnalyzerSettings, DataSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage {
  private readonly api = inject(LedgerlineApiService);

  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly lastBackupPath = signal<string | null>(null);
  protected readonly unbuilt = UNBUILT;

  private readonly revision = signal(0);

  /** No `defaultValue`: unlike the other pages there is no empty-but-valid Settings to
   *  render, and an invented one would show every threshold as zero for a frame. */
  private readonly settingsResource = resource({
    params: () => this.revision(),
    loader: () => this.api.getSettings(),
  });

  protected readonly settings = computed<Settings | null>(
    () => this.settingsResource.value() ?? null,
  );
  protected readonly loading = computed(() => this.settingsResource.isLoading());
  protected readonly failure = computed(() => this.settingsResource.error());

  // ---------------------------------------------------------- handlers ---

  /**
   * One change at a time, and a re-read after it.
   *
   * The response carries the whole settings object, but the page re-reads rather than
   * patching from it: a change to one threshold moves `config_hash`, which is rendered
   * at the top and in the finding counts beside every other rule. Trusting a local
   * patch to get all of that right is how a page starts disagreeing with the API it
   * just wrote to.
   */
  protected async onChanged(change: SettingChange): Promise<void> {
    await this.write(async () => {
      const result = await this.api.updateSettings({ changes: [change] });

      const what = change.value === null ? `${change.key} reset to its default` : `${change.key} updated`;
      this.notice.set(
        result.dismissalsAffected > 0
          ? `${what}. ${result.dismissalsAffected} dismissed ` +
              `${result.dismissalsAffected === 1 ? 'finding' : 'findings'} in this rule will be ` +
              're-evaluated on the next analysis run (§5.1).'
          : `${what}. Run an analysis to see it applied.`,
      );
    });
  }

  protected async onDataAction(action: DataAction): Promise<void> {
    switch (action.kind) {
      case 'backup':
        await this.write(async () => {
          const { path } = await this.api.backupData();
          this.lastBackupPath.set(path);
          this.notice.set('Backup written.');
        });
        return;

      case 'export':
        await this.write(async () => {
          const blob = await this.api.exportData(action.format);
          this.download(blob, `ledgerline-${this.stamp()}.${action.format}`);
          this.notice.set(`Exported as ${action.format.toUpperCase()}.`);
        });
        return;

      case 'wipe':
        await this.write(async () => {
          const result = await this.api.wipeData({ confirm: 'DELETE EVERYTHING' });
          this.lastBackupPath.set(result.backupPath);
          this.notice.set(
            `${result.rowsDeleted} rows deleted.` +
              (result.backupPath
                ? ` A backup was written to ${result.backupPath} first.`
                : ' This instance runs in memory, so there was nothing on disk to back up.'),
          );
        });
        return;
    }
  }

  /**
   * Hand the export to the browser.
   *
   * An object URL rather than a data URL: a year of statements as CSV is comfortably
   * past the length a `data:` URI survives in every browser, and this is the one place
   * in the app that produces a file the user keeps.
   */
  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private stamp(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async write(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
      this.revision.update((n) => n + 1);
    } catch (cause) {
      // `LedgerlineApiError` carries the API's own message — the 422 from an
      // unsettable field explains itself better than anything this page could add.
      this.notice.set(
        cause instanceof LedgerlineApiError
          ? cause.message
          : `That did not work: ${(cause as Error).message}`,
      );
    } finally {
      this.busy.set(false);
    }
  }
}

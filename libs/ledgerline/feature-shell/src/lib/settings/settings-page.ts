/**
 * §6.8, the Settings page.
 *
 * §6.8 names six sections. Five are built here and one is not, and which is which is
 * decided by what exists underneath rather than by what was quickest:
 *
 * - **Analyzers** — built. §7.4's machinery has existed since the analyzers landed
 *   ("Every threshold in §5 is a default in a config object; Settings overrides it"),
 *   and nothing could write the override, so the thresholds were data in principle and
 *   constants in practice. This is the section that makes §7.6's calibration a normal
 *   afternoon rather than a series of commits.
 * - **LLM provider** and **Redaction** — built. §2.4's seam exists, `GET /api/llm/health`
 *   answers for all three providers, and the picker writes a settings key of its own so
 *   that choosing one cannot move `config_hash`. The warning card is §6.8's own
 *   sentence, and it shows for the *armed* choice rather than the stored one (§9t).
 * - **Data** — built: database path, backup, export, §2.3's wipe, and §6.8's
 *   degraded-LLM-call log.
 * - **Merchant aliases** — built, and **not here**. It lived on this page for a day
 *   (§9r) and moved to §6.9's Review page the next (§9s). Settings is where you go to
 *   configure the app; the review queue is where you go to answer a question about
 *   your own data, and it needs to be noticed rather than found. It is not in
 *   `UNBUILT` below for that reason: it exists, it is just not this page's. §4.2's
 *   sub-floor proposals joined it there rather than here, for the same reason.
 * - **Categories** — not built. Editing the taxonomy and assigning §5.4's overlap
 *   groups needs write endpoints §2.3 lists and §1 counts as missing.
 *
 * The one that remains unbuilt is rendered as a stated absence rather than omitted,
 * for the same reason the shell's rail renders an unbuilt section as a span: a page
 * that quietly lacks half its parts reads as a page that is finished.
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
import type { DegradedCallLog, LlmHealth, LlmSettings, Settings } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AnalyzerSettings } from './analyzer-settings.js';
import type { SettingChange } from './analyzer-settings.js';
import { DataSettings } from './data-settings.js';
import { LlmSettingsPanel } from './llm-settings.js';
import type { LlmChange } from './llm-settings.js';
import type { DataAction } from './data-settings.js';

/**
 * What a provider change actually did, in the terms the user was deciding in.
 *
 * A free function rather than a method because it is a pure mapping and the class
 * has enough state on it already — and because the sentence for `claude-cli` has to
 * be exact, which is easier to see when it is not surrounded by request plumbing.
 */
function describeLlmChange(change: LlmChange): string {
  if (change.redaction !== undefined) {
    return change.redaction
      ? 'Redaction is on. Account numbers are stripped before anything is sent, and ' +
          'person-to-person payments are never sent at all.'
      : 'Redaction is off. Descriptors will be sent as they appear on the statement.';
  }

  switch (change.providerId) {
    case 'claude-cli':
      return (
        'Claude CLI is now the provider. Merchant descriptors will be sent off this machine ' +
        'to Anthropic when you ask for suggestions. The header says so while it is on.'
      );
    case 'ollama':
      return 'Ollama is now the provider. Descriptors go to the model on this machine and stay here.';
    case 'none':
      return 'The provider is off. Nothing is sent anywhere, and every number here is unchanged.';
    default:
      return 'Provider settings updated.';
  }
}

/** §6.8's sections with nothing behind them yet, and the reason in each case. Stated
 *  rather than omitted — see the header. */
const UNBUILT = [
  {
    title: 'Categories',
    detail:
      'The taxonomy is seeded and readable (§5’s categories, `GET /api/categories`), but ' +
      'editing it and assigning §5.4’s overlap groups needs write endpoints that do not exist.',
  },
] as const;

@Component({
  selector: 'll-settings-page',
  imports: [Panel, AnalyzerSettings, DataSettings, LlmSettingsPanel],
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

  /**
   * §6.8's Test Connection, held here rather than in the panel.
   *
   * A probe is a request, and the container owns every request on this page — but
   * there is a second reason it is not a resource: a health check must run *when
   * the button is pressed* and never on render. §2.4's providers spawn a process
   * or open a socket, and a page that probed on load would start the Claude CLI
   * every time someone opened Settings.
   */
  protected readonly health = signal<LlmHealth | null>(null);
  protected readonly probing = signal(false);

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

  /**
   * §6.8's provider block, defaulted rather than passed straight through.
   *
   * A `ledgerline-api` older than §2.4's seam serves a settings payload with no `llm`
   * key at all, and the template used to bind `all.llm` into a required input — so the
   * panel got `undefined` and threw on the first read of `providerId`, taking the whole
   * Settings page down before anything on it could be used. The header had the same
   * bug against the same payload.
   *
   * The default is §6.8's shipped state, which is the honest reading of an API that
   * has no provider support: nothing configured, nothing sent, redaction on. It errs
   * the one safe direction — `none` and local, never the reverse — so a stale binary
   * can never make this page under-report where the data goes.
   */
  protected readonly llm = computed<LlmSettings>(
    () =>
      this.settings()?.llm ?? {
        providerId: 'none',
        model: null,
        redaction: true,
        redactionLocked: false,
        sendsDataOffMachine: false,
        cachedResponses: 0,
        degradedCallCount: 0,
      },
  );

  /**
   * §6.8's degraded-call log, on the same revision as the settings.
   *
   * Tied to `revision` rather than its own counter because the two move together:
   * the things that add to this log are the things that change the provider, and a
   * log that refreshed independently would show a count that disagreed with the
   * `degradedCallCount` rendered a panel above it.
   */
  private readonly degradedResource = resource({
    params: () => this.revision(),
    loader: () => this.api.listDegradedCalls(),
    defaultValue: { entries: [], total: 0 } satisfies DegradedCallLog,
  });

  protected readonly degradedCalls = computed(() => this.degradedResource.value());

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

  /**
   * §6.8's provider and redaction write.
   *
   * The notice names the consequence rather than the setting, because that is what
   * the user was deciding: "Claude CLI is on" is a fact about a dropdown, and
   * "descriptors will now be sent to Anthropic" is the thing they agreed to.
   *
   * The probe is cleared, not re-run. A health answer belongs to the provider that
   * produced it, and leaving Ollama's green tick under a freshly-selected CLI would
   * be the one lie this section cannot afford.
   */
  protected async onLlmChanged(change: LlmChange): Promise<void> {
    await this.write(async () => {
      await this.api.updateSettings({ llm: change });
      this.health.set(null);
      this.notice.set(describeLlmChange(change));
    });
  }

  /** §6.8's Test Connection. Not a `write` — it changes nothing, and routing it
   *  through the busy flag would grey out the whole page while a CLI cold-starts. */
  protected async onTestConnection(): Promise<void> {
    if (this.probing()) return;
    this.probing.set(true);
    try {
      this.health.set(await this.api.getLlmHealth());
    } catch (cause) {
      this.health.set({
        providerId: this.settings()?.llm?.providerId ?? 'none',
        ok: false,
        detail:
          cause instanceof LedgerlineApiError
            ? cause.message
            : `The check itself failed: ${(cause as Error).message}`,
        model: null,
        sendsDataOffMachine: false,
        capabilities: [],
      });
    } finally {
      this.probing.set(false);
    }
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

/**
 * §6.8, the Settings page.
 *
 * §6.8 names six sections and, as of §9ad, all six are built. What each one is
 * built *on* was decided by what exists underneath rather than by what was quickest:
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
 * - **Merchant aliases** — built, and mostly **not here**. The queue lived on this
 *   page for a day (§9r) and moved to §6.9's Review page the next (§9s), taking
 *   §4.2's proposals with it: Settings is where you go to configure the app, and the
 *   queue is where you go to answer a question about your own data. What stayed is
 *   the half §6.8 describes as "a re-normalize trigger with job progress" — a sweep
 *   rebuilds derived state and is maintenance, which is what the rest of this page
 *   is (§9v).
 * - **Categories** — built (§9ad), and the last of the six. It is two things wearing
 *   one heading: a taxonomy editor, which is CRUD, and §5.4's overlap-group
 *   assignment, which is not — a group shared by two categories is the claim that
 *   they describe the same spending, and §9d recorded that path as dead because the
 *   seed set deliberately left the column unset. This is where it stops being dead.
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
import type {
  CategoryUpdate,
  CategoryUsage,
  DegradedCallLog,
  LlmHealth,
  LlmSettings,
  Settings,
  UpdateCategoryBody,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AnalyzerSettings } from './analyzer-settings.js';
import type { SettingChange } from './analyzer-settings.js';
import { CategorySettings } from './category-settings.js';
import type { CategoryAction } from './category-settings.js';
import { DataSettings } from './data-settings.js';
import { LlmSettingsPanel } from './llm-settings.js';
import { RenormalizeSettings } from './renormalize-settings.js';
import type { RenormalizeProgress } from './renormalize-settings.js';
import type { LlmChange } from './llm-settings.js';
import type { DataAction } from './data-settings.js';

/**
 * What a category edit actually did, in the terms §6.8 owes the user.
 *
 * A rename is a rename and says so briefly. A **kind** change is the one edit on this
 * page whose whole effect is somewhere else, so it reports the API's count and the
 * rules that read the column — never a count derived from what the page is holding.
 * An **overlap group** names the claim it just made, because "saved" would describe a
 * text field rather than the thing §5.4 will do with it.
 */
function describeCategoryEdit(
  result: CategoryUpdate,
  patch: UpdateCategoryBody,
): string {
  if (result.kindChangedFrom !== null) {
    const moved = result.transactionsRepartitioned;
    const rules = result.rulesAffected.join(' and ');
    return (
      `"${result.category.name}" is now ${result.category.kind} rather than ` +
      `${result.kindChangedFrom}. ${moved} ${moved === 1 ? 'charge' : 'charges'} ` +
      `${moved === 1 ? 'moves' : 'move'} between ${rules || 'the rules that read it'} ` +
      'on the next analysis run.'
    );
  }

  if (patch.overlapGroup !== undefined) {
    return result.category.overlapGroup === null
      ? `"${result.category.name}" is no longer in an overlap group.`
      : `"${result.category.name}" is in the "${result.category.overlapGroup}" group. Two or ` +
          'more categories in one group is what the duplicate check looks for — run an ' +
          'analysis to see it applied.';
  }

  if (patch.parentId !== undefined) {
    return result.category.parentId === null
      ? `"${result.category.name}" moved to the top level.`
      : `"${result.category.name}" moved under another category.`;
  }

  return `Renamed to "${result.category.name}".`;
}

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

@Component({
  selector: 'll-settings-page',
  imports: [
    Panel,
    AnalyzerSettings,
    CategorySettings,
    DataSettings,
    LlmSettingsPanel,
    RenormalizeSettings,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage {
  private readonly api = inject(LedgerlineApiService);

  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly lastBackupPath = signal<string | null>(null);

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

  /**
   * §6.8's re-normalize trigger: what the sweep would walk, and how it is going.
   *
   * The count comes from `GET /api/health` rather than being derived from anything
   * on this page, because it is the number the button *promises* — "re-read 326
   * charges" has to mean 326, and the only thing that knows is the store. The API
   * returns the same count when the job is enqueued, so the two cannot disagree.
   */
  private readonly healthResource = resource({
    params: () => this.revision(),
    loader: () => this.api.getHealth(),
    defaultValue: { ok: true, schemaVersion: 0, transactions: 0, profileLoadErrors: [] },
  });

  protected readonly transactionCount = computed(
    () => this.healthResource.value()?.transactions ?? 0,
  );

  /** Null when no sweep is in flight. §2.7's `{ state, progress, message }`, which
   *  §6.8 asks to be shown rather than a spinner. */
  protected readonly sweep = signal<RenormalizeProgress | null>(null);

  /**
   * §6.8's taxonomy, with what points at each row.
   *
   * On `revision` like everything else here, because a re-normalize moves the counts
   * this section renders: §2.5's normalize stage assigns a category from the
   * merchant's default, so a sweep can change how many charges sit in one. A section
   * that refreshed on its own would show a delete button for a category that had
   * acquired forty charges while the page was open.
   */
  private readonly categoriesResource = resource({
    params: () => this.revision(),
    loader: () => this.api.listCategoryUsage(),
    defaultValue: [] as CategoryUsage[],
  });

  protected readonly categories = computed(() => this.categoriesResource.value() ?? []);

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

  /**
   * §6.8's re-normalize trigger, and §2.7's poll.
   *
   * Not routed through `write`, for the reason the progress bar exists: a sweep over
   * §2.2's ceiling is tens of thousands of rows, and greying out the whole Settings
   * page for the duration would make the bar something you watch rather than
   * something you glance at. The button disables itself instead.
   *
   * The poll is bounded and a timeout is not a failure — §2.7 makes the queue a
   * table, so the work finishes whether or not this page is still watching. What the
   * page stops doing is claiming to know.
   */
  protected async onRenormalizeAll(): Promise<void> {
    if (this.sweep() !== null) return;
    this.sweep.set({ progress: 0, message: 'starting…', done: false });

    try {
      const started = await this.api.renormalizeAll();

      let job = await this.api.getJob(started.id);
      for (
        let attempt = 0;
        attempt < 600 && (job.state === 'queued' || job.state === 'running');
        attempt += 1
      ) {
        this.sweep.set({ progress: job.progress, message: job.message, done: false });
        await new Promise((resolve) => setTimeout(resolve, 250));
        job = await this.api.getJob(started.id);
      }

      const settled = job.state === 'succeeded';
      this.sweep.set({
        progress: settled ? 100 : job.progress,
        message: job.message,
        done: settled,
      });
      this.notice.set(
        settled
          ? `Re-read ${started.transactions} ${started.transactions === 1 ? 'charge' : 'charges'}. ` +
              'Subscriptions and findings have been recalculated.'
          : job.state === 'failed'
            ? `The re-read did not finish: ${job.message ?? 'no reason given'}`
            : 'Still working. It will finish whether or not this page is open.',
      );
      // The counts on this page are derived from what the sweep just moved.
      this.revision.update((n) => n + 1);
    } catch (cause) {
      this.sweep.set(null);
      this.notice.set(
        cause instanceof LedgerlineApiError
          ? cause.message
          : `That did not work: ${(cause as Error).message}`,
      );
    }
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

  /**
   * §6.8's Categories writes, and the two that owe the user a sentence.
   *
   * **A kind change** is reported with the API's own count and rule list rather than
   * a generic "saved". §5.8 and §6.6 read `kind = 'fee'` and §5.10 trends only
   * `kind = 'spend'`, so moving a category between them moves every charge in it
   * between those rules — the one edit on this page whose consequence is entirely
   * off-screen.
   *
   * **A delete** reports what it moved. `category_in_use` comes back as the API's own
   * message, which names the counts and the way through; nothing here rewords it,
   * because the page's version of that sentence would be a second copy of a rule the
   * database owns.
   *
   * An **overlap-group** change says the least, deliberately: the claim it makes is
   * §5.4's to act on at the next analysis run, and this page cannot know how many
   * series will land in the group without re-deriving the rule.
   */
  protected async onCategoryAction(action: CategoryAction): Promise<void> {
    switch (action.kind) {
      case 'create':
        await this.write(async () => {
          const created = await this.api.createCategory(action.draft);
          this.notice.set(`"${created.name}" added.`);
        });
        return;

      case 'edit':
        await this.write(async () => {
          const result = await this.api.updateCategory(action.id, action.patch);
          this.notice.set(describeCategoryEdit(result, action.patch));
        });
        return;

      case 'delete':
        await this.write(async () => {
          const result = await this.api.deleteCategory(
            action.id,
            action.reassignTo === null ? {} : { reassignTo: action.reassignTo },
          );
          this.notice.set(
            result.reassignedTo === null
              ? 'Category deleted.'
              : `Category deleted. ${result.transactionsMoved} ` +
                  `${result.transactionsMoved === 1 ? 'charge' : 'charges'} and ` +
                  `${result.merchantsMoved} ${result.merchantsMoved === 1 ? 'merchant' : 'merchants'} ` +
                  'moved.' +
                  (result.childrenPromoted > 0
                    ? ` ${result.childrenPromoted} ` +
                      `${result.childrenPromoted === 1 ? 'subcategory' : 'subcategories'} ` +
                      'moved to the top level.'
                    : ''),
          );
        });
        return;
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

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
 * - **Merchant aliases** — built. §4.1 step 7's review queue reaches a person here:
 *   the pairs the chain could not tell apart, the merchants it named for itself, and
 *   the one action that resolves either (§4.3, §9p, §9q).
 * - **Categories** — not built. Editing the taxonomy and assigning §5.4's overlap
 *   groups needs write endpoints §2.3 lists and §1 counts as missing.
 *
 * The three that remain are rendered as stated absences rather than omitted, for the
 * same reason the shell's rail renders an unbuilt section as a span: a page that
 * quietly lacks half its parts reads as a page that is finished.
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
import type { MerchantReviewQueue, Settings } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AnalyzerSettings } from './analyzer-settings.js';
import type { SettingChange } from './analyzer-settings.js';
import { DataSettings } from './data-settings.js';
import { MerchantReview } from './merchant-review.js';
import type { DataAction } from './data-settings.js';
import type { MergeRequest } from './merchant-review.js';

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
    title: 'Categories',
    detail:
      'The taxonomy is seeded and readable (§5’s categories, `GET /api/categories`), but ' +
      'editing it and assigning §5.4’s overlap groups needs write endpoints that do not exist.',
  },
] as const;

@Component({
  selector: 'll-settings-page',
  imports: [Panel, AnalyzerSettings, DataSettings, MerchantReview],
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

  /**
   * §4.1 step 7's queue. Its own resource rather than a field on the settings
   * one: a merge changes what is worth reviewing but not a single threshold, and
   * re-reading the whole settings surface to refresh a list of merchants would
   * make `config_hash` appear to move when nothing about §5 changed.
   *
   * `defaultValue` is an empty queue, because "nothing to review" is a valid and
   * common state and rendering it while the first read is in flight is honest.
   */
  private readonly reviewRevision = signal(0);
  private readonly reviewResource = resource({
    params: () => this.reviewRevision(),
    loader: () => this.api.getMerchantReviewQueue(),
    defaultValue: {
      mergeCandidates: [],
      provisional: [],
      llmProposals: [],
      llmProposalsUnavailableReason: null,
    } satisfies MerchantReviewQueue,
  });

  protected readonly review = computed(() => this.reviewResource.value());

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

  /**
   * §4.3's correction, and the one write on this panel.
   *
   * The notice reports the count the *API* returned rather than the one the card
   * showed. They should agree, and on the day they do not the user is owed the
   * true number — a merge is permanent, and "47 charges moved" has to mean it.
   *
   * **The re-read waits for the job**, which is the difference between a card that
   * disappears and one that sits there having apparently done nothing. The alias
   * is written synchronously but the rows move in §4.3's re-normalize job, so a
   * queue re-read issued the moment the POST returns still sees the old counts and
   * proposes the merge that was just made. §2.7's answer is that the UI polls a
   * job rather than blocking on it, and §6.4's Run analysis already runs this loop.
   */
  protected async onMerge(request: MergeRequest): Promise<void> {
    await this.write(async () => {
      const result = await this.api.mergeMerchant(request.mergeMerchantId, {
        intoMerchantId: request.intoMerchantId,
      });

      const settled = await this.awaitJob(result.jobId);

      this.notice.set(
        `${request.mergeName} is now ${request.keepName}. ` +
          `${result.transactionsAffected} ` +
          `${result.transactionsAffected === 1 ? 'charge' : 'charges'} moved` +
          (settled
            ? ', and subscriptions and findings have been recalculated (§4.3).'
            : '. Subscriptions and findings are still recalculating.'),
      );
      this.reviewRevision.update((n) => n + 1);
    });
  }

  /**
   * §2.7's poll. Returns whether the job actually landed, so the notice can say
   * "have been" or "are still" rather than guessing.
   *
   * Bounded, and a timeout is not a failure: the work is queued and finishes
   * whether or not this page is still watching. A merge that reported success and
   * then threw because a poll ran out would be the worst of both.
   */
  private async awaitJob(jobId: string): Promise<boolean> {
    let job = await this.api.getJob(jobId);

    for (
      let attempt = 0;
      attempt < 60 && (job.state === 'queued' || job.state === 'running');
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = await this.api.getJob(jobId);
    }

    return job.state === 'succeeded';
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

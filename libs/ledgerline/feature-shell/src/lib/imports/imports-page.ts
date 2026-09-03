/**
 * §6.1, the page.
 *
 * "Full-page dropzone accepting multiple files at once. [...] Then the **Review**
 * table [...] Account assignment is auto-guessed from the filename and statement
 * header and must be confirmed. Nothing enters the database until **Commit**.
 * [...] The **column mapper** appears inline for unknown formats [...] Below:
 * import history with re-parse and delete."
 *
 * Same split as the Transactions page: the container owns all state and every
 * request; the children are presentational, except `ColumnMapper`, which owns its
 * own draft and the live preview it drives — the `MerchantAssign` exception, for
 * the same reason.
 *
 * ## Three things worth knowing before changing this file
 *
 * **The account is confirmed with a `PATCH`, and that is not a formality.**
 * `POST /commit` refuses an import with no account, and `GET /api/imports/:id`
 * returns `plan: null` until there is one — the merge rule (§3.3) counts rows
 * *within an account*, so there is no such thing as a duplicate count before the
 * account is known. The commit control does not exist until the account does,
 * which is why this page cannot show a plan and then commit it somewhere else.
 *
 * **Nothing here is optimistic.** Every write re-reads the review rather than
 * patching what it believes the new state to be. A staged import's dispositions
 * are a function of what is already in the account, so a locally-applied change
 * would be a guess about the merge rule — and §2.5 puts this whole screen in front
 * of the user precisely because guesses about the merge rule are expensive.
 *
 * **Money is never parsed back.** `amountCents` is what arrives and what is
 * rendered through `formatCents` (§7.3); nothing on this page reads a formatted
 * string, and there is no money input on it at all.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  resource,
  signal,
} from '@angular/core';
import { Panel } from '@metrum/ui';
import { formatCents } from '@metrum/ledgerline-domain';
import { LedgerlineApiError } from '@metrum/api-client';
import type {
  Account,
  CreateAccountBody,
  FormatProfile,
  FormatProfileDraft,
  ImportReview,
  NearDuplicateCandidate,
  StatementImport,
} from '@metrum/api-client';

import { NewAccount } from '../accounts/new-account.js';
import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { ReviewQueue } from '../review/review-queue.service.js';
import { ColumnMapper } from './column-mapper.js';
import { ImportDropzone } from './import-dropzone.js';
import type { StagedFileRow } from './import-dropzone.js';
import { ImportHistory } from './import-history.js';
import { ReviewTable } from './review-table.js';
import type { Resolution, ResolutionChange } from './review-table.js';
import { lineNumbersFor, reviewWarnings } from './review-warnings.js';

@Component({
  selector: 'll-imports-page',
  imports: [Panel, ImportDropzone, ReviewTable, ColumnMapper, ImportHistory, NewAccount],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './imports-page.html',
  styleUrl: './imports-page.scss',
  host: {
    // §6.1 asks for a *full-page* dropzone, so a drop anywhere lands. The zone
    // itself stops propagation, so a drop on the visible target is handled once.
    '(dragover)': 'onPageDragOver($event)',
    '(drop)': 'onPageDrop($event)',
  },
})
export class ImportsPage {
  private readonly api = inject(LedgerlineApiService);

  /** §4.1 step 7's queue, shared with §6.9's page and the rail's badge. A commit
   *  is one of the two things that changes it. */
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly formatCents = formatCents;

  // ------------------------------------------------------------- reads ---

  /** Bumped after a write, so every read re-runs rather than being patched. */
  private readonly revision = signal(0);

  protected readonly selectedImportId = signal<string | null>(null);

  protected readonly review = resource({
    params: () => {
      const id = this.selectedImportId();
      // `undefined` leaves the resource idle rather than loading `/api/imports/null`.
      return id === null ? undefined : { id, revision: this.revision() };
    },
    loader: ({ params }) => this.api.getImport(params.id),
  });

  private readonly importList = resource({
    params: () => this.revision(),
    loader: () => this.api.listImports(),
    defaultValue: [] as StatementImport[],
  });

  private readonly accountList = resource({
    params: () => this.revision(),
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  private readonly profileList = resource({
    params: () => this.revision(),
    loader: () => this.api.listFormatProfiles(),
    defaultValue: [] as FormatProfile[],
  });

  protected readonly imports = computed(() => this.importList.value());
  protected readonly accounts = computed(() => this.accountList.value());
  protected readonly profiles = computed(() => this.profileList.value());

  /** `hasValue()` before `value()`, always: a `resource` in an error state throws
   *  from `value()`, and this page has to render when the API is unreachable. */
  protected readonly current = computed<ImportReview | null>(() =>
    this.review.hasValue() ? this.review.value() : null,
  );

  protected readonly record = computed<StatementImport | null>(
    () => this.current()?.import ?? null,
  );
  protected readonly plan = computed(() => this.current()?.plan ?? null);
  protected readonly nearDuplicates = computed<readonly NearDuplicateCandidate[]>(
    () => this.plan()?.nearDuplicates ?? [],
  );

  protected readonly warnings = computed(() => {
    const review = this.current();
    return review ? reviewWarnings(review) : [];
  });

  /** Every row any warning points at, so the table can mark the same rows the
   *  strip is talking about. */
  protected readonly flaggedRows = computed(
    () => new Set(this.warnings().flatMap((warning) => warning.rowIndexes)),
  );

  protected readonly needsMapping = computed(() => this.record()?.status === 'needs_mapping');
  protected readonly isCommitted = computed(() => this.record()?.status === 'committed');

  /** §6.1: the guess "must be confirmed". Confirmation is an account on the
   *  import itself, which is also what makes `plan` non-null. */
  protected readonly accountConfirmed = computed(() => this.record()?.accountId != null);

  protected readonly canCommit = computed(
    () =>
      this.accountConfirmed() &&
      !this.isCommitted() &&
      this.record()?.status === 'staged' &&
      !this.busy(),
  );

  // ------------------------------------------------------------ writes ---

  protected readonly staged = signal<readonly StagedFileRow[]>([]);
  protected readonly notice = signal<string | null>(null);
  protected readonly commitReport = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly expandedRow = signal<number | null>(null);

  /**
   * The three-way choices, seeded from the API's defaults.
   *
   * `linkedSignal` on the candidate list: a re-parse or a re-read renumbers rows,
   * and a resolution held against a row index that now means something else is
   * worse than no resolution at all. §3.3's defaults — replace for
   * pending-to-posted, keep both otherwise — are pre-selected, never applied.
   */
  protected readonly resolutions = linkedSignal<
    readonly NearDuplicateCandidate[],
    ReadonlyMap<number, Resolution>
  >({
    source: () => this.nearDuplicates(),
    computation: (candidates) =>
      new Map(candidates.map((candidate) => [candidate.rowIndex, candidate.defaultResolution])),
  });

  /** §3.2: a non-pending $0 row is refused as a probable misparse unless the
   *  reviewer says it is a trial authorization. */
  protected readonly allowZeroAmountRows = signal(false);
  protected readonly zeroAmountRows = signal<readonly number[]>([]);

  protected readonly suggestedAccountId = computed(
    () => this.current()?.accountSuggestion?.accountId ?? '',
  );

  /**
   * What the account picker is showing, before anybody presses Confirm.
   *
   * `null` means untouched, in which case the picker shows the guess (or the
   * account already confirmed). It cannot default to those directly, because
   * "the user has not chosen" and "the user chose the same thing" have to stay
   * distinguishable.
   *
   * ## Why this exists at all
   *
   * The picker used to `PATCH` straight from its `change` event, and the guess
   * was pre-`selected` in the DOM — so choosing the guessed account produced no
   * `change` at all and appeared to do nothing. The way through was to select the
   * placeholder and then re-select the account, which is not a workflow anybody
   * should have to discover.
   *
   * Confirming with a button rather than on selection also puts this in line with
   * every other write on this page: §6.1 calls the account a confirmation, and
   * §3.3's near-duplicate picker already holds that "nothing applies on hover,
   * focus or selection."
   */
  private readonly pickedAccountId = signal<string | null>(null);

  protected readonly chosenAccountId = computed(
    () => this.pickedAccountId() ?? this.record()?.accountId ?? this.suggestedAccountId(),
  );

  /** Nothing to confirm when the picker is on the placeholder, or when it names
   *  the account this import is already filed into. */
  protected readonly canConfirmAccount = computed(() => {
    const chosen = this.chosenAccountId();
    return chosen !== '' && chosen !== this.record()?.accountId && !this.busy();
  });

  protected pickAccount(accountId: string): void {
    this.pickedAccountId.set(accountId);
  }

  protected async confirmPickedAccount(): Promise<void> {
    if (!this.canConfirmAccount()) return;
    await this.confirmAccount(this.chosenAccountId());
    this.pickedAccountId.set(null);
  }

  /** The opt-in is offered when the parse found $0 rows, not only after commit has
   *  already refused them — being told about it twice is better than a 422 the
   *  reviewer had no way to see coming. */
  protected readonly hasZeroAmountRows = computed(
    () =>
      this.zeroAmountRows().length > 0 ||
      this.warnings().some((warning) => warning.kind === 'zero_amount'),
  );

  /** The refusal names rows by `rowIndex`, because that is the API's key. On
   *  screen it becomes the file line, like every other number this page prints —
   *  see `review-warnings.ts`. */
  protected readonly zeroAmountLines = computed(() => {
    const current = this.current();
    return current === null ? [] : lineNumbersFor(current, this.zeroAmountRows());
  });

  protected accountName(accountId: string | null): string {
    if (!accountId) return 'no account';
    return this.accounts().find((account) => account.id === accountId)?.displayName ?? accountId;
  }

  // ---------------------------------------------------------- uploading ---

  protected onPageDragOver(event: DragEvent): void {
    // Without this the browser leaves the app to display the dropped file.
    event.preventDefault();
  }

  protected onPageDrop(event: DragEvent): void {
    event.preventDefault();
    void this.upload([...(event.dataTransfer?.files ?? [])]);
  }

  protected onDropped(files: File[]): void {
    void this.upload(files);
  }

  /**
   * One request per file, not one request for all of them.
   *
   * `POST /api/imports` accepts several, but a single request has one outcome for
   * the batch: no per-file progress, and one refused file takes the row that
   * explains it away from the others. §6.1 asks for a row per file with its own
   * progress and its own badge, and that is only honest if each file has its own
   * request.
   */
  private async upload(files: readonly File[]): Promise<void> {
    const csvish = files.filter((file) => file.size > 0);
    if (csvish.length === 0) return;

    this.notice.set(null);
    let opened = false;

    for (const file of csvish) {
      const key = `${file.name}:${file.size}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

      this.staged.update((rows) => [
        ...rows,
        {
          key,
          filename: file.name,
          sizeBytes: file.size,
          state: 'uploading',
          importId: null,
          created: true,
          status: null,
          formatProfileId: null,
          errorDetail: null,
          requestError: null,
        },
      ]);

      try {
        const result = await this.api.uploadImports([file]);
        const uploaded = result.imports[0];

        this.patchStaged(key, {
          state: 'staged',
          importId: uploaded.import.id,
          created: uploaded.created,
          status: uploaded.import.status,
          formatProfileId: uploaded.import.formatProfileId,
          errorDetail: uploaded.import.errorDetail,
        });

        /**
         * Open the first file of *this* drop, whatever was on screen before.
         *
         * Dropping a file is an unambiguous statement about what the user wants
         * to look at next, and leaving the previous review up makes a drop look
         * like it did nothing until the staged row is noticed and clicked. It
         * costs the near-duplicate choices on an import left mid-review — those
         * re-seed from the API's defaults on the way back, which is a re-decision
         * rather than a loss.
         */
        if (!opened) {
          opened = true;
          this.select(uploaded.import.id);
        }
      } catch (cause) {
        this.patchStaged(key, { state: 'failed', requestError: (cause as Error).message });
      }
    }

    this.revision.update((value) => value + 1);
  }

  private patchStaged(key: string, change: Partial<StagedFileRow>): void {
    this.staged.update((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
  }

  // ------------------------------------------------------------ review ---

  protected select(importId: string): void {
    this.selectedImportId.set(importId);
    this.expandedRow.set(null);
    this.commitReport.set(null);
    this.zeroAmountRows.set([]);
    this.allowZeroAmountRows.set(false);
    // Both are per-import decisions: carrying either into the next file would
    // apply one statement's answers to another's rows.
    this.pickedAccountId.set(null);
    this.droppedRows.set(new Set());
  }

  protected toggleRow(rowIndex: number): void {
    this.expandedRow.update((current) => (current === rowIndex ? null : rowIndex));
  }

  /**
   * §9ah: rows the reviewer says are not real, dropped at commit.
   *
   * Only offered on a row the parser flagged as an in-file duplicate. §3.3's
   * merge rule compares against what is *stored*, so it cannot see two identical
   * lines in one file and — rightly — keeps both: "two coffees on the same day at
   * the same price is a real pair of transactions." That default stands. What was
   * missing was the other answer, for the bank that posted one charge twice.
   *
   * Empty unless ticked. Nothing infers a drop, because §3.3's standing trade is
   * that over-counting is visible and a lost transaction is not.
   */
  protected readonly droppedRows = signal<ReadonlySet<number>>(new Set());

  protected readonly duplicateInFileRows = computed(
    () =>
      new Set(
        (this.current()?.warnings ?? [])
          .filter((warning) => warning.kind === 'duplicate_in_file')
          .map((warning) => warning.rowIndex)
          .filter((rowIndex): rowIndex is number => rowIndex !== undefined),
      ),
  );

  /**
   * What Commit will actually insert.
   *
   * The plan's `willInsert` is the API's figure and predates any drop made since
   * the last read, so the button would promise a number larger than the one that
   * lands. §6.3 makes the same argument about its bulk count: the figure on the
   * control is the basis on which somebody authorises the write.
   */
  protected readonly rowsToCommit = computed(() => {
    const current = this.current();
    if (!current) return 0;
    const planned = current.plan?.willInsert ?? current.rows.length;
    // Only rows that were going to be inserted can be un-inserted; a drop on a
    // row the merge rule already absorbed would double-count.
    const droppable = new Set(current.rows.map((row) => row.rowIndex));
    const dropped = [...this.droppedRows()].filter((rowIndex) => droppable.has(rowIndex)).length;
    return Math.max(0, planned - dropped);
  });

  protected toggleDropped(rowIndex: number): void {
    this.droppedRows.update((current) => {
      const next = new Set(current);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }

  protected onResolutionChange(change: ResolutionChange): void {
    this.resolutions.update((current) => {
      const next = new Map(current);
      next.set(change.rowIndex, change.resolution);
      return next;
    });
  }

  protected setAllowZeroAmountRows(allow: boolean): void {
    this.allowZeroAmountRows.set(allow);
  }

  /** §6.1's confirmation step. The `PATCH` is what makes it a confirmation
   *  rather than a suggestion the commit path silently trusted. */
  protected async confirmAccount(accountId: string): Promise<void> {
    if (accountId === '') return;
    const id = this.selectedImportId();
    if (!id) return;

    await this.write(async () => {
      await this.api.updateImport(id, { accountId });
      const name = this.accounts().find((account) => account.id === accountId)?.displayName;
      this.notice.set(
        `Filing into ${name ?? accountId}. Duplicate counts below are against that account — ` +
          'the merge rule counts rows within one account (§3.3).',
      );
    });
  }

  /**
   * Create an account and confirm this import into it, in one action.
   *
   * §6.2 owns accounts and §6.1 owns imports, and on a fresh database that split
   * deadlocks: the import cannot commit until an account exists, and the only
   * page that makes one told the user to import a statement. The form is offered
   * here as well as there, and confirming straight afterwards is not a
   * convenience — the reason someone filled it in on this page is that this
   * import needed somewhere to go.
   *
   * `confirmAccount` cannot be reused verbatim: it names the account by looking
   * it up in `accounts()`, which has not re-read yet. The response has the name.
   */
  protected async createAccount(body: CreateAccountBody): Promise<void> {
    const importId = this.selectedImportId();

    await this.write(async () => {
      const account = await this.api.createAccount(body);
      if (importId) await this.api.updateImport(importId, { accountId: account.id });
      this.notice.set(
        `Created ${account.displayName}` +
          (importId
            ? ` and filed this statement into it. Duplicate counts below are against that ` +
              'account — the merge rule counts rows within one account (§3.3).'
            : '.'),
      );
    });
  }

  /**
   * §6.1: "Nothing enters the database until Commit."
   *
   * The resolutions travel with the request rather than having been applied
   * beforehand, because until this call there is nothing to apply them to.
   */
  protected async commit(): Promise<void> {
    const id = this.selectedImportId();
    if (!id || !this.canCommit()) return;

    const resolutions = this.nearDuplicates().map((candidate) => ({
      rowIndex: candidate.rowIndex,
      existingTransactionId: candidate.existingTransactionId,
      resolution: this.resolutions().get(candidate.rowIndex) ?? candidate.defaultResolution,
    }));

    // Same reason as in `write`: a previous report would otherwise sit on top of
    // this attempt's own outcome, including a refusal.
    this.commitReport.set(null);
    this.busy.set(true);
    try {
      const result = await this.api.commitImport(id, {
        resolutions,
        dropRowIndexes: [...this.droppedRows()],
        allowZeroAmountRows: this.allowZeroAmountRows(),
      });

      this.zeroAmountRows.set([]);
      this.commitReport.set(
        result.alreadyCommitted
          ? 'Already committed — this import was idempotent and nothing changed.'
          : `Committed. ${result.rowsInserted} inserted · ${result.rowsMerged} absorbed as ` +
              `already present · ${result.rowsReplaced} replaced · ` +
              `${result.rowsSkippedAsNearDuplicate} skipped · ` +
              // Only when it happened: a "0 dropped" on every commit would make a
              // deliberate, irreversible choice look like routine bookkeeping.
              (result.rowsDropped > 0 ? `${result.rowsDropped} dropped · ` : '') +
              `${result.refundPairsLinked} refund ${result.refundPairsLinked === 1 ? 'pair' : 'pairs'} linked.`,
      );
      this.notice.set(null);
      this.revision.update((value) => value + 1);
      await this.reportMerchantQuestions();
    } catch (cause) {
      this.reportFailure(cause, 'That commit did not run');
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * §4.1 step 7, surfaced at the moment it is cheapest to act on.
   *
   * A statement is the thing that creates these questions, so the import that
   * created them is the honest place to say so. That was the whole argument while
   * the queue was a section of Settings (§9r) and it survives the move to §6.9's
   * own page (§9s) — the rail badge now says a question exists, and this says
   * *which import* raised it, which the badge cannot.
   *
   * Appended to the commit report rather than raised as its own banner: the count
   * that matters immediately is still the rows, and a second strip competing with
   * the first is how a page teaches people to dismiss both.
   *
   * The re-read goes through `ReviewQueue` rather than the API directly, so one
   * request updates this sentence and the rail's badge together. Failing is
   * deliberately silent — the store keeps whatever it last held, and a commit that
   * worked has worked; it must not report a failure because an advisory count
   * could not be fetched.
   */
  private async reportMerchantQuestions(): Promise<void> {
    await this.reviewQueue.refresh();

    const count = this.reviewQueue.queue().mergeCandidates.length;
    if (count === 0) return;

    this.commitReport.update(
      (report) =>
        `${report ?? ''} ${count} ${count === 1 ? 'merchant may be' : 'merchants may be'} ` +
        `the same as another under a different spelling — see Review.`.trimStart(),
    );
  }

  protected async reparse(importId: string): Promise<void> {
    await this.write(async () => {
      await this.api.updateImport(importId, { reparse: true });
      this.selectedImportId.set(importId);
      this.notice.set('Re-parsed from the stored bytes.');
    });
  }

  protected async remove(importId: string): Promise<void> {
    await this.write(async () => {
      const result = await this.api.deleteImport(importId);

      const deleted = result.deletedTransactionIds.length;
      const retained = result.retainedTransactionIds.length;

      this.notice.set(
        `Deleted the import and ${deleted} ${deleted === 1 ? 'row' : 'rows'}.` +
          (retained > 0
            ? ` ${retained} ${retained === 1 ? 'row is' : 'rows are'} still here: another ` +
              'overlapping import also sources them, and removing them would have deleted ' +
              'rows that import legitimately contains (§3.3).'
            : ''),
      );

      if (this.selectedImportId() === importId) this.selectedImportId.set(null);
      this.staged.update((rows) => rows.filter((row) => row.importId !== importId));
    });
  }

  /**
   * §6.1's mapper, both halves. Saving stores the profile; it deliberately does
   * not re-parse, so the re-parse is a second call — and it is the same
   * `PATCH /api/imports/:id` path any other profile change takes, rather than a
   * second implementation of re-parsing living inside the save.
   */
  protected async saveMapping(draft: FormatProfileDraft): Promise<void> {
    const id = this.selectedImportId();
    if (!id) return;

    await this.write(async () => {
      const profile = await this.api.createFormatProfile({ importId: id, draft });
      await this.api.updateImport(id, { formatProfileId: profile.id });
      this.notice.set(
        `Saved "${profile.institution}" and re-parsed. The next statement with this header ` +
          'imports without asking.',
      );
      this.staged.update((rows) =>
        rows.map((row) =>
          row.importId === id ? { ...row, status: 'staged', formatProfileId: profile.id } : row,
        ),
      );
    });
  }

  /**
   * One place a write happens, so one place that clears busy, re-reads and turns
   * a failure into something the user can read.
   *
   * Clearing the commit report first is not tidiness. The strip renders the
   * report *or* the notice, the report being the louder of the two, so a stale
   * "Committed. 8 inserted…" left over from a minute ago hides the message the
   * action just produced — a delete would report its retained rows into a
   * message nobody sees.
   */
  private async write(action: () => Promise<void>): Promise<void> {
    this.commitReport.set(null);
    this.busy.set(true);
    try {
      await action();
      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.reportFailure(cause, 'That did not apply');
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The API's machine-readable codes, turned into the thing each one actually
   * means for the reviewer.
   *
   * Branching on `error.code` rather than on the prose is the whole reason
   * `LedgerlineApiError` carries the parsed body — the message may be reworded,
   * the code is documented as stable.
   */
  private reportFailure(cause: unknown, prefix: string): void {
    if (cause instanceof LedgerlineApiError) {
      if (cause.code === 'zero_amount_rows') {
        this.zeroAmountRows.set(cause.body?.rowIndexes ?? []);
        this.notice.set(
          `${cause.message} Tick "these $0 rows are trial authorizations" below if they are ` +
            'real — a $0 row is far more often an amount column read wrong (§3.2).',
        );
        return;
      }
      if (cause.code === 'already_committed') {
        this.notice.set(
          `${cause.message} Its rows are in the transaction table; delete the import and ` +
            're-import to parse it differently.',
        );
        return;
      }
      if (cause.code === 'import_not_ready') {
        this.notice.set(cause.message);
        return;
      }
    }

    this.notice.set(`${prefix}: ${(cause as Error).message}`);
  }

  protected dismissNotice(): void {
    this.notice.set(null);
    this.commitReport.set(null);
  }

  protected reload(): void {
    this.revision.update((value) => value + 1);
  }
}

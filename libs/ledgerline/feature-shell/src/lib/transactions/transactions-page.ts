/**
 * §6.3, the page.
 *
 * "Virtualized table. Filters for account, date range, amount range, merchant,
 * category, has-finding, pending, and an internal-transfer toggle (off by
 * default). Full-text search across raw and normalized descriptors. Row expander
 * reveals the verbatim statement line and the imports that cover it. Inline edits:
 * assign merchant, assign category, mark internal transfer, exclude from
 * analysis."
 *
 * The container owns all state and every request; the four child components are
 * presentational or, in `MerchantAssign`'s case, own one dry-run count. That split
 * is what keeps "the filter the user is reading" and "the filter the bulk apply
 * uses" the same object rather than two that agree by inspection.
 *
 * ## Two things worth knowing before changing this file
 *
 * **Server pagination, client virtualization.** `GET /api/transactions` pages
 * (§2.3) and the table windows within a page. A heavy household is ~58,000
 * transactions (§2.2); neither alone would do — all rows in one request is a 60 MB
 * response, and virtualizing without paging still asks SQLite for all of it.
 *
 * **Money never round-trips through a string.** `amountCents` is what arrives,
 * what is filtered on, and what is sorted by; `formatCents` is called in the
 * template and its output is never read back (§7.3). The one place a human types
 * money is the amount filter, and that goes through `domain`'s own
 * `parseMoneyToCents`.
 */

import {
  ChangeDetectionStrategy,
  Component,
  afterRenderEffect,
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import type { ElementRef } from '@angular/core';
import { Panel } from '@metrum/ui';
import { formatCents } from '@metrum/ledgerline-domain';
import type {
  Account,
  Category,
  Job,
  ListTransactionsQuery,
  Merchant,
  TransactionDetail,
  TransactionFilter as BulkFilter,
  TransactionSearchRow,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { MerchantAssign } from './merchant-assign.js';
import type { MerchantAssignment } from './merchant-assign.js';
import { TransactionDetailPanel } from './transaction-detail.js';
import { EMPTY_FILTER, TransactionFilters, amountCents } from './transaction-filters.js';
import type { TransactionFilterState } from './transaction-filters.js';
import { ROW_HEIGHT, virtualWindow } from './virtual-window.js';

type Sort = NonNullable<ListTransactionsQuery['sort']>;

/** 250 is the default because it is a comfortable amount of scrolling for a
 *  windowed table; 25 is here because reviewing a single statement month is a real
 *  thing to want, and 500 is the largest page still worth virtualizing rather than
 *  paging. The API caps a page at 1000 either way. */
const PAGE_SIZES = [25, 100, 250, 500] as const;

/** Matches `.detail` in `transaction-detail.scss` closely enough for the window
 *  arithmetic; the panel is measured after render and this is only the first
 *  frame's estimate. */
const ESTIMATED_DETAIL_HEIGHT = 240;

/**
 * §2.7's job poll. The runner holds a short window before it starts, so the first
 * read almost always finds the job still `queued` — which is the correct thing to
 * show, not a reason to poll faster.
 *
 * The budget is generous because the job's second half is a full analysis over
 * every transaction (§2.7), and it is a budget rather than a timeout: running out
 * leaves the last reported state on screen and stops asking. A job that outlives
 * it is still in `job`, and `GET /api/jobs` still lists it.
 */
const RENORMALIZE_POLL_INTERVAL_MS = 500;
const RENORMALIZE_POLL_ATTEMPTS = 120;

interface EditState {
  readonly transactionId: string;
  readonly kind: 'merchant' | 'category';
}

@Component({
  selector: 'll-transactions-page',
  imports: [Panel, TransactionFilters, TransactionDetailPanel, MerchantAssign],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transactions-page.html',
  styleUrl: './transactions-page.scss',
})
export class TransactionsPage {
  private readonly api = inject(LedgerlineApiService);

  protected readonly ROW_HEIGHT = ROW_HEIGHT;
  protected readonly PAGE_SIZES = PAGE_SIZES;
  protected readonly formatCents = formatCents;

  // ------------------------------------------------------------- filters ---

  protected readonly filter = signal<TransactionFilterState>(EMPTY_FILTER);
  protected readonly sort = signal<Sort>('date_desc');
  protected readonly pageSize = signal<number>(250);

  /**
   * `linkedSignal`, not `signal`: changing a filter has to send the user back to
   * the first page. Holding offset 5,000 while narrowing to eleven rows shows an
   * empty table and a total that says otherwise, and it is the kind of bug that
   * only appears after someone has already scrolled.
   */
  protected readonly offset = linkedSignal<unknown, number>({
    source: () => ({
      filter: this.filter(),
      sort: this.sort(),
      pageSize: this.pageSize(),
    }),
    computation: () => 0,
  });

  /** The filter, translated once into the query the API takes. */
  private readonly query = computed<ListTransactionsQuery>(() => {
    const f = this.filter();
    const range = f.from !== '' && f.to !== '' ? { from: f.from, to: f.to } : {};

    return {
      ...range,
      accountIds: f.accountIds.join(',') || undefined,
      merchantIds: f.merchantIds.join(',') || undefined,
      categoryIds: f.categoryIds.join(',') || undefined,
      minAmountCents: amountCents(f.minAmountText),
      maxAmountCents: amountCents(f.maxAmountText),
      isPending: f.pending === '' ? undefined : f.pending === 'yes',
      hasFinding: f.hasFinding === '' ? undefined : f.hasFinding === 'yes',
      includeInternalTransfers: f.includeInternalTransfers,
      includeExcluded: f.includeExcluded,
      q: f.q.trim() === '' ? undefined : f.q.trim(),
      sort: this.sort(),
      limit: this.pageSize(),
      offset: this.offset(),
    };
  });

  // ---------------------------------------------------------------- data ---

  /** Bumped after a write, so the page re-reads rather than patching a row it
   *  believes it knows the new state of. */
  private readonly revision = signal(0);

  protected readonly page = resource({
    params: () => ({ query: this.query(), revision: this.revision() }),
    loader: ({ params }) => this.api.listTransactions(params.query),
  });

  private readonly accountList = resource({
    params: () => this.revision(),
    loader: () => this.api.listAccounts(),
    defaultValue: [] as Account[],
  });

  private readonly merchantList = resource({
    params: () => this.revision(),
    loader: () => this.api.listMerchants(),
    defaultValue: [] as Merchant[],
  });

  private readonly categoryList = resource({
    params: () => this.revision(),
    loader: () => this.api.listCategories(),
    defaultValue: [] as Category[],
  });

  protected readonly accounts = computed(() => this.accountList.value());
  protected readonly merchants = computed(() => this.merchantList.value());
  protected readonly categories = computed(() => this.categoryList.value());

  protected readonly merchantsById = computed(
    () => new Map(this.merchants().map((merchant) => [merchant.id, merchant])),
  );
  protected readonly categoriesById = computed(
    () => new Map(this.categories().map((category) => [category.id, category])),
  );

  /**
   * `hasValue()` before `value()`, always.
   *
   * A `resource` in an error state **throws** from `value()` rather than returning
   * `undefined`, so `this.page.value()?.rows ?? []` reads correct and takes the
   * whole template down the moment the API is unreachable — which is exactly when
   * the page most needs to render something.
   */
  protected readonly rows = computed<readonly TransactionSearchRow[]>(() =>
    this.page.hasValue() ? this.page.value().rows : [],
  );
  protected readonly total = computed(() => (this.page.hasValue() ? this.page.value().total : 0));

  protected readonly rangeLabel = computed(() => {
    const total = this.total();
    if (total === 0) return 'no rows';
    const first = this.offset() + 1;
    const last = Math.min(this.offset() + this.rows().length, total);
    return `${first}–${last} of ${total}`;
  });

  protected readonly hasPrevious = computed(() => this.offset() > 0);
  protected readonly hasNext = computed(() => this.offset() + this.pageSize() < this.total());

  // ------------------------------------------------------ virtualization ---

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly detailPanel = viewChild<ElementRef<HTMLElement>>('detailPanel');

  protected readonly scrollTop = signal(0);
  protected readonly viewportHeight = signal(480);
  private readonly detailHeight = signal(ESTIMATED_DETAIL_HEIGHT);

  protected readonly expandedId = signal<string | null>(null);

  private readonly expandedIndex = computed(() => {
    const id = this.expandedId();
    return id === null ? -1 : this.rows().findIndex((row) => row.transaction.id === id);
  });

  protected readonly window = computed(() =>
    virtualWindow({
      count: this.rows().length,
      rowHeight: ROW_HEIGHT,
      viewportHeight: this.viewportHeight(),
      scrollTop: this.scrollTop(),
      expandedIndex: this.expandedIndex(),
      expandedHeight: this.detailHeight(),
    }),
  );

  protected readonly visibleRows = computed(() => {
    const { start, end } = this.window();
    return this.rows()
      .slice(start, end)
      .map((row, index) => ({ row, index: start + index }));
  });

  // --------------------------------------------------------- expander ---

  protected readonly detail = signal<TransactionDetail | null>(null);

  // --------------------------------------------------------------- edits ---

  protected readonly editing = signal<EditState | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly renormalizeJob = signal<Job | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    /**
     * Measure the two heights the window arithmetic needs.
     *
     * `afterRenderEffect`'s read phase and not `effect`: both of these are DOM
     * reads, and an `effect` runs as part of change detection — before the panel it
     * is trying to measure exists. The estimate would then be permanent, and the
     * rows below an expanded row would sit however far off it was from the
     * scrollbar.
     */
    afterRenderEffect({
      read: () => {
        const panel = this.detailPanel()?.nativeElement;
        this.detailHeight.set(panel ? panel.offsetHeight : ESTIMATED_DETAIL_HEIGHT);

        const viewport = this.viewport()?.nativeElement;
        if (viewport && viewport.clientHeight > 0) {
          this.viewportHeight.set(viewport.clientHeight);
        }
      },
    });

    // A page change scrolls the viewport back to the top. Without this, page two
    // opens mid-list at whatever offset page one was left at.
    effect(() => {
      this.offset();
      const element = this.viewport()?.nativeElement;
      if (element && element.scrollTop !== 0) element.scrollTop = 0;
      this.scrollTop.set(0);
    });
  }

  // ------------------------------------------------------------ handlers ---

  protected onFilterChange(next: TransactionFilterState): void {
    this.filter.set(next);
    this.collapse();
  }

  protected onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    this.scrollTop.set(element.scrollTop);
    this.viewportHeight.set(element.clientHeight);
  }

  protected onViewportReady(element: HTMLElement): void {
    this.viewportHeight.set(element.clientHeight);
  }

  protected setSort(next: Sort): void {
    this.sort.set(next);
  }

  /** Clicking a sortable header toggles between that column's two directions. */
  protected toggleDateSort(): void {
    this.sort.set(this.sort() === 'date_desc' ? 'date_asc' : 'date_desc');
  }

  protected toggleAmountSort(): void {
    this.sort.set(this.sort() === 'amount_desc' ? 'amount_asc' : 'amount_desc');
  }

  /** Guarded because the API rejects `limit < 1` with a 400, and a 400 here blanks
   *  the whole table — a bad value from a control is not worth that. */
  protected setPageSize(size: string): void {
    const next = Number(size);
    if (!Number.isInteger(next) || next < 1) return;
    this.pageSize.set(next);
  }

  protected nextPage(): void {
    if (!this.hasNext()) return;
    this.offset.set(this.offset() + this.pageSize());
    this.collapse();
  }

  protected previousPage(): void {
    if (!this.hasPrevious()) return;
    this.offset.set(Math.max(0, this.offset() - this.pageSize()));
    this.collapse();
  }

  /**
   * The whole row is the expander, not just the date cell.
   *
   * A row that opens when you click one of its six cells and does nothing for the
   * other five is a row you have to learn. The date cell stays a `<button>`,
   * because that is what makes the expander reachable from the keyboard and what
   * carries `aria-expanded` — this adds a mouse affordance over the rest of the
   * row rather than replacing the accessible one.
   *
   * **Interactive descendants keep their own meaning.** The merchant and category
   * cells, the transfer and excluded chips, and the date button all do something
   * specific, and a click on any of them must not also toggle the row. Testing for
   * the nearest interactive ancestor rather than listing cells to exclude is what
   * keeps that true when someone adds a seventh control: the default for a new
   * button becomes "does not also collapse the row", which is the safe direction.
   */
  protected onRowClick(id: string, event: Event): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, select, input, textarea, [contenteditable]')) return;

    void this.toggleExpanded(id);
  }

  protected async toggleExpanded(id: string): Promise<void> {
    if (this.expandedId() === id) {
      this.collapse();
      return;
    }

    this.expandedId.set(id);
    this.detail.set(null);
    this.detailHeight.set(ESTIMATED_DETAIL_HEIGHT);

    try {
      const detail = await this.api.getTransaction(id);
      // A slow fetch for a row the user has since collapsed must not reopen it.
      if (this.expandedId() === id) this.detail.set(detail);
    } catch (cause) {
      this.notice.set(`Could not load that row: ${(cause as Error).message}`);
    }
  }

  protected collapse(): void {
    this.expandedId.set(null);
    this.detail.set(null);
    this.editing.set(null);
  }

  protected startEdit(transactionId: string, kind: EditState['kind']): void {
    this.editing.set({ transactionId, kind });
    this.notice.set(null);
  }

  /**
   * A merchant edit opens inside the row's expander.
   *
   * One variable-height region per row rather than two, which is what keeps the
   * window arithmetic to a single `expandedHeight`. It also puts the descriptor and
   * the verbatim line in front of the user while they decide what the merchant
   * actually is, which is the information the decision needs.
   */
  protected async startMerchantEdit(transactionId: string): Promise<void> {
    this.editing.set({ transactionId, kind: 'merchant' });
    this.notice.set(null);
    if (this.expandedId() !== transactionId) {
      await this.toggleExpanded(transactionId);
      // `toggleExpanded` clears nothing, but a collapse-then-expand race could
      // have dropped the edit; re-assert it.
      this.editing.set({ transactionId, kind: 'merchant' });
    }
  }

  protected cancelEdit(): void {
    this.editing.set(null);
  }

  protected isEditing(transactionId: string, kind: EditState['kind']): boolean {
    const editing = this.editing();
    return editing?.transactionId === transactionId && editing.kind === kind;
  }

  /**
   * §6.3's merchant edit, both branches.
   *
   * The bulk branch sends the *same* filter the count was taken over — the
   * descriptor, everywhere — so what gets changed is what the user was shown. The
   * result reports back its own `matchCount`, and the notice quotes that rather
   * than the number on the button, because the two disagreeing is worth seeing.
   */
  protected async assignMerchant(
    row: TransactionSearchRow,
    assignment: MerchantAssignment,
  ): Promise<void> {
    const merchant = this.merchantsById().get(assignment.merchantId);
    const name = merchant?.displayName ?? assignment.merchantId;
    const descriptor = row.transaction.descriptionNormalized;

    await this.write(async () => {
      if (!assignment.applyToAll) {
        await this.api.updateTransaction(row.transaction.id, {
          merchantId: assignment.merchantId,
        });
        this.notice.set(`Assigned this row to ${name}. Re-normalize queued.`);
        await this.pollRenormalize();
        return;
      }

      const filter: BulkFilter = {
        descriptorsNormalized: [descriptor],
        includeInternalTransfers: true,
        includeExcluded: true,
      };
      const result = await this.api.applyBulk(filter, {
        merchantId: assignment.merchantId,
      });

      this.notice.set(
        `Assigned ${result.updated} ${result.updated === 1 ? 'row' : 'rows'} to ${name} ` +
          `and wrote ${result.aliasKeysWritten.length} ` +
          `${result.aliasKeysWritten.length === 1 ? 'alias' : 'aliases'}.`,
      );

      if (result.renormalizeJobId) {
        await this.pollRenormalize(result.renormalizeJobId);
      }
    });
  }

  protected async assignCategory(transactionId: string, categoryId: string): Promise<void> {
    if (categoryId === '') return;
    const name = this.categoriesById().get(categoryId)?.name ?? categoryId;

    await this.write(async () => {
      await this.api.updateTransaction(transactionId, { categoryId });
      this.notice.set(`Categorized as ${name}.`);
    });
  }

  protected async toggleInternalTransfer(row: TransactionSearchRow): Promise<void> {
    const next = !row.transaction.isInternalTransfer;
    await this.write(async () => {
      await this.api.updateTransaction(row.transaction.id, {
        isInternalTransfer: next,
      });
      this.notice.set(
        next
          ? 'Marked as an internal transfer. It leaves the default view — a transfer is not spending.'
          : 'No longer an internal transfer.',
      );
    });
  }

  protected async toggleExcluded(row: TransactionSearchRow): Promise<void> {
    const next = !row.transaction.isExcluded;
    await this.write(async () => {
      await this.api.updateTransaction(row.transaction.id, {
        isExcluded: next,
      });
      this.notice.set(
        next ? 'Excluded from analysis. It leaves the default view.' : 'Back in analysis.',
      );
    });
  }

  /**
   * One place where a write happens, so one place that closes the editor, clears
   * the busy flag, re-reads the page, and turns a failure into something the user
   * can read instead of a console entry.
   */
  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.editing.set(null);
      this.revision.update((value) => value + 1);
    } catch (cause) {
      this.notice.set(`That change did not apply: ${(cause as Error).message}`);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * §6.3: corrections "enqueue a coalesced re-normalize job (§2.7); the UI shows
   * its progress rather than blocking."
   *
   * A real loop now that §2.7's runner exists — until this was built there was
   * nothing to poll for, and the page said so rather than animating a bar that
   * could not move. It ends on a terminal state or on the attempt budget, and the
   * budget is what keeps it a poll rather than a spin: a job that stops reporting
   * leaves the last state it did report on screen, which is more use than a
   * progress bar that keeps promising.
   *
   * The page is not blocked while this runs — `write` has already re-read the
   * table and cleared `busy`. When the job finishes it re-reads once more, because
   * a re-normalize is precisely the thing that changes which merchant the rows on
   * screen belong to (§4.3).
   */
  private async pollRenormalize(jobId?: string): Promise<void> {
    if (!jobId) return;

    for (let attempt = 0; attempt < RENORMALIZE_POLL_ATTEMPTS; attempt += 1) {
      let job: Job;
      try {
        job = await this.api.getJob(jobId);
      } catch {
        this.renormalizeJob.set(null);
        return;
      }

      this.renormalizeJob.set(job);
      if (job.state === 'succeeded' || job.state === 'failed') {
        if (job.state === 'succeeded') this.revision.update((value) => value + 1);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, RENORMALIZE_POLL_INTERVAL_MS));
    }
  }

  protected dismissNotice(): void {
    this.notice.set(null);
    this.renormalizeJob.set(null);
  }

  protected merchantLabel(merchantId: string | null): string {
    if (!merchantId) return 'unresolved';
    const merchant = this.merchantsById().get(merchantId);
    return merchant?.displayName ?? merchantId;
  }

  protected isProvisional(merchantId: string | null): boolean {
    return merchantId !== null && this.merchantsById().get(merchantId)?.source === 'rule';
  }

  protected categoryLabel(categoryId: string | null): string {
    if (!categoryId) return '—';
    return this.categoriesById().get(categoryId)?.name ?? categoryId;
  }

  protected reload(): void {
    this.revision.update((value) => value + 1);
  }
}

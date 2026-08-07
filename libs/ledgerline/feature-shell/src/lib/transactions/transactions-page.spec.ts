/**
 * The page, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served: `apps/ledgerline-api`'s suite already drives the real
 * HTTP surface over real fixture bytes, and repeating that here would test the API
 * twice and the page not at all. What is worth testing here is the part the API
 * cannot see — that the filter the user is reading and the filter the bulk apply
 * sends are the same one, that the internal-transfer default is off, and that money
 * reaches the DOM formatted from cents rather than parsed from a string.
 */

// `describe`/`it`/`expect`/`vi` are globals here, not imports — `vitest` runs with
// `globals: true` and `tsconfig.spec.json` declares them. Same as
// `apps/ledgerline-ui`'s spec, and it keeps `vitest` out of this lib's manifest.
import { TestBed } from '@angular/core/testing';
import type {
  Account,
  Category,
  Job,
  ListTransactionsQuery,
  Merchant,
  Transaction,
  TransactionBulkChange,
  TransactionBulkResult,
  TransactionDetail,
  TransactionFilter,
  TransactionPage,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { TransactionsPage } from './transactions-page.js';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    accountId: 'a1',
    rawRowId: 'r1',
    postedDate: null,
    transactionDate: '2026-01-03',
    effectiveDate: '2026-01-03',
    amountCents: -1875,
    balanceCents: 248125,
    currency: 'USD',
    descriptionRaw: 'POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA',
    descriptionNormalized: 'BLUE BOTTLE COFFE',
    merchantId: 'prov-1',
    categoryId: null,
    categorySource: null,
    isPending: false,
    isInternalTransfer: false,
    transferPairId: null,
    refundPairId: null,
    isExcluded: false,
    allowsZeroAmount: false,
    dedupeKey: 'a'.repeat(64),
    dedupeKeyVersion: 'collapse_v1',
    occurrenceIndex: 0,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    displayName: 'Northgate Checking',
    institution: 'Northgate Bank',
    accountType: 'checking',
    last4: '4821',
    currency: 'USD',
    isActive: true,
    createdAt: '',
    updatedAt: '',
  },
];

const MERCHANTS: Merchant[] = [
  {
    id: 'prov-1',
    canonicalName: 'BLUE BOTTLE COFFE',
    displayName: 'BLUE BOTTLE COFFE',
    website: null,
    defaultCategoryId: null,
    isKnownSubscription: false,
    isTransferKind: false,
    overlapGroup: null,
    source: 'rule',
  },
  {
    id: 'starbucks',
    canonicalName: 'STARBUCKS',
    displayName: 'Starbucks',
    website: null,
    defaultCategoryId: null,
    isKnownSubscription: false,
    isTransferKind: false,
    overlapGroup: null,
    source: 'seed',
  },
];

const CATEGORIES: Category[] = [
  {
    id: 'dining',
    name: 'Dining & Coffee',
    parentId: null,
    kind: 'spend',
    overlapGroup: null,
  },
  {
    id: 'groceries',
    name: 'Groceries',
    parentId: null,
    kind: 'spend',
    overlapGroup: null,
  },
];

/** Records every call, so a test can assert on the query the page actually sent. */
class ApiStub {
  readonly queries: ListTransactionsQuery[] = [];
  readonly bulkCounts: TransactionFilter[] = [];
  readonly bulkApplies: {
    filter: TransactionFilter;
    change: TransactionBulkChange;
  }[] = [];
  readonly patches: { id: string; change: TransactionBulkChange }[] = [];

  rows: Transaction[] = [transaction()];
  matchCount = 3;

  listTransactions(query: ListTransactionsQuery): Promise<TransactionPage> {
    this.queries.push(query);
    return Promise.resolve({
      rows: this.rows.map((t) => ({ transaction: t, hasFinding: false })),
      total: this.rows.length,
      limit: query.limit ?? 250,
      offset: query.offset ?? 0,
    });
  }

  getTransaction(id: string): Promise<TransactionDetail> {
    return Promise.resolve({
      transaction: this.rows.find((t) => t.id === id) ?? transaction(),
      coveringImports: [],
      rawText: '01/03/2026,POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA,-18.75,2481.25,Posted',
      sources: [],
    });
  }

  updateTransaction(id: string, change: TransactionBulkChange): Promise<Transaction> {
    this.patches.push({ id, change });
    return Promise.resolve(transaction({ id, ...change } as Partial<Transaction>));
  }

  countMatching(filter: TransactionFilter): Promise<TransactionBulkResult> {
    this.bulkCounts.push(filter);
    return Promise.resolve({
      dryRun: true,
      matchCount: this.matchCount,
      updated: 0,
      aliasKeysWritten: [],
      renormalizeJobId: null,
      renormalizeJobCoalesced: false,
    });
  }

  applyBulk(
    filter: TransactionFilter,
    change: TransactionBulkChange,
  ): Promise<TransactionBulkResult> {
    this.bulkApplies.push({ filter, change });
    return Promise.resolve({
      dryRun: false,
      matchCount: this.matchCount,
      updated: this.matchCount,
      aliasKeysWritten: ['BLUE BOTTLE COFFE'],
      renormalizeJobId: 'job-1',
      renormalizeJobCoalesced: false,
    });
  }

  listAccounts(): Promise<Account[]> {
    return Promise.resolve(ACCOUNTS);
  }

  listMerchants(): Promise<Merchant[]> {
    return Promise.resolve(MERCHANTS);
  }

  listCategories(): Promise<Category[]> {
    return Promise.resolve(CATEGORIES);
  }

  getJob(): Promise<Job> {
    return Promise.resolve({
      id: 'job-1',
      kind: 'renormalize',
      state: 'queued',
      progress: 0,
      message: 're-normalizing 3 transactions',
      resultJson: null,
      finishedAt: null,
      createdAt: '',
      updatedAt: '',
    });
  }
}

describe('TransactionsPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    await TestBed.configureTestingModule({
      imports: [TransactionsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(TransactionsPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  /**
   * Guards `@metrum/ui`'s build, moved here from `apps/ledgerline-ui`.
   *
   * `@angular/build:unit-test` hardcodes `externalPackages: true`, so a bare
   * `@metrum/ui` specifier resolves through `node_modules` to that lib's `dist/`.
   * If `dist/` is ever plain `tsc` output instead of ngtsc output, `TestBed` falls
   * back to JIT-compiling `Panel` from its decorator — and JIT cannot see
   * initializer APIs, so `heading` silently stops being an input while the
   * component still renders. This is the only thing that notices.
   */
  it('binds through to the ui panel', async () => {
    const { el } = await render();

    expect(el.querySelector('ui-panel .panel__heading')?.textContent).toContain('Transactions');
  });

  it('asks for the internal-transfer default off, per §6.3', async () => {
    await render();

    expect(api.queries.at(-1)).toMatchObject({
      includeInternalTransfers: false,
      includeExcluded: false,
    });
  });

  it('formats money from integer cents and never sends a formatted string back', async () => {
    const { el } = await render();

    const amount = el.querySelector('.table__cell--amount:not(.table__sort)');
    expect(amount?.textContent?.trim()).toBe('-$18.75');
    // Nothing in the query carries a rendered amount.
    expect(JSON.stringify(api.queries)).not.toContain('$');
  });

  it('shows both the raw and the normalized descriptor', async () => {
    const { el } = await render();

    expect(el.querySelector('.table__raw')?.textContent).toContain('SQ *BLUE BOTTLE COFFE');
    expect(el.querySelector('.table__normalized')?.textContent).toContain('BLUE BOTTLE COFFE');
  });

  it('marks a provisional merchant as one worth correcting', async () => {
    const { el } = await render();

    expect(el.querySelector('.table__provisional')).not.toBeNull();
  });

  it('translates a typed amount filter into integer cents', async () => {
    const { fixture } = await render();
    const page = fixture.componentInstance as unknown as {
      onFilterChange: (f: Record<string, unknown>) => void;
      filter: () => Record<string, unknown>;
    };

    page.onFilterChange({
      ...page.filter(),
      minAmountText: '-18.75',
      maxAmountText: '0',
    });
    await fixture.whenStable();

    // -1875, not -1874.9999999999998.
    expect(api.queries.at(-1)).toMatchObject({
      minAmountCents: -1875,
      maxAmountCents: 0,
    });
  });

  it('ignores an amount that is not an unambiguous USD figure', async () => {
    const { fixture } = await render();
    const page = fixture.componentInstance as unknown as {
      onFilterChange: (f: Record<string, unknown>) => void;
      filter: () => Record<string, unknown>;
    };

    // European grouping means something different; §3.1 refuses rather than guesses.
    page.onFilterChange({ ...page.filter(), minAmountText: '1.234,56' });
    await fixture.whenStable();

    expect(api.queries.at(-1)?.minAmountCents).toBeUndefined();
  });

  it('sends the search term across raw and normalized descriptors', async () => {
    const { fixture } = await render();
    const page = fixture.componentInstance as unknown as {
      onFilterChange: (f: Record<string, unknown>) => void;
      filter: () => Record<string, unknown>;
    };

    page.onFilterChange({ ...page.filter(), q: '  BLUE BOTTLE  ' });
    await fixture.whenStable();

    expect(api.queries.at(-1)?.q).toBe('BLUE BOTTLE');
  });

  it('returns to the first page when a filter changes', async () => {
    const { fixture } = await render();
    const page = fixture.componentInstance as unknown as {
      onFilterChange: (f: Record<string, unknown>) => void;
      filter: () => Record<string, unknown>;
      offset: { set: (n: number) => void };
    };

    page.offset.set(500);
    await fixture.whenStable();
    expect(api.queries.at(-1)?.offset).toBe(500);

    page.onFilterChange({ ...page.filter(), q: 'NETFLIX' });
    await fixture.whenStable();

    // Holding offset 500 while narrowing to eleven rows shows an empty table and a
    // total that says otherwise.
    expect(api.queries.at(-1)?.offset).toBe(0);
  });

  it('expands a row into the verbatim statement line', async () => {
    const { fixture, el } = await render();

    (el.querySelector('.table__expand') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(el.querySelector('.detail__raw')?.textContent).toContain(
      'POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA,-18.75',
    );
  });

  describe('the bulk correction path (§6.3)', () => {
    it('counts over the descriptor, everywhere, before offering anything', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--merchant.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      // The count is a statement about identity, so it spans every account and
      // date and includes rows the two default filters hide.
      expect(api.bulkCounts.at(-1)).toEqual({
        descriptorsNormalized: ['BLUE BOTTLE COFFE'],
        includeInternalTransfers: true,
        includeExcluded: true,
      });
    });

    it('offers the count it was given, not one it computed', async () => {
      api.matchCount = 47;
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--merchant.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.assign__select') as HTMLSelectElement;
      select.value = 'starbucks';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      // One row is loaded; the offer says 47, because that is what the store holds.
      expect(el.querySelector('.assign__apply--bulk')?.textContent).toContain(
        'Apply to all 47 matching descriptors',
      );
    });

    it('applies over exactly the filter the count used', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--merchant.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.assign__select') as HTMLSelectElement;
      select.value = 'starbucks';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.assign__apply--bulk') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.bulkApplies).toHaveLength(1);
      expect(api.bulkApplies[0].filter).toEqual(api.bulkCounts.at(-1));
      expect(api.bulkApplies[0].change).toEqual({ merchantId: 'starbucks' });
    });

    it('reports what the API said it changed, and the queued job', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--merchant.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.assign__select') as HTMLSelectElement;
      select.value = 'starbucks';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.assign__apply--bulk') as HTMLButtonElement).click();
      await fixture.whenStable();

      const notice = el.querySelector('.notice__text')?.textContent ?? '';
      expect(notice).toContain('Assigned 3 rows to Starbucks');
      expect(notice).toContain('1 alias');
      // §6.3: the UI shows the job's progress rather than blocking.
      expect(el.querySelector('.notice__job')?.textContent).toContain('re-normalize queued');
    });

    it('applies to one row without touching the bulk endpoint', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--merchant.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.assign__select') as HTMLSelectElement;
      select.value = 'starbucks';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.assign__apply:not(.assign__apply--bulk)') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.bulkApplies).toHaveLength(0);
      expect(api.patches).toEqual([{ id: 't1', change: { merchantId: 'starbucks' } }]);
    });
  });

  describe('the other three inline edits', () => {
    it('marks an internal transfer', async () => {
      const { fixture, el } = await render();

      const chips = [...el.querySelectorAll('.chip--toggle')] as HTMLButtonElement[];
      chips.find((chip) => chip.textContent?.includes('transfer'))?.click();
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 't1', change: { isInternalTransfer: true } }]);
    });

    it('excludes a row from analysis', async () => {
      const { fixture, el } = await render();

      const chips = [...el.querySelectorAll('.chip--toggle')] as HTMLButtonElement[];
      chips.find((chip) => chip.textContent?.includes('excluded'))?.click();
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 't1', change: { isExcluded: true } }]);
    });

    it('assigns a category', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.table__cell--category.table__editable') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.table__select') as HTMLSelectElement;
      select.value = 'dining';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 't1', change: { categoryId: 'dining' } }]);
    });

    it('surfaces a failed write instead of swallowing it', async () => {
      vi.spyOn(api, 'updateTransaction').mockRejectedValue(new Error('no such merchant'));
      const { fixture, el } = await render();

      const chips = [...el.querySelectorAll('.chip--toggle')] as HTMLButtonElement[];
      chips.find((chip) => chip.textContent?.includes('transfer'))?.click();
      await fixture.whenStable();

      expect(el.querySelector('.notice__text')?.textContent).toContain('no such merchant');
    });
  });

  it('says so when nothing matches rather than showing an empty grid', async () => {
    api.rows = [];
    const { el } = await render();

    expect(el.querySelector('.table__empty')?.textContent).toContain('Nothing matches');
  });

  it('names the API and how to start it when it cannot be reached', async () => {
    vi.spyOn(api, 'listTransactions').mockRejectedValue(new Error('fetch failed'));
    const { el } = await render();

    expect(el.querySelector('.failure__text')?.textContent).toContain('127.0.0.1:4310');
    expect(el.querySelector('.failure__detail')?.textContent).toContain('fetch failed');
  });
});

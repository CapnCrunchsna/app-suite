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
  StatementImport,
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

function statementImport(overrides: Partial<StatementImport> = {}): StatementImport {
  return {
    id: 'imp-1',
    accountId: 'a1',
    sourceFilename: 'activity.csv',
    fileSha256: 'b'.repeat(64),
    fileSizeBytes: 2048,
    formatProfileId: 'fp-1',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    rowsParsed: 40,
    rowsInserted: 40,
    rowsDuplicate: 0,
    status: 'committed',
    parser: 'csv',
    parserVersion: '1',
    errorDetail: null,
    diagnosticsJson: null,
    importedAt: '2026-02-01T00:00:00.000Z',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
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
  {
    id: 'amazon',
    canonicalName: 'AMAZON',
    displayName: 'Amazon',
    website: null,
    defaultCategoryId: 'shopping',
    isKnownSubscription: false,
    isTransferKind: false,
    overlapGroup: null,
    source: 'seed',
  },
  {
    id: 'cardinal-card',
    canonicalName: 'CARDINAL CARD',
    displayName: 'Cardinal Card',
    website: null,
    defaultCategoryId: 'transfers',
    isKnownSubscription: false,
    isTransferKind: true,
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
    source: 'seed',
  },
  {
    id: 'groceries',
    name: 'Groceries',
    parentId: null,
    kind: 'spend',
    overlapGroup: null,
    source: 'seed',
  },
  {
    id: 'shopping',
    name: 'Shopping',
    parentId: null,
    kind: 'spend',
    overlapGroup: null,
    source: 'seed',
  },
  {
    id: 'transfers',
    name: 'Transfers',
    parentId: null,
    kind: 'transfer',
    overlapGroup: null,
    source: 'seed',
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

  coveringImports: StatementImport[] = [];

  getTransaction(id: string): Promise<TransactionDetail> {
    return Promise.resolve({
      transaction: this.rows.find((t) => t.id === id) ?? transaction(),
      coveringImports: this.coveringImports,
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

  /** A filename does not identify an import: two cards at one bank export the
   *  same name, and the period does not separate them when both statements cover
   *  the same month. §6.1's history has always named the account beside the
   *  filename; this list is the other place an import is named. */
  it('names the account a covering statement was filed into', async () => {
    api.coveringImports = [statementImport({ accountId: 'a1' })];
    const { fixture, el } = await render();

    (el.querySelector('.table__expand') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(el.querySelector('.detail__filename')?.textContent?.trim()).toBe('activity.csv');
    expect(el.querySelector('.detail__account')?.textContent?.trim()).toBe('Northgate Checking');
    expect(el.querySelector('.detail__period')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '2026-01-01 → 2026-01-31',
    );
  });

  describe('the whole row is the expander', () => {
    // Asserting on the expanded row rather than on the loaded detail: the row
    // opens synchronously and the verbatim line arrives from a later fetch, and
    // what this behaviour changes is which clicks open the row.
    const expanded = (el: HTMLElement) => el.querySelectorAll('.table__row--expanded').length;

    it('expands from a click anywhere that is not a control', async () => {
      const { fixture, el } = await render();

      // The description cell does nothing of its own, so it belongs to the row.
      (el.querySelector('.table__row .table__cell--desc') as HTMLElement).click();
      await fixture.whenStable();

      expect(expanded(el)).toBe(1);
    });

    it('collapses again on a second click', async () => {
      const { fixture, el } = await render();
      const cell = () => el.querySelector('.table__row .table__cell--desc') as HTMLElement;

      cell().click();
      await fixture.whenStable();
      expect(expanded(el)).toBe(1);

      cell().click();
      await fixture.whenStable();
      expect(expanded(el)).toBe(0);
    });

    it('leaves the controls inside the row doing their own job', async () => {
      // A chip that also toggled the row would make the row unusable: every edit
      // would open or close the thing being edited.
      const { fixture, el } = await render();

      const transfer = [...el.querySelectorAll<HTMLButtonElement>('.chip--toggle')].find((chip) =>
        chip.textContent?.includes('transfer'),
      ) as HTMLButtonElement;
      transfer.click();
      await fixture.whenStable();

      expect(expanded(el)).toBe(0);
    });
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

  /**
   * §9w. §2.6's spend-category signal, applied to the one row whose transfer chip
   * it is. "An amazon purchase was clearly not a transfer" — and the chip used to
   * offer itself there in exactly the tone it offers itself on a card payment.
   */
  describe('the transfer chip, where §2.6 scores against it', () => {
    const transferChip = (el: HTMLElement) =>
      [...el.querySelectorAll<HTMLButtonElement>('.chip--toggle')].find((chip) =>
        chip.textContent?.includes('transfer'),
      );

    it('dims itself on a purchase at a real merchant in a spend category', async () => {
      api.rows = [
        transaction({
          merchantId: 'amazon',
          categoryId: 'shopping',
          descriptionRaw: 'AMAZON.COM*RT4XY9SL3',
        }),
      ];
      const { el } = await render();

      const chip = transferChip(el);
      expect(chip?.classList.contains('chip--implausible')).toBe(true);
      expect(chip?.title).toContain('looks like spending at Amazon');
    });

    it('is still clickable, because §4.3 puts the user above the rule', async () => {
      api.rows = [transaction({ merchantId: 'amazon', categoryId: 'shopping' })];
      const { fixture, el } = await render();

      const chip = transferChip(el);
      expect(chip?.disabled).toBe(false);
      chip?.click();
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 't1', change: { isInternalTransfer: true } }]);
    });

    it('leaves a transfer-kind merchant alone — that is what the chip is for', async () => {
      api.rows = [
        transaction({
          merchantId: 'cardinal-card',
          categoryId: 'transfers',
          descriptionRaw: 'ONLINE PMT CARDINAL CARD XXXX9012',
        }),
      ];
      const { el } = await render();

      const chip = transferChip(el);
      expect(chip?.classList.contains('chip--implausible')).toBe(false);
      expect(chip?.title).toBe('Mark as money moving between your own accounts, not spending.');
    });

    it('says nothing about a row with no canonical merchant', async () => {
      // §2.6 requires both halves: an unresolved descriptor in a spend category
      // has no merchant to vouch that the money went to a real payee.
      api.rows = [transaction({ merchantId: null, categoryId: 'dining' })];
      const { el } = await render();

      expect(transferChip(el)?.classList.contains('chip--implausible')).toBe(false);
    });

    it('says nothing about a row with no category', async () => {
      api.rows = [transaction({ merchantId: 'starbucks', categoryId: null })];
      const { el } = await render();

      expect(transferChip(el)?.classList.contains('chip--implausible')).toBe(false);
    });

    it('drops the dimming once the row is actually marked', async () => {
      // The chip is now stating a fact rather than offering a doubtful action.
      api.rows = [
        transaction({ merchantId: 'amazon', categoryId: 'shopping', isInternalTransfer: true }),
      ];
      const { el } = await render();

      const chip = transferChip(el);
      expect(chip?.classList.contains('chip--implausible')).toBe(false);
      expect(chip?.classList.contains('chip--on')).toBe(true);
      expect(chip?.title).toContain('Click to unmark');
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

  // ------------------------------------ §6.3's bulk category offer (§9ag) ---

  /**
   * §6.3 gives "apply to all 47 matching" to merchant edits only. §9ag extends it to
   * categories, and the property worth pinning is the one where it deliberately
   * differs: **the scope is the merchant, not the descriptor.** A category is a
   * statement about what the spending is, which is true of every spelling the bank
   * ever printed for that merchant — scoping it to one would silently catch a
   * fraction of the charges and leave §5.4's modal rule looking at exactly the
   * inconsistency §9d warns about.
   */
  describe('the bulk category offer', () => {
    async function categorize(fixture: { whenStable(): Promise<unknown> }, el: HTMLElement) {
      // `button`, because the column header is a `span` carrying the same class and
      // `querySelector` would hand back the header.
      (el.querySelector('button.table__cell--category') as HTMLButtonElement).click();
      await fixture.whenStable();

      const select = el.querySelector('.table__select') as HTMLSelectElement;
      select.value = 'dining';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
    }

    it('writes the row first, then offers the rest — scoped to the merchant', async () => {
      const { el, fixture } = await render();
      await categorize(fixture, el);

      // The single row landed on its own, before any question was asked.
      expect(api.patches).toEqual([{ id: 't1', change: { categoryId: 'dining' } }]);

      // And the count is over the merchant, with the rows both default filters hide.
      expect(api.bulkCounts.at(-1)).toEqual({
        merchantIds: ['prov-1'],
        includeInternalTransfers: true,
        includeExcluded: true,
      });

      const offer = el.querySelector('ll-category-bulk-offer');
      expect(offer?.textContent).toContain('BLUE BOTTLE COFFE');
      expect(offer?.textContent).toContain('3 charges');
      expect(offer?.querySelector('.offer__apply')?.textContent).toContain('Apply to all 3');
    });

    it('applies to every charge on the second, explicit click', async () => {
      const { el, fixture } = await render();
      await categorize(fixture, el);

      (el.querySelector('.offer__apply') as HTMLButtonElement).click();
      await fixture.whenStable();

      // The filter written is the filter counted — not one rebuilt at press time.
      expect(api.bulkApplies).toEqual([
        {
          filter: {
            merchantIds: ['prov-1'],
            includeInternalTransfers: true,
            includeExcluded: true,
          },
          change: { categoryId: 'dining' },
        },
      ]);
      expect(el.querySelector('.notice__text')?.textContent).toContain('Filed 3 charges');
      expect(el.querySelector('ll-category-bulk-offer')).toBeNull();
    });

    it('writes nothing more when the offer is declined', async () => {
      const { el, fixture } = await render();
      await categorize(fixture, el);

      (el.querySelector('.offer__no') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.bulkApplies).toEqual([]);
      expect(el.querySelector('ll-category-bulk-offer')).toBeNull();
      // The row itself stays categorized — declining the rest is not an undo.
      expect(api.patches).toHaveLength(1);
    });

    /** A count of one is a dialog about nothing. */
    it('does not offer when the merchant has only this charge', async () => {
      api.matchCount = 1;
      const { el, fixture } = await render();
      await categorize(fixture, el);

      expect(api.patches).toHaveLength(1);
      expect(el.querySelector('ll-category-bulk-offer')).toBeNull();
    });

    /** A provisional row that resolved to no merchant has nothing but its spelling
     *  to group by, which is the one case where the merchant path cannot apply. */
    it('falls back to the descriptor for a row with no merchant', async () => {
      api.rows = [transaction({ merchantId: null })];
      const { el, fixture } = await render();
      await categorize(fixture, el);

      expect(api.bulkCounts.at(-1)).toEqual({
        descriptorsNormalized: ['BLUE BOTTLE COFFE'],
        includeInternalTransfers: true,
        includeExcluded: true,
      });
      expect(el.querySelector('ll-category-bulk-offer')?.textContent).toContain(
        'BLUE BOTTLE COFFE',
      );
    });

    /** The single edit already succeeded and said so. A second complaint about a
     *  count nobody asked for would bury it. */
    it('stays quiet when the count itself fails', async () => {
      vi.spyOn(api, 'countMatching').mockRejectedValue(new Error('fetch failed'));
      const { el, fixture } = await render();
      await categorize(fixture, el);

      expect(el.querySelector('ll-category-bulk-offer')).toBeNull();
      expect(el.querySelector('.notice__text')?.textContent).toContain('Categorized as');
    });

    /** Moving on answers the question. An offer left hanging over an unrelated edit
     *  is one somebody eventually presses by accident. */
    it('drops the offer when the next edit happens', async () => {
      const { el, fixture } = await render();
      await categorize(fixture, el);
      expect(el.querySelector('ll-category-bulk-offer')).not.toBeNull();

      const excluded = [...el.querySelectorAll('.chip--toggle')].find(
        (node) => node.textContent?.trim() === 'excluded',
      ) as HTMLButtonElement;
      excluded.click();
      await fixture.whenStable();

      expect(el.querySelector('ll-category-bulk-offer')).toBeNull();
    });
  });
});

/**
 * The page, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason `transactions-page.spec.ts` is:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface over real
 * fixture bytes — the merge rule, the near-duplicate pass, the zero-amount
 * refusal, the parser — and repeating that here would test the API twice and the
 * page not at all.
 *
 * What is worth testing here is the part the API cannot see: that Commit is
 * unreachable until the account has been confirmed, that a near-duplicate's
 * default arrives pre-selected and applied to nothing, that money reaches the DOM
 * formatted from cents, and that the mapper's draft leaves out the two fields
 * detection already answered.
 */

// `describe`/`it`/`expect`/`vi` are globals here, not imports — `vitest` runs with
// `globals: true` and `tsconfig.spec.json` declares them.
import { TestBed } from '@angular/core/testing';
import { LedgerlineApiError } from '@metrum/api-client';
import type {
  Account,
  CommitImportBody,
  CommitResult,
  CreateFormatProfileBody,
  DeleteImportResult,
  FormatProfile,
  FormatProfilePreview,
  ImportReview,
  NearDuplicateCandidate,
  PreviewFormatProfileBody,
  RawRow,
  ReviewRow,
  StatementImport,
  UpdateImportBody,
  UploadResult,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { ImportsPage } from './imports-page.js';

// ------------------------------------------------------------- fixtures ---

function statementImport(overrides: Partial<StatementImport> = {}): StatementImport {
  return {
    id: 'imp-1',
    accountId: null,
    sourceFilename: 'northgate-checking-2026-01.csv',
    fileSha256: 'f'.repeat(64),
    fileSizeBytes: 899,
    formatProfileId: 'northgate-checking-v1',
    periodStart: '2026-01-03',
    periodEnd: '2026-01-30',
    rowsParsed: 8,
    rowsInserted: 0,
    rowsDuplicate: 0,
    status: 'staged',
    parser: 'node-csv',
    parserVersion: '1',
    errorDetail: null,
    diagnosticsJson: null,
    importedAt: null,
    createdAt: '2026-01-31T00:00:00.000Z',
    updatedAt: '2026-01-31T00:00:00.000Z',
    ...overrides,
  };
}

function rawRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    rowIndex: 0,
    lineNumber: 5,
    rawText: '01/03/2026,POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA,-18.75,2481.25,Posted',
    transactionDate: '2026-01-03',
    postedDate: null,
    effectiveDate: '2026-01-03',
    descriptionRaw: 'POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA',
    amountCents: -1875,
    balanceCents: 248125,
    status: 'posted',
    currency: 'USD',
    parseStatus: 'ok',
    parseSource: 'csv',
    ...overrides,
  };
}

function reviewRow(
  rowIndex: number,
  disposition: ReviewRow['disposition'],
  row: Partial<RawRow> = {},
): ReviewRow {
  const built = rawRow({ rowIndex, ...row });
  return { rowIndex, rawText: built.rawText, row: built, disposition };
}

function nearDuplicate(overrides: Partial<NearDuplicateCandidate> = {}): NearDuplicateCandidate {
  return {
    rowIndex: 2,
    existingTransactionId: 'txn-9',
    existingEffectiveDate: '2026-01-28',
    existingAmountCents: -5000,
    existingDescriptionRaw: 'UBER TRIP 8XKJQ2 SAN FRANCISCO CA',
    existingIsPending: true,
    dayGap: 2,
    amountDeltaCents: 900,
    pendingToPosted: true,
    defaultResolution: 'replace',
    ...overrides,
  };
}

function review(overrides: Partial<ImportReview> = {}): ImportReview {
  return {
    import: statementImport(),
    accountSuggestion: { accountId: 'a1', reason: 'filename contains last4 4821' },
    warnings: [],
    balanceCheck: { kind: 'reconciled', order: 'ascending', rowsChecked: 8 },
    rows: [reviewRow(0, 'insert')],
    unparsedRows: [],
    plan: null,
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

const PROFILES: FormatProfile[] = [
  {
    id: 'northgate-checking-v1',
    institution: 'Northgate Bank',
    accountTypeHint: 'checking',
    headerSignature: '1c2660b0',
    headerTokens: ['date', 'description', 'amount', 'running balance', 'status'],
    hasHeader: true,
    delimiter: ',',
    skipLines: 3,
    dateFormat: 'MM/DD/YYYY',
    periodPattern: 'Statement Period:\\s*(\\S+)\\s*-\\s*(\\S+)',
    amountMode: 'single',
    signConvention: 'as_is',
    columnMap: {
      transactionDate: { by: 'header', name: 'Date' },
      description: { by: 'header', name: 'Description' },
      amount: { by: 'header', name: 'Amount' },
      balance: { by: 'header', name: 'Running Balance' },
      status: { by: 'header', name: 'Status' },
    },
    pendingValues: ['pending'],
    currency: 'USD',
    version: 1,
    source: 'seed',
  },
];

function preview(overrides: Partial<FormatProfilePreview> = {}): FormatProfilePreview {
  return {
    ok: false,
    errors: ['columnMap.description is required'],
    warnings: [],
    rows: [],
    failures: [],
    parseWarnings: [],
    balanceCheck: { kind: 'unavailable', reason: 'the draft mapping is not usable yet' },
    headerSignature: 'abc123',
    headerTokens: ['fecha', 'concepto', 'cargo', 'abono'],
    detectedDelimiter: ';',
    detectedSkipLines: 2,
    sampleRows: [{ cells: ['03/01/2026', 'SUPERMERCADO', '18,75', ''] }],
    ...overrides,
  };
}

// ------------------------------------------------------------- the stub ---

/** Records every call, so a test can assert on the request the page actually made. */
class ApiStub {
  readonly uploaded: string[][] = [];
  readonly patches: { id: string; body: UpdateImportBody }[] = [];
  readonly commits: { id: string; body: CommitImportBody }[] = [];
  readonly deletes: string[] = [];
  readonly previews: PreviewFormatProfileBody[] = [];
  readonly created: CreateFormatProfileBody[] = [];

  current: ImportReview = review();
  history: StatementImport[] = [statementImport()];
  uploadResult: UploadResult = {
    imports: [{ import: statementImport(), created: true, accountSuggestion: null }],
  };
  previewResult: FormatProfilePreview = preview();
  deleteResult: DeleteImportResult = { deletedTransactionIds: [], retainedTransactionIds: [] };

  uploadImports(files: readonly File[]): Promise<UploadResult> {
    this.uploaded.push(files.map((file) => file.name));
    return Promise.resolve(this.uploadResult);
  }

  listImports(): Promise<StatementImport[]> {
    return Promise.resolve(this.history);
  }

  getImport(): Promise<ImportReview> {
    return Promise.resolve(this.current);
  }

  updateImport(id: string, body: UpdateImportBody): Promise<ImportReview> {
    this.patches.push({ id, body });
    if (body.accountId) {
      // What the API does: an account makes the plan computable (§3.3 counts
      // rows within one account), so the next read carries one.
      this.current = {
        ...this.current,
        import: { ...this.current.import, accountId: body.accountId },
        accountSuggestion: null,
        plan: this.current.plan ?? { willInsert: 1, alreadyPresent: 0, nearDuplicates: [] },
      };
    }
    return Promise.resolve(this.current);
  }

  commitImport(id: string, body: CommitImportBody): Promise<CommitResult> {
    this.commits.push({ id, body });
    return Promise.resolve({
      importId: id,
      rowsParsed: 8,
      rowsInserted: 4,
      rowsDuplicate: 4,
      rowsMerged: 4,
      rowsSkippedAsNearDuplicate: 0,
      rowsReplaced: 0,
      refundPairsLinked: 0,
      insertedTransactionIds: [],
      alreadyCommitted: false,
    });
  }

  deleteImport(id: string): Promise<DeleteImportResult> {
    this.deletes.push(id);
    return Promise.resolve(this.deleteResult);
  }

  listAccounts(): Promise<Account[]> {
    return Promise.resolve(ACCOUNTS);
  }

  /** §4.1 step 7. Empty by default: most commits raise no question, and the
   *  callout must stay quiet then. */
  mergeCandidateCount = 0;
  getMerchantReviewQueue(): Promise<{ mergeCandidates: unknown[] }> {
    return Promise.resolve({
      mergeCandidates: Array.from({ length: this.mergeCandidateCount }, () => ({})),
    });
  }

  listFormatProfiles(): Promise<FormatProfile[]> {
    return Promise.resolve(PROFILES);
  }

  previewFormatProfile(body: PreviewFormatProfileBody): Promise<FormatProfilePreview> {
    this.previews.push(body);
    return Promise.resolve(this.previewResult);
  }

  createFormatProfile(body: CreateFormatProfileBody): Promise<FormatProfile> {
    this.created.push(body);
    return Promise.resolve({
      ...PROFILES[0],
      id: 'banco-abc123',
      institution: body.draft.institution,
    });
  }
}

// ------------------------------------------------------------ the tests ---

describe('ImportsPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    await TestBed.configureTestingModule({
      imports: [ImportsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  /** Opens the import through the history list, which is how a returning user
   *  reaches it — the dropzone path is exercised separately. */
  async function render(open = true) {
    const fixture = TestBed.createComponent(ImportsPage);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    if (open) {
      (el.querySelector('.history__name') as HTMLButtonElement).click();
      await fixture.whenStable();
    }
    return { fixture, el };
  }

  async function pick(
    el: HTMLElement,
    selector: string,
    value: string,
    fixture: { whenStable(): Promise<unknown> },
  ) {
    const select = el.querySelector(selector) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  }

  describe('the account confirmation gate (§6.1)', () => {
    it('offers no reachable Commit until the account is confirmed', async () => {
      const { el } = await render();

      const commit = el.querySelector('.commit__button') as HTMLButtonElement;
      expect(commit.disabled).toBe(true);
      expect(el.querySelector('.commit__blocked')?.textContent).toContain(
        'Commit needs the account confirmed',
      );
      // And the plan is absent, because the merge rule counts within an account.
      expect(el.querySelector('.plan__figure--pending')).not.toBeNull();
    });

    it('shows the guess and the reason it was guessed', async () => {
      const { el } = await render();

      const prompt = el.querySelector('.account__prompt')?.textContent ?? '';
      expect(prompt).toContain('Northgate Checking');
      expect(prompt).toContain('filename contains last4 4821');
    });

    it('confirms with a PATCH, and only then unlocks Commit', async () => {
      const { fixture, el } = await render();

      await pick(el, '.account__select', 'a1', fixture);

      expect(api.patches).toEqual([{ id: 'imp-1', body: { accountId: 'a1' } }]);
      expect((el.querySelector('.commit__button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not commit anything before the account exists', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.commits).toEqual([]);
    });
  });

  describe('near-duplicates (§3.3)', () => {
    beforeEach(() => {
      api.current = review({
        import: statementImport({ accountId: 'a1' }),
        accountSuggestion: null,
        rows: [reviewRow(2, 'near_duplicate', { amountCents: -5900, effectiveDate: '2026-01-30' })],
        plan: { willInsert: 1, alreadyPresent: 0, nearDuplicates: [nearDuplicate()] },
      });
    });

    it('pre-selects the default the API sent, and applies nothing', async () => {
      const { el } = await render();

      const checked = [...el.querySelectorAll<HTMLInputElement>('.near__choice input')].filter(
        (input) => input.checked,
      );
      expect(checked).toHaveLength(1);
      expect(checked[0].value).toBe('replace');
      // §3.3: "Matches are never resolved automatically."
      expect(api.commits).toEqual([]);
    });

    it('shows both rows, so the choice is made against something', async () => {
      const { el } = await render();

      const compare = el.querySelector('.near__compare')?.textContent ?? '';
      expect(compare).toContain('-$59.00');
      expect(compare).toContain('-$50.00');
      expect(compare).toContain('2026-01-28');
      expect(el.querySelector('.near__gap')?.textContent).toContain('2 days apart');
    });

    it('says why replace is the default for a pending row that posted', async () => {
      const { el } = await render();

      expect(el.querySelector('.near__why')?.textContent).toContain(
        'existing row is pending and this one is posted',
      );
    });

    it('sends the resolution the reviewer left on screen', async () => {
      const { fixture, el } = await render();

      const skip = [...el.querySelectorAll<HTMLInputElement>('.near__choice input')].find(
        (input) => input.value === 'skip',
      );
      skip?.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.commits[0].body.resolutions).toEqual([
        { rowIndex: 2, existingTransactionId: 'txn-9', resolution: 'skip' },
      ]);
    });
  });

  describe('the merge rule on screen (§3.3)', () => {
    it('summarises what is already present against what the file holds', async () => {
      api.current = review({
        import: statementImport({ accountId: 'a1', sourceFilename: 'part-b.csv' }),
        accountSuggestion: null,
        rows: [
          reviewRow(0, 'duplicate'),
          reviewRow(1, 'duplicate'),
          reviewRow(2, 'duplicate'),
          reviewRow(3, 'duplicate'),
          reviewRow(4, 'insert'),
          reviewRow(5, 'insert'),
          reviewRow(6, 'insert'),
          reviewRow(7, 'insert'),
        ],
        plan: { willInsert: 4, alreadyPresent: 4, nearDuplicates: [] },
      });
      const { el } = await render();

      expect(el.querySelector('.plan')?.textContent?.replace(/\s+/g, ' ')).toContain(
        '4 of 8 already present',
      );
      // Greyed and tagged rather than hidden: the count is only checkable if the
      // rows behind it are on screen.
      expect(el.querySelectorAll('.rows__row--duplicate')).toHaveLength(4);
      expect(el.querySelector('.tag--dupe')?.textContent).toContain('already imported');
    });
  });

  it('renders money from integer cents and never sends a formatted string back', async () => {
    const { el } = await render();

    expect(
      el.querySelector('.rows__cell--amount:not([role="columnheader"])')?.textContent?.trim(),
    ).toBe('-$18.75');
    expect(JSON.stringify([api.patches, api.commits])).not.toContain('$');
  });

  it('reveals the verbatim statement line for a row', async () => {
    const { fixture, el } = await render();

    (el.querySelector('.rows__expand') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(el.querySelector('.rows__raw')?.textContent).toContain(
      '01/03/2026,POS DEBIT SQ *BLUE BOTTLE COFFE',
    );
  });

  describe('the warning strip (§6.1)', () => {
    it('names unparsed rows, pending rows and a balance that does not reconcile', async () => {
      api.current = review({
        import: statementImport({ accountId: 'a1' }),
        accountSuggestion: null,
        rows: [reviewRow(0, 'insert'), reviewRow(1, 'insert', { status: 'pending' })],
        unparsedRows: [
          {
            id: 'r-9',
            importId: 'imp-1',
            rowIndex: 9,
            rawText: 'garbage',
            parsedJson: null,
            parseStatus: 'error',
            parseSource: 'csv',
          },
        ],
        balanceCheck: {
          kind: 'mismatch',
          order: 'ascending',
          rowsChecked: 8,
          failureCount: 1,
          failures: [{ rowIndex: 4, expectedCents: 555867, actualCents: 555222, deltaCents: -645 }],
        },
        plan: { willInsert: 2, alreadyPresent: 0, nearDuplicates: [] },
      });
      const { el } = await render();

      const strip = el.querySelector('.warnings')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(strip).toContain('1 row did not parse');
      expect(strip).toContain('1 pending row');
      expect(strip).toContain('Running balance does not reconcile on 1 of 8 rows');
      // The delta is money, so it is formatted from cents like everything else.
      expect(strip).toContain('-$6.45');
    });

    it('says the reconciliation did not run rather than staying silent', async () => {
      api.current = review({
        import: statementImport({ accountId: 'a1' }),
        accountSuggestion: null,
        balanceCheck: { kind: 'unavailable', reason: 'no balance column in this profile' },
        plan: { willInsert: 1, alreadyPresent: 0, nearDuplicates: [] },
      });
      const { el } = await render();

      // "No mismatch" and "not checked" look identical on a screen showing neither.
      expect(el.querySelector('.warnings')?.textContent).toContain(
        'no balance column in this profile',
      );
    });
  });

  describe('the $0 opt-in (§3.2)', () => {
    beforeEach(() => {
      api.current = review({
        import: statementImport({ accountId: 'a1' }),
        accountSuggestion: null,
        rows: [reviewRow(5, 'insert', { amountCents: 0 })],
        warnings: [
          { kind: 'zero_amount', message: 'row 5 parsed to $0.00', rowIndex: 5, lineNumber: 7 },
        ],
        plan: { willInsert: 1, alreadyPresent: 0, nearDuplicates: [] },
      });
    });

    it('offers the opt-in from the parse, before commit has refused anything', async () => {
      const { el } = await render();

      expect(el.querySelector('.commit__optin')?.textContent).toContain('trial authorizations');
      expect(api.commits).toEqual([]);
    });

    it('commits without the opt-in first, and carries it once ticked', async () => {
      const { fixture, el } = await render();

      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(api.commits[0].body.allowZeroAmountRows).toBe(false);

      const optin = el.querySelector('.commit__optin input') as HTMLInputElement;
      optin.checked = true;
      optin.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(api.commits[1].body.allowZeroAmountRows).toBe(true);
    });

    it('surfaces the API 422 with the rows it named', async () => {
      vi.spyOn(api, 'commitImport').mockRejectedValue(
        new LedgerlineApiError(
          422,
          {
            error: 'zero_amount_rows',
            message: 'rows 5 parsed to $0.00 and are not marked pending.',
            rowIndexes: [5],
          },
          'rows 5 parsed to $0.00 and are not marked pending.',
        ),
      );
      const { fixture, el } = await render();

      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(el.querySelector('.notice__text')?.textContent).toContain('parsed to $0.00');
      expect(el.querySelector('.commit__optin')?.textContent).toContain('(rows 5)');
    });
  });

  /**
   * §4.1 step 7's queue lives on §6.8's Settings page, and nobody goes looking
   * for a question they do not know exists. The import that created it is the
   * moment to say so.
   */
  describe('the merchant questions a commit raises (§4.1, §9p)', () => {
    async function commit(candidates: number) {
      api.mergeCandidateCount = candidates;
      api.current = review({
        import: statementImport({ accountId: 'a1' }),
        accountSuggestion: null,
        plan: { willInsert: 1, alreadyPresent: 0, nearDuplicates: [] },
      });
      const { fixture, el } = await render();
      (el.querySelector('.commit__button') as HTMLButtonElement).click();
      await fixture.whenStable();
      return el.querySelector('.notice__text')?.textContent?.replace(/\s+/g, ' ') ?? '';
    }

    it('points at the queue when the commit raised one', async () => {
      const notice = await commit(2);

      expect(notice).toContain('Committed');
      expect(notice).toContain('2 merchants may be');
      expect(notice).toContain('Settings › Merchants');
    });

    it('says nothing when it raised none', async () => {
      const notice = await commit(0);

      expect(notice).toContain('Committed');
      expect(notice).not.toContain('Settings › Merchants');
    });

    it('still reports the commit when the queue cannot be read', async () => {
      // Advisory only — a commit that worked has worked, and must not report a
      // failure because a count could not be fetched.
      vi.spyOn(api, 'getMerchantReviewQueue').mockRejectedValue(new Error('offline'));
      const notice = await commit(2);

      expect(notice).toContain('Committed');
      expect(notice).not.toContain('Settings › Merchants');
    });
  });

  it('lets a later action speak over the commit report rather than under it', async () => {
    api.current = review({
      import: statementImport({ accountId: 'a1' }),
      accountSuggestion: null,
      plan: { willInsert: 1, alreadyPresent: 0, nearDuplicates: [] },
    });
    api.deleteResult = { deletedTransactionIds: ['t1'], retainedTransactionIds: ['t2'] };
    const { fixture, el } = await render();

    (el.querySelector('.commit__button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(el.querySelector('.notice__text')?.textContent).toContain('Committed');

    // The strip renders the report *or* the notice, so a stale report would hide
    // the message the delete just produced — including its retained rows.
    [...el.querySelectorAll<HTMLButtonElement>('.history__action')]
      .find((button) => button.textContent?.trim() === 'Delete')
      ?.click();
    await fixture.whenStable();
    (el.querySelector('.history__action--danger') as HTMLButtonElement).click();
    await fixture.whenStable();

    const notice = el.querySelector('.notice__text')?.textContent ?? '';
    expect(notice).toContain('Deleted the import');
    expect(notice).not.toContain('Committed');
  });

  describe('history (§6.1)', () => {
    it('surfaces the refusal to re-parse a committed import rather than hiding the button', async () => {
      vi.spyOn(api, 'updateImport').mockRejectedValue(
        new LedgerlineApiError(
          409,
          {
            error: 'already_committed',
            message: 'a committed import cannot be re-mapped or re-parsed (spec 6.1)',
          },
          'a committed import cannot be re-mapped or re-parsed (spec 6.1)',
        ),
      );
      api.history = [statementImport({ status: 'committed', accountId: 'a1' })];
      const { fixture, el } = await render(false);

      const reparse = [...el.querySelectorAll<HTMLButtonElement>('.history__action')].find(
        (button) => button.textContent?.includes('Re-parse'),
      );
      expect(reparse?.disabled).toBe(false);

      reparse?.click();
      await fixture.whenStable();

      const notice = el.querySelector('.notice__text')?.textContent ?? '';
      expect(notice).toContain('cannot be re-mapped or re-parsed');
      expect(notice).toContain('delete the import and re-import');
    });

    it('reports the rows a delete kept, and why they survived', async () => {
      api.deleteResult = {
        deletedTransactionIds: ['t1', 't2', 't3', 't4'],
        retainedTransactionIds: ['t5', 't6', 't7', 't8'],
      };
      const { fixture, el } = await render(false);

      const remove = [...el.querySelectorAll<HTMLButtonElement>('.history__action')].find(
        (button) => button.textContent?.trim() === 'Delete',
      );
      remove?.click();
      await fixture.whenStable();

      // Two-step: nothing is destroyed on the first click.
      expect(api.deletes).toEqual([]);

      (el.querySelector('.history__action--danger') as HTMLButtonElement).click();
      await fixture.whenStable();

      const notice = el.querySelector('.notice__text')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(notice).toContain('Deleted the import and 4 rows');
      expect(notice).toContain('4 rows are still here');
      expect(notice).toContain('another overlapping import also sources them');
    });
  });

  describe('the dropzone', () => {
    it('reads a byte-identical re-upload as already imported, not as a new file', async () => {
      api.uploadResult = {
        imports: [{ import: statementImport(), created: false, accountSuggestion: null }],
      };
      const { fixture, el } = await render(false);
      const page = fixture.componentInstance as unknown as { onDropped(files: File[]): void };

      page.onDropped([new File(['a,b\n1,2\n'], 'northgate-checking-2026-01.csv')]);
      await fixture.whenStable();

      expect(api.uploaded).toEqual([['northgate-checking-2026-01.csv']]);
      expect(el.querySelector('.staged__badges')?.textContent).toContain('already imported');
    });

    it("shows the API's own refusal for a file it cannot read", async () => {
      const refusal = 'PDF ingest is not built yet (roadmap v0.4). Export the statement as CSV.';
      api.uploadResult = {
        imports: [
          {
            import: statementImport({
              status: 'failed',
              errorDetail: refusal,
              formatProfileId: null,
            }),
            created: true,
            accountSuggestion: null,
          },
        ],
      };
      const { fixture, el } = await render(false);
      const page = fixture.componentInstance as unknown as { onDropped(files: File[]): void };

      page.onDropped([new File(['%PDF-1.4'], 'statement.pdf')]);
      await fixture.whenStable();

      expect(el.querySelector('.staged__badges')?.textContent).toContain(refusal);
    });

    it('names the profile that claimed the file', async () => {
      const { fixture, el } = await render(false);
      const page = fixture.componentInstance as unknown as { onDropped(files: File[]): void };

      page.onDropped([new File(['a,b\n1,2\n'], 'northgate-checking-2026-01.csv')]);
      await fixture.whenStable();

      expect(el.querySelector('.staged__badges')?.textContent).toContain('CSV · Northgate Bank');
    });
  });

  describe('the column mapper (§6.1)', () => {
    beforeEach(() => {
      api.current = review({
        import: statementImport({
          status: 'needs_mapping',
          formatProfileId: null,
          sourceFilename: 'banco-enero.csv',
          parser: null,
          parserVersion: null,
          periodStart: null,
          periodEnd: null,
          rowsParsed: 0,
        }),
        rows: [],
        plan: null,
      });
      api.history = [api.current.import];
    });

    it('omits the delimiter and the preamble length detection already found', async () => {
      const { el } = await render();

      expect(el.querySelector('ll-column-mapper')).not.toBeNull();
      const draft = api.previews.at(-1)?.draft as unknown as Record<string, unknown>;
      // A schema default on either of these silently overrode detection — `,` over
      // a detected `;`, `0` over a detected preamble — and blamed the column names.
      expect(draft).not.toHaveProperty('delimiter');
      expect(draft).not.toHaveProperty('skipLines');
    });

    it('shows what detection found rather than asking for it', async () => {
      const { el } = await render();

      const detected =
        el.querySelector('.mapper__detected')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(detected).toContain(';');
      expect(detected).toContain('2 preamble lines');
    });

    it('keeps the grid populated while the mapping is still refused', async () => {
      const { el } = await render();

      // The route returns headers and samples on every response including a
      // refused one, which is what makes the grid usable while it is still wrong.
      expect([...el.querySelectorAll('.grid__token')].map((n) => n.textContent?.trim())).toEqual([
        'fecha',
        'concepto',
        'cargo',
        'abono',
      ]);
      expect(el.querySelector('.grid__cell')?.textContent).toContain('03/01/2026');
    });

    it('shows the validation errors verbatim rather than rewording them', async () => {
      const { el } = await render();

      expect(el.querySelector('.outcome--bad')?.textContent).toContain(
        'columnMap.description is required',
      );
    });

    it('sends the roles as a column map and refires the preview', async () => {
      const { fixture, el } = await render();
      const before = api.previews.length;

      await pick(el, '.grid__col:nth-child(2) .grid__select', 'description', fixture);

      expect(api.previews.length).toBeGreaterThan(before);
      expect(api.previews.at(-1)?.draft.columnMap).toEqual({
        description: { by: 'header', name: 'concepto' },
      });
    });

    it('derives debit_credit from the columns rather than asking for a mode', async () => {
      const { fixture, el } = await render();

      await pick(el, '.grid__col:nth-child(3) .grid__select', 'debit', fixture);

      expect(api.previews.at(-1)?.draft.amountMode).toBe('debit_credit');
    });

    it('says a decimal comma is unsupported rather than looking broken', async () => {
      api.previewResult = preview({
        failures: [
          {
            rowIndex: 0,
            lineNumber: 3,
            rawText: '03/01/2026;SUPERMERCADO;18,75;',
            errors: ['"18,75" is not an unambiguous USD amount (expected e.g. 1234.56)'],
          },
        ],
      });
      const { el } = await render();

      const note = el.querySelector('.outcome--warn')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(note).toContain('no column mapping can fix it');
      expect(note).toContain('not supported in v1');
    });

    it('saves the profile and then re-parses under it, as two calls', async () => {
      api.previewResult = preview({
        ok: true,
        errors: [],
        rows: [rawRow({ effectiveDate: '2026-01-03' })],
      });
      const { fixture, el } = await render();

      const institution = el.querySelector('.controls__input') as HTMLInputElement;
      institution.value = 'Banco Enero';
      institution.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      (el.querySelector('.mapper__save') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.created).toHaveLength(1);
      expect(api.created[0].importId).toBe('imp-1');
      expect(api.created[0].draft.institution).toBe('Banco Enero');
      // Saving deliberately does not re-parse, so the page asks for that second.
      expect(api.patches).toEqual([{ id: 'imp-1', body: { formatProfileId: 'banco-abc123' } }]);
    });

    it('refuses to save a mapping the file will not parse under', async () => {
      const { el } = await render();

      expect((el.querySelector('.mapper__save') as HTMLButtonElement).disabled).toBe(true);
      expect(el.querySelector('.mapper__blocked')?.textContent).toContain('Name the institution');
    });
  });

  it('names the API and how to start it when it cannot be reached', async () => {
    vi.spyOn(api, 'getImport').mockRejectedValue(new Error('fetch failed'));
    const { el } = await render();

    expect(el.querySelector('.failure__text')?.textContent).toContain('127.0.0.1:4310');
    expect(el.querySelector('.failure__detail')?.textContent).toContain('fetch failed');
  });
});

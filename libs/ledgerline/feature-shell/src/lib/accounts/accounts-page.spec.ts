/**
 * §6.2, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason the other three page specs
 * are: `apps/ledgerline-api`'s suite already drives the real HTTP surface, so
 * repeating it here would test the API twice and the page not at all.
 *
 * What is worth testing here is the part the API cannot see — that both halves
 * §6.2 asks for actually reach the screen (a coverage bar sourced from statement
 * periods, and a queue carrying both rows, the reasons and the dollar effect),
 * that a decision routes to the endpoint that matches it, and that the page never
 * quietly moves money without saying what it did.
 */

// `describe`/`it`/`expect`/`vi` are globals here, not imports — `vitest` runs
// with `globals: true` and `tsconfig.spec.json` declares them.
import { TestBed } from '@angular/core/testing';
import type {
  Account,
  AccountCoverage,
  AccountMergeResult,
  MergeAccountBody,
  Transaction,
  TransferLink,
  TransferProposeResult,
  UpdateAccountBody,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AccountsPage } from './accounts-page.js';

// ------------------------------------------------------------------ fixtures ---

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'checking',
    displayName: 'Northgate Checking',
    institution: 'Northgate Bank',
    accountType: 'checking',
    last4: '4821',
    currency: 'USD',
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const CARD = account({
  id: 'card',
  displayName: 'Cardinal Card',
  institution: 'Cardinal Card',
  accountType: 'credit_card',
  last4: '9012',
});

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    accountId: 'checking',
    rawRowId: 'r1',
    postedDate: null,
    transactionDate: '2026-01-25',
    effectiveDate: '2026-01-25',
    amountCents: -50_000,
    balanceCents: null,
    currency: 'USD',
    descriptionRaw: 'ONLINE PMT CARDINAL CARD XXXX9012',
    descriptionNormalized: 'ONLINE PMT CARDINAL CARD',
    merchantId: null,
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
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function link(overrides: Partial<TransferLink> = {}): TransferLink {
  return {
    id: 'link-1',
    state: 'proposed',
    kind: 'one_to_one',
    score: 4,
    reasons: [
      {
        signal: 'keyword_both_sides',
        points: 3,
        detail: 'Both descriptors read as a transfer or a card payment.',
      },
      { signal: 'close_date_gap', points: 1, detail: 'Both legs landed on the same day.' },
    ],
    debits: [transaction()],
    credit: transaction({
      id: 't2',
      accountId: 'card',
      amountCents: 50_000,
      descriptionRaw: 'PAYMENT THANK YOU - WEB',
      descriptionNormalized: 'PAYMENT THANK YOU - WEB',
    }),
    debitAccount: account(),
    creditAccount: CARD,
    amountCents: 50_000,
    spendReductionCents: 50_000,
    dayGapDays: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function coverage(overrides: Partial<AccountCoverage> = {}): AccountCoverage {
  return {
    accountId: 'checking',
    periods: [
      {
        importId: 'i1',
        sourceFilename: 'northgate-checking-2026-01.csv',
        start: '2026-01-03',
        end: '2026-01-30',
      },
    ],
    months: [
      { month: '2026-01', state: 'partial', covered: false, transactionCount: 12 },
      { month: '2026-02', state: 'missing', covered: false, transactionCount: 0 },
      { month: '2026-03', state: 'covered', covered: true, transactionCount: 9 },
    ],
    coverageStart: '2026-01-03',
    coverageEnd: '2026-03-31',
    gapMonths: ['2026-02'],
    partialMonths: ['2026-01'],
    transactionCount: 21,
    unmatchedTransferCount: 0,
    ...overrides,
  };
}

class ApiStub {
  readonly patches: { id: string; body: UpdateAccountBody }[] = [];
  readonly merges: { id: string; body: MergeAccountBody }[] = [];
  readonly confirmed: string[] = [];
  readonly rejected: string[] = [];
  scans = 0;

  accounts: Account[] = [account(), CARD];
  links: TransferLink[] = [link()];
  coverages: Record<string, AccountCoverage> = {
    checking: coverage(),
    card: coverage({ accountId: 'card', transactionCount: 8 }),
  };

  listAccounts(): Promise<Account[]> {
    return Promise.resolve(this.accounts);
  }

  getAccountCoverage(id: string): Promise<AccountCoverage> {
    return Promise.resolve(this.coverages[id] ?? coverage({ accountId: id }));
  }

  updateAccount(id: string, body: UpdateAccountBody): Promise<Account> {
    this.patches.push({ id, body });
    return Promise.resolve(account({ id, ...body }));
  }

  mergeAccount(id: string, body: MergeAccountBody): Promise<AccountMergeResult> {
    this.merges.push({ id, body });
    return Promise.resolve({
      targetAccountId: id,
      sourceAccountId: body.sourceAccountId,
      transactionsMoved: 12,
      importsMoved: 1,
      occurrencesRenumbered: 0,
      seriesMoved: 0,
      evidenceMoved: 0,
      selfLinksRemoved: 1,
    });
  }

  listTransfers(): Promise<TransferLink[]> {
    return Promise.resolve(this.links);
  }

  confirmTransfer(id: string): Promise<TransferLink> {
    this.confirmed.push(id);
    return Promise.resolve(link({ id, state: 'confirmed' }));
  }

  rejectTransfer(id: string): Promise<TransferLink> {
    this.rejected.push(id);
    return Promise.resolve(link({ id, state: 'rejected' }));
  }

  proposeTransfers(): Promise<TransferProposeResult> {
    this.scans += 1;
    return Promise.resolve({
      autoLinked: 1,
      proposed: 2,
      ignored: 5,
      inserted: 3,
      updated: 0,
      withdrawn: 1,
      flagged: 2,
      unflagged: 2,
    });
  }
}

// --------------------------------------------------------------------- tests ---

describe('AccountsPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    await TestBed.configureTestingModule({
      imports: [AccountsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(AccountsPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const click = async (
    el: HTMLElement,
    selector: string,
    fixture: { whenStable(): Promise<unknown> },
  ) => {
    (el.querySelector(selector) as HTMLButtonElement).click();
    await fixture.whenStable();
  };

  const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes(text),
    ) as HTMLButtonElement;

  // ---------------------------------------------------- the coverage bar ---

  describe('the coverage bar (§6.2, §7.2)', () => {
    it('renders one cell per month with no gaps in the strip itself', async () => {
      const { el } = await render();

      // A missing month is an empty cell, not an absent one — that is the whole
      // of "gaps are visible at a glance".
      const cells = [...el.querySelectorAll('.cell')].slice(0, 3);
      expect(cells.map((cell) => cell.getAttribute('data-month'))).toEqual([
        '2026-01',
        '2026-02',
        '2026-03',
      ]);
    });

    it('tells the three coverage states apart', async () => {
      const { el } = await render();

      const cells = [...el.querySelectorAll('.cell')].slice(0, 3);
      expect(cells.map((cell) => cell.className)).toEqual([
        'cell cell--partial',
        'cell cell--missing',
        'cell cell--covered',
      ]);
    });

    it('names the months with no statement, and what that does to findings', async () => {
      const { el } = await render();

      const warning = el.querySelector('.bar__warning')?.textContent ?? '';
      expect(warning).toContain('2026-02');
      expect(warning).toContain('as if nothing happened');
    });

    it('quotes the coverage end, which is what §5 measures liveness against', async () => {
      const { el } = await render();

      expect(el.querySelector('.bar__legend')?.textContent).toContain('2026-03-31');
    });

    it("says when a transfer's counterpart is not in the system (§2.6)", async () => {
      api.coverages['checking'] = coverage({ unmatchedTransferCount: 2 });
      const { el } = await render();

      const warnings = [...el.querySelectorAll('.bar__warning')].map((node) => node.textContent);
      expect(warnings.join(' ')).toContain('no counterpart in the system');
      expect(warnings.join(' ')).toContain('count');
    });

    it('shows the transaction count §6.2 asks for', async () => {
      const { el } = await render();

      expect(el.querySelector('.card__count')?.textContent?.trim()).toBe('21 transactions');
    });
  });

  // -------------------------------------------------- the transfer queue ---

  describe('the Possible Transfers queue (§6.2, §2.6)', () => {
    it('shows both rows of the pair, with the statement line as printed', async () => {
      const { el } = await render();

      const descriptors = [...el.querySelectorAll('.row__descriptor')].map((node) =>
        node.textContent?.trim(),
      );
      // The raw line, not the normalized key: the decision is made against what
      // the bank printed.
      expect(descriptors).toEqual(['ONLINE PMT CARDINAL CARD XXXX9012', 'PAYMENT THANK YOU - WEB']);
    });

    it("shows the score's reasons rather than the score alone", async () => {
      const { el } = await render();

      const reasons = [...el.querySelectorAll('.reason')].map((node) =>
        node.textContent?.replace(/\s+/g, ' ').trim(),
      );
      expect(reasons).toEqual([
        '+3 Both descriptors read as a transfer or a card payment.',
        '+1 Both legs landed on the same day.',
      ]);
    });

    it('states the dollar effect before the button is pressed', async () => {
      const { el } = await render();

      expect(el.querySelector('.effect')?.textContent?.replace(/\s+/g, ' ')).toContain(
        'Confirming takes $500.00 out of your spending totals',
      );
    });

    it('totals what the queue is holding back from the Findings page', async () => {
      api.links = [link(), link({ id: 'link-2', spendReductionCents: 12_500 })];
      const { el } = await render();

      // $500 + $125. Proposals only — an auto-link has already left the totals,
      // so adding it would state the outstanding difference at more than it is.
      expect(el.querySelector('.queue-head__text')?.textContent?.replace(/\s+/g, ' ')).toContain(
        '$625.00',
      );
    });

    it('excludes an auto-link from that total, because it already left', async () => {
      api.links = [link({ id: 'auto-1', state: 'auto', score: 8 })];
      const { el } = await render();

      const head = el.querySelector('.queue-head__text')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(head).toContain('Nothing is waiting on you');
      expect(head).not.toContain('$500.00');
    });

    it('lists auto-links too, so the silent half stays reviewable', async () => {
      api.links = [link({ id: 'auto-1', state: 'auto', score: 8 })];
      const { el } = await render();

      expect(el.querySelector('.pair__state')?.textContent?.trim()).toBe('Linked automatically');
      expect(el.querySelector('.effect')?.textContent?.replace(/\s+/g, ' ')).toContain(
        '$500.00 is already out of your spending totals',
      );
      // No Confirm on something already linked; Reject is the undo.
      expect(el.querySelector('.button--confirm')).toBeNull();
      expect(el.querySelector('.button--reject')?.textContent?.trim()).toBe('Not a transfer');
    });

    it('marks a partial payment as one §2.6 never links on its own authority', async () => {
      api.links = [
        link({
          kind: 'partial',
          score: 8,
          debits: [transaction({ id: 'd1', amountCents: -30_000 }), transaction({ id: 'd2', amountCents: -20_000 })],
        }),
      ];
      const { el } = await render();

      expect(el.querySelector('.pair__kind')?.textContent?.trim()).toBe('split into 2');
      // Three rows: two debits and the credit.
      expect(el.querySelectorAll('.row')).toHaveLength(3);
      expect(el.querySelector('.button--confirm')).not.toBeNull();
    });

    it('confirms through the confirm endpoint and says what moved', async () => {
      const { fixture, el } = await render();

      await click(el, '.button--confirm', fixture);

      expect(api.confirmed).toEqual(['link-1']);
      expect(api.rejected).toEqual([]);
      const notice = el.querySelector('.notice__text')?.textContent ?? '';
      expect(notice).toContain('$500.00 is out of your spending totals');
      expect(notice).toContain('Reject it to undo');
    });

    it('rejects through the delete endpoint and says nothing was ever removed', async () => {
      const { fixture, el } = await render();

      await click(el, '.button--reject', fixture);

      expect(api.rejected).toEqual(['link-1']);
      expect(api.confirmed).toEqual([]);
      expect(el.querySelector('.notice__text')?.textContent).toContain(
        'the money was never taken out of your totals',
      );
    });

    it('says the money comes back when an auto-link is rejected', async () => {
      api.links = [link({ id: 'auto-1', state: 'auto' })];
      const { fixture, el } = await render();

      await click(el, '.button--reject', fixture);

      expect(el.querySelector('.notice__text')?.textContent).toContain(
        '$500.00 counts as spending again',
      );
    });

    it('explains an empty queue rather than showing a blank panel', async () => {
      api.links = [];
      const { el } = await render();

      expect(el.querySelector('.queue__empty')?.textContent).toContain(
        'keeps counting as spending until you confirm',
      );
    });

    it('re-runs the matcher on demand and reports what it did', async () => {
      const { fixture, el } = await render();

      await click(el, '.queue-head .button', fixture);

      expect(api.scans).toBe(1);
      expect(el.querySelector('.notice__text')?.textContent).toContain(
        '1 linked automatically, 2 to review, 1 withdrawn',
      );
    });
  });

  // ------------------------------------------------- the account actions ---

  describe('§6.2’s four actions', () => {
    it('renames through PATCH', async () => {
      const { fixture, el } = await render();

      await click(el, '.action', fixture);
      const input = el.querySelector('.editor__input') as HTMLInputElement;
      input.value = 'Everyday Checking';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      buttonNamed(el, 'Save').click();
      await fixture.whenStable();

      expect(api.patches).toEqual([
        { id: 'checking', body: { displayName: 'Everyday Checking' } },
      ]);
    });

    it('does not send a rename that changes nothing', async () => {
      const { fixture, el } = await render();

      await click(el, '.action', fixture);
      buttonNamed(el, 'Save').click();
      await fixture.whenStable();

      expect(api.patches).toEqual([]);
    });

    it('sets the type, and says why that matters for matching', async () => {
      const { fixture, el } = await render();

      buttonNamed(el, 'Set type').click();
      await fixture.whenStable();
      buttonNamed(el, 'Savings').click();
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 'checking', body: { accountType: 'savings' } }]);
      // §2.6 scores a credit-card counterpart differently, so the type is not a
      // label — changing it changes what auto-links.
      expect(el.querySelector('.notice__text')?.textContent).toContain('re-run the scan');
    });

    it('archives with isActive false, and says the history stays', async () => {
      const { fixture, el } = await render();

      buttonNamed(el, 'Archive').click();
      await fixture.whenStable();

      expect(api.patches).toEqual([{ id: 'checking', body: { isActive: false } }]);
      expect(el.querySelector('.notice__text')?.textContent).toContain(
        'archiving hides the account, it does not remove the transactions',
      );
    });

    it('hides archived accounts until asked, and counts them', async () => {
      api.accounts = [account(), account({ id: 'old', displayName: 'Old Checking', isActive: false })];
      const { fixture, el } = await render();

      expect(el.querySelectorAll('ll-account-card')).toHaveLength(1);
      expect(el.querySelector('.toolbar__toggle')?.textContent?.trim()).toBe('Show 1 archived');

      await click(el, '.toolbar__toggle', fixture);
      expect(el.querySelectorAll('ll-account-card')).toHaveLength(2);
    });

    it('warns what a merge does before it does it', async () => {
      const { fixture, el } = await render();

      buttonNamed(el, 'Merge').click();
      await fixture.whenStable();

      const select = el.querySelector('.editor__input') as HTMLSelectElement;
      select.value = 'card';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      const warning = el.querySelector('.editor__warning')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(warning).toContain('Cardinal Card');
      expect(warning).toContain('Northgate Checking');
      expect(warning).toContain('There is no undo');
      // The merge has not happened just because the editor is open.
      expect(api.merges).toEqual([]);
    });

    it('merges, and reports the rows that moved and the links that stopped being transfers', async () => {
      const { fixture, el } = await render();

      buttonNamed(el, 'Merge').click();
      await fixture.whenStable();
      const select = el.querySelector('.editor__input') as HTMLSelectElement;
      select.value = 'card';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      // The editor's own submit, not the card action that opened it — both say
      // "Merge", and clicking the wrong one silently reopens the editor.
      const submit = [...el.querySelectorAll<HTMLButtonElement>('.editor--merge .action')].find(
        (button) => button.textContent?.trim() === 'Merge',
      ) as HTMLButtonElement;
      submit.click();
      await fixture.whenStable();

      expect(api.merges).toEqual([{ id: 'checking', body: { sourceAccountId: 'card' } }]);
      const notice = el.querySelector('.notice__text')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(notice).toContain('Moved 12 transactions and 1 statement');
      expect(notice).toContain('unlinked 1 transfer');
      expect(notice).toContain('delete the redundant import');
    });

    it('offers no merge target when there is only one account', async () => {
      api.accounts = [account()];
      const { el } = await render();

      expect(buttonNamed(el, 'Merge')).toBeUndefined();
    });
  });

  // ------------------------------------------------------------ failures ---

  it('names the API and how to start it when it cannot be reached', async () => {
    vi.spyOn(api, 'listAccounts').mockRejectedValue(new Error('fetch failed'));
    const { el } = await render();

    expect(el.querySelector('.failure__text')?.textContent).toContain('127.0.0.1:4310');
  });

  it('explains an empty account list rather than showing a blank one', async () => {
    api.accounts = [];
    const { el } = await render();

    expect(el.querySelector('.empty')?.textContent).toContain('No accounts yet');
  });
});

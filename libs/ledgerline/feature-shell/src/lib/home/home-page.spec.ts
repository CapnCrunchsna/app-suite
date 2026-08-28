/**
 * The front door (§9u), against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason the other seven page specs are:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface.
 *
 * What is worth pinning here is mostly about *states*, because the states are the
 * page's whole reason to exist. A fresh database must offer Import and not four
 * em-dashes; a dead API must say so rather than looking like a fresh database;
 * and the review count must be the rail's count, not a second read of the same
 * endpoint that can disagree with it.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  Account,
  AccountCoverage,
  FindingsSummary,
  MerchantReviewQueue,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { HomePage } from './home-page.js';

function account(id: string, displayName: string, last4: string | null): Account {
  return {
    id,
    displayName,
    institution: 'Chase',
    accountType: 'credit_card',
    last4,
    currency: 'USD',
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function coverage(accountId: string, gaps: string[], partials: string[]): AccountCoverage {
  return {
    accountId,
    periods: [],
    months: [],
    coverageStart: '2025-01',
    coverageEnd: '2026-08',
    gapMonths: gaps,
    partialMonths: partials,
    transactionCount: 412,
    unmatchedTransferCount: 0,
  };
}

const SUMMARY: FindingsSummary = {
  subscriptions: { activeCount: 14, lapsedCount: 2, monthlyCents: 8600, annualCents: 103_200 },
  savingsAnnualCents: 128_400,
  savingsMonthlyCents: 10_700,
  activeFindingCount: 9,
  unreviewedCount: 3,
  countsByRule: {},
  countsByBand: {},
  lastRunAt: '2026-08-26T14:03:00.000Z',
  lastRunConfigHash: 'abc12345def',
  lastRunSnapshotRows: 412,
  configHash: 'abc12345def',
};

const EMPTY_QUEUE: MerchantReviewQueue = {
  mergeCandidates: [],
  provisional: [],
  llmProposals: [],
  llmProposalsUnavailableReason: null,
};

class ApiStub {
  summary: FindingsSummary | null = SUMMARY;
  accounts: Account[] = [account('a1', 'Chase Freedom', '7261')];
  coverages = new Map<string, AccountCoverage>([['a1', coverage('a1', [], [])]]);
  queue: MerchantReviewQueue = EMPTY_QUEUE;
  failWith: Error | null = null;
  coverageReads = 0;

  getFindingsSummary(): Promise<FindingsSummary> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.summary as FindingsSummary);
  }

  listAccounts(): Promise<Account[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.accounts);
  }

  getAccountCoverage(id: string): Promise<AccountCoverage> {
    this.coverageReads += 1;
    return Promise.resolve(this.coverages.get(id) ?? coverage(id, [], []));
  }

  getMerchantReviewQueue(): Promise<MerchantReviewQueue> {
    return Promise.resolve(this.queue);
  }
}

describe('HomePage', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [provideRouter([]), { provide: LedgerlineApiService, useValue: api }],
    });
  });

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const text = (el: HTMLElement, selector: string) =>
    el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

  it('leads with §6.4’s justification figure', async () => {
    const el = await render();

    expect(text(el, '.headline__value')).toBe('$1,284.00');
    expect(text(el, '.headline__sub')).toContain('$107.00 a month');
    // The figure is the doorway to the page that explains it.
    expect(el.querySelector('.headline')?.getAttribute('href')).toBe('/findings');
  });

  it('shows the state of the data beside the money', async () => {
    const el = await render();

    const cards = [...el.querySelectorAll('.card')].map((card) => ({
      label: card.querySelector('.card__label')?.textContent?.trim(),
      value: card.querySelector('.card__value')?.textContent?.trim(),
      href: card.getAttribute('href'),
    }));

    expect(cards).toEqual([
      { label: 'Active subscriptions', value: '14', href: '/subscriptions' },
      { label: 'Waiting on you', value: '0', href: '/review' },
      { label: 'Unreviewed findings', value: '3', href: '/findings' },
      { label: 'Last analysis', value: expect.stringContaining('2026'), href: '/findings' },
    ]);
  });

  // Same holder the rail's badge reads, so the front door and the rail cannot
  // show two different numbers for the same queue.
  it('takes the review count from the shared queue', async () => {
    api.queue = {
      ...EMPTY_QUEUE,
      mergeCandidates: [
        {
          keep: {
            merchant: {
              id: 'samsclub',
              canonicalName: 'SAMSCLUB',
              displayName: 'SAMSCLUB',
              website: null,
              defaultCategoryId: null,
              isKnownSubscription: false,
              isTransferKind: false,
              overlapGroup: null,
              source: 'rule',
            },
            transactionCount: 24,
            sampleDescriptors: ['SAMSCLUB'],
          },
          merge: {
            merchant: {
              id: 'sams-club',
              canonicalName: 'SAMS CLUB',
              displayName: 'SAMS CLUB',
              website: null,
              defaultCategoryId: null,
              isKnownSubscription: false,
              isTransferKind: false,
              overlapGroup: null,
              source: 'rule',
            },
            transactionCount: 14,
            sampleDescriptors: ['SAMS CLUB'],
          },
          similarity: 0.583,
        },
      ],
    };

    const el = await render();
    const asking = el.querySelector('.card--asking');

    expect(asking?.querySelector('.card__value')?.textContent?.trim()).toBe('1');
    expect(asking?.getAttribute('href')).toBe('/review');
  });

  describe('statement coverage', () => {
    it('names the span and says when it is clean', async () => {
      const el = await render();

      expect(text(el, '.coverage__name')).toBe('Chase Freedom ••7261');
      expect(text(el, '.coverage__span')).toBe('Jan 2025 – Aug 2026');
      expect(text(el, '.coverage__clean')).toBe('no gaps');
    });

    // §5.10 and §5.11 refuse to compute over a partial month at all, so a partial
    // is the same problem as an outright gap and is counted with it.
    it('counts a partial month as a hole, like a missing one', async () => {
      api.coverages.set('a1', coverage('a1', ['2025-06'], ['2026-08']));

      const el = await render();

      expect(text(el, '.coverage__gaps')).toBe('2 incomplete months');
      expect(text(el, '.coverage__link')).toBe('See which months are missing');
    });
  });

  // §7.4: the figures above were scored under a config that no longer applies.
  it('says when the numbers were scored under stale thresholds', async () => {
    api.summary = { ...SUMMARY, lastRunConfigHash: 'oldhash' };

    const el = await render();

    expect(text(el, '.alert')).toContain('Thresholds have changed');
  });

  it('is quiet about thresholds when the run is current', async () => {
    const el = await render();

    expect(el.querySelector('.alert')).toBeNull();
  });

  describe('a database with nothing in it', () => {
    beforeEach(() => {
      api.accounts = [];
    });

    // The state the page exists for. Findings on a fresh install is three
    // em-dashes and no indication that the next move is Import.
    it('offers the only move there is', async () => {
      const el = await render();

      expect(text(el, '.cta')).toBe('Import a statement');
      expect(el.querySelector('.cta')?.getAttribute('href')).toBe('/imports');
      expect(el.querySelector('.headline')).toBeNull();
    });
  });

  // "The API is down" and "you have not imported anything" are different facts,
  // and only one of them is answered by going to Import.
  it('does not mistake a dead API for an empty database', async () => {
    api.failWith = new Error('fetch failed');

    const el = await render();

    expect(text(el, '.state--bad')).toContain('fetch failed');
    expect(el.querySelector('.cta')).toBeNull();
  });
});

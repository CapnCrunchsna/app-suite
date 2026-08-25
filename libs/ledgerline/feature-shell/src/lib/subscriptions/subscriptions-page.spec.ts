/**
 * §6.5, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason the other four page specs are:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface, so repeating it
 * here would test the API twice and the page not at all.
 *
 * What is worth testing here is the part the API cannot see — that the headline is
 * summed over the *effective* status so a manual override moves it immediately, that
 * the month strip places a subscription on the day it actually bills rather than on
 * its projected next date, that clicking the status already in force clears the
 * override rather than re-asserting it, and that a deep link from §6.4 opens a row the
 * default filter would otherwise have hidden.
 */

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { Account, Merchant, Series, SeriesPatch } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { SubscriptionsPage } from './subscriptions-page.js';

function series(overrides: Partial<Series> = {}): Series {
  const charges = overrides.charges ?? [
    { transactionId: 't1', amountCents: -1549, effectiveDate: '2025-11-05' },
    { transactionId: 't2', amountCents: -1549, effectiveDate: '2025-12-05' },
    { transactionId: 't3', amountCents: -1549, effectiveDate: '2026-01-05' },
  ];

  return {
    id: 's-netflix',
    merchantId: 'netflix',
    accountId: 'a1',
    cadenceDays: 30.44,
    cadenceLabel: 'monthly',
    cadencesPerYear: 12,
    // A magnitude, as §5.2 stores it — unlike `charges[].amountCents` above.
    amountCentsCurrent: 1549,
    amountCentsFirst: 1549,
    firstSeen: '2025-11-05',
    lastSeen: '2026-01-05',
    nextExpected: '2026-02-05',
    occurrenceCount: charges.length,
    status: 'active',
    userStatus: null,
    effectiveStatus: 'active',
    cancellationUrl: null,
    notes: null,
    regularity: 0.98,
    confidence: 0.86,
    monthlyCents: 1549,
    annualCents: 18588,
    totalPaidCents: charges.reduce((sum, c) => sum + Math.abs(c.amountCents), 0),
    priceSteps: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
    charges,
  };
}

const MERCHANTS: Merchant[] = [
  {
    id: 'netflix',
    canonicalName: 'NETFLIX',
    displayName: 'Netflix',
    website: null,
    defaultCategoryId: 'entertainment',
    isKnownSubscription: true,
    isTransferKind: false,
    overlapGroup: null,
    source: 'seed',
  },
  {
    id: 'gym',
    canonicalName: 'CITY GYM',
    displayName: 'City Gym',
    website: null,
    defaultCategoryId: null,
    isKnownSubscription: false,
    isTransferKind: false,
    overlapGroup: null,
    source: 'rule',
  },
];

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    displayName: 'Northgate Checking',
    institution: null,
    accountType: 'checking',
    last4: '4821',
    currency: 'USD',
    isActive: true,
    createdAt: '',
    updatedAt: '',
  },
];

class ApiStub {
  readonly patches: { id: string; body: SeriesPatch }[] = [];

  rows: Series[] = [series()];

  listSeries(): Promise<Series[]> {
    // The API sorts by annual cost; the stub honours that so the page is tested
    // against the order it actually receives.
    return Promise.resolve([...this.rows].sort((a, b) => b.annualCents - a.annualCents));
  }

  updateSeries(id: string, body: SeriesPatch): Promise<Series> {
    this.patches.push({ id, body });
    const current = this.rows.find((row) => row.id === id) as Series;
    const next = {
      ...current,
      ...body,
      effectiveStatus: (body.userStatus ?? current.status) as Series['effectiveStatus'],
    } as Series;
    this.rows = this.rows.map((row) => (row.id === id ? next : row));
    return Promise.resolve(next);
  }

  listMerchants(): Promise<Merchant[]> {
    return Promise.resolve(MERCHANTS);
  }

  listAccounts(): Promise<Account[]> {
    return Promise.resolve(ACCOUNTS);
  }
}

describe('SubscriptionsPage', () => {
  let api: ApiStub;

  async function setup(queryParams: Record<string, string> = {}) {
    api = new ApiStub();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SubscriptionsPage],
      providers: [
        { provide: LedgerlineApiService, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } },
        },
      ],
    }).compileComponents();
    return api;
  }

  async function render() {
    const fixture = TestBed.createComponent(SubscriptionsPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const click = async (
    el: HTMLElement,
    selector: string,
    fixture: { whenStable(): Promise<unknown> },
  ) => {
    (el.querySelector(selector) as HTMLElement).click();
    await fixture.whenStable();
  };

  const text = (el: HTMLElement, selector: string) =>
    [...el.querySelectorAll(selector)].map((n) => n.textContent?.replace(/\s+/g, ' ').trim());

  // ------------------------------------------------------------- ledger ---

  describe('the recurring ledger (§6.5)', () => {
    it('lists the row with everything §6.5 names', async () => {
      await setup();
      const { el } = await render();

      const cells = text(el, '.ledger tbody td');
      expect(cells[0]).toContain('Netflix');
      expect(cells[0]).toContain('Northgate Checking');
      // amount, cadence, next expected, first seen, paid to date, per year
      expect(cells.slice(1, 7)).toEqual([
        '$15.49',
        'monthly',
        '2026-02-05',
        '2025-11-05',
        '$46.47',
        '$185.88',
      ]);
      expect(cells[7]).toContain('active');
    });

    it('keeps the annual-cost order the API sent, cheapest-looking first (§6.5)', async () => {
      await setup();
      // $4.99/mo is $59.88/yr; a $40 quarterly is $160/yr. §6.5 is written around
      // the ledger making that comparison for you.
      api.rows = [
        series({ id: 'small', merchantId: 'netflix', annualCents: 5988, amountCentsCurrent: 499 }),
        series({ id: 'big', merchantId: 'gym', annualCents: 16000, amountCentsCurrent: 4000 }),
      ];
      const { el } = await render();

      expect(text(el, '.ledger__annual')).toEqual(['$160.00', '$59.88']);
      // §5.2 stores the amount as a magnitude, so the column needs no sign handling.
      expect(text(el, '.ledger tbody td.num')[0]).toBe('$40.00');
    });

    it('says why the ledger is empty rather than showing a blank table', async () => {
      await setup();
      api.rows = [];
      const { el } = await render();

      expect(el.querySelector('.empty')?.textContent).toContain('three charges at a steady cadence');
    });
  });

  // ----------------------------------------------------------- headline ---

  describe('the headline (§5.2, §6.5)', () => {
    it('sums over the effective status, so an override moves it at once', async () => {
      await setup();
      api.rows = [
        series({ id: 'a', annualCents: 18588 }),
        series({ id: 'b', merchantId: 'gym', annualCents: 12000 }),
      ];
      const { el, fixture } = await render();
      expect(text(el, '.headline__value')).toEqual(['2', '$25.49', '$305.88']);

      // §6.5: a manual status beats the computed one, and the total must not wait
      // for `1.5 × cadence` of silence to make §5.2 agree.
      await click(el, '.ledger tbody tr', fixture);
      const cancelled = [...el.querySelectorAll('.override__button')].find(
        (b) => b.textContent?.trim() === 'cancelled',
      ) as HTMLButtonElement;
      cancelled.click();
      await fixture.whenStable();

      expect(text(el, '.headline__value')[0]).toBe('1');
    });
  });

  // -------------------------------------------------------- month strip ---

  describe('the month strip (§6.5)', () => {
    it('places a subscription on the day it bills, not on its projected next date', async () => {
      await setup();
      // Charges land on the 5th; `nextExpected` is the 2026-02-05 projection. Both
      // agree here, so the discriminating case is a series whose projection has
      // drifted to a different day of month.
      api.rows = [
        series({
          nextExpected: '2026-02-19',
          charges: [
            { transactionId: 't1', amountCents: -1549, effectiveDate: '2025-11-05' },
            { transactionId: 't2', amountCents: -1549, effectiveDate: '2025-12-05' },
            { transactionId: 't3', amountCents: -1549, effectiveDate: '2026-01-05' },
          ],
        }),
      ];
      const { el } = await render();

      const loaded = [...el.querySelectorAll('.strip__day--loaded')];
      expect(loaded).toHaveLength(1);
      expect(loaded[0].textContent?.trim()).toBe('5');
    });

    it('leaves a cancelled subscription out — it is not next month’s cash flow', async () => {
      await setup();
      api.rows = [series({ userStatus: 'cancelled', effectiveStatus: 'cancelled' })];
      const { el } = await render();

      expect(el.querySelectorAll('.strip__day--loaded')).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ drawer ---

  describe('the detail drawer (§6.5)', () => {
    it('charts every stored charge and marks §5.5’s steps', async () => {
      await setup();
      api.rows = [
        series({
          charges: [
            { transactionId: 't1', amountCents: -899, effectiveDate: '2025-11-05' },
            { transactionId: 't2', amountCents: -1549, effectiveDate: '2025-12-05' },
            { transactionId: 't3', amountCents: -1549, effectiveDate: '2026-01-05' },
          ],
          priceSteps: [
            {
              at: '2025-12-05',
              fromCents: 899,
              toCents: 1549,
              deltaCents: 650,
              occurrencesAtNewPrice: 2,
              confirmed: true,
            },
          ],
        }),
      ];
      const { el, fixture } = await render();
      await click(el, '.ledger tbody tr', fixture);

      expect(el.querySelectorAll('.chart__dot')).toHaveLength(3);
      // One marker, on the charge that starts the step — matched by date rather
      // than re-derived from the amounts.
      expect(el.querySelectorAll('.chart__step')).toHaveLength(1);
      expect(text(el, '.steps__table tbody td').slice(0, 4)).toEqual([
        '2025-12-05',
        '$8.99',
        '$15.49',
        '+$6.50',
      ]);
    });

    it('clears the override when the status already in force is clicked again', async () => {
      await setup();
      api.rows = [series({ userStatus: 'cancelled', effectiveStatus: 'cancelled' })];
      const { el, fixture } = await render();

      // The default scope shows what is live, so a cancelled row has to be asked for.
      await click(el, '.scope__button:last-of-type', fixture);
      await click(el, '.ledger tbody tr', fixture);

      const on = el.querySelector('.override__button--on') as HTMLButtonElement;
      expect(on.textContent?.trim()).toBe('cancelled');
      on.click();
      await fixture.whenStable();

      // Null, not 'active': §6.5's fourth state is "let §5.2 decide", and it is a
      // distinct choice from asserting the computed answer by hand.
      expect(api.patches.at(-1)?.body).toEqual({ userStatus: null });
    });

    it('sends only the field that changed, and not one that did not', async () => {
      await setup();
      const { el, fixture } = await render();
      await click(el, '.ledger tbody tr', fixture);

      const input = el.querySelector('.field__input') as HTMLInputElement;
      input.value = 'https://netflix.com/cancel';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(api.patches).toHaveLength(1);
      expect(api.patches[0].body).toEqual({ cancellationUrl: 'https://netflix.com/cancel' });

      // Blurring again with nothing changed must not write.
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();
      expect(api.patches).toHaveLength(1);
    });
  });

  // --------------------------------------------------------- deep link ---

  describe('§6.4’s "Open subscription" deep link', () => {
    it('opens the series named in the query parameter', async () => {
      await setup({ series: 's-netflix' });
      const { el } = await render();

      expect(el.querySelector('.drawer__title')?.textContent?.trim()).toBe('Netflix');
      expect(el.querySelector('.ledger__row--open')).not.toBeNull();
    });

    /**
     * The case that would otherwise read as a broken link: §5.7's findings are
     * *about* series that stopped charging, and the default scope hides those.
     */
    it('shows a lapsed series the default filter would have hidden', async () => {
      await setup({ series: 's-netflix' });
      api.rows = [series({ status: 'lapsed', effectiveStatus: 'lapsed' })];
      const { el } = await render();

      expect(el.querySelectorAll('.ledger tbody tr')).toHaveLength(1);
      expect(el.querySelector('.drawer__title')?.textContent?.trim()).toBe('Netflix');
      // And it is still honestly labelled as not live.
      expect(text(el, '.ledger tbody td')[3]).toContain('not seen');
    });
  });
});

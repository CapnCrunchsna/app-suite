/**
 * §6.7's page, against a stubbed `LedgerlineApiService`.
 *
 * The API's own suite covers what a query does and what the model is allowed to see.
 * What only exists here is §6.7's *display* contract, which is three rules the page
 * can break without any API test noticing: an answer always renders its table, an
 * answer that failed validation is not shown while its table still is, and `none` is
 * a state with a link rather than an error.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LedgerlineApiError } from '@metrum/api-client';
import type { AskBody, AskResult } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { AskPage } from './ask-page.js';

function resultOf(overrides: Partial<AskResult> = {}): AskResult {
  return {
    question: 'who do I pay the most?',
    queryDescription: 'top 3 merchants from 2026-01-01 to 2026-12-31',
    queryName: 'topMerchants',
    rows: [
      { label: 'Netflix', amountCents: -2198, count: 2, date: null, transactionId: null },
      { label: 'Blue Bottle', amountCents: -640, count: 1, date: null, transactionId: null },
    ],
    rowCount: 2,
    totalCents: -2838,
    answer: 'Netflix is your largest merchant over the period.',
    withheldReason: null,
    withheldP2P: 0,
    providerId: 'ollama',
    ...overrides,
  };
}

class ApiStub {
  readonly asked: AskBody[] = [];
  next: AskResult = resultOf();
  failure: unknown = null;

  ask(body: AskBody): Promise<AskResult> {
    this.asked.push(body);
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.next);
  }
}

describe('AskPage (§6.7)', () => {
  let api: ApiStub;

  async function render() {
    api = new ApiStub();
    TestBed.configureTestingModule({
      imports: [AskPage],
      providers: [provideRouter([]), { provide: LedgerlineApiService, useValue: api }],
    });

    const fixture = TestBed.createComponent(AskPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const askWith = async (
    fixture: Awaited<ReturnType<typeof render>>['fixture'],
    el: HTMLElement,
    question: string,
  ) => {
    const input = el.querySelector('.asker__input') as HTMLInputElement;
    input.value = question;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (el.querySelector('.asker button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('asks the question the user typed', async () => {
    const { fixture, el } = await render();
    await askWith(fixture, el, 'who do I pay the most?');

    expect(api.asked).toEqual([{ question: 'who do I pay the most?' }]);
  });

  it('names the query it ran, above the answer (§6.7)', async () => {
    const { fixture, el } = await render();
    await askWith(fixture, el, 'who do I pay the most?');

    expect(el.querySelector('.ran')?.textContent).toContain('top 3 merchants');
    expect(el.querySelector('.answer')?.textContent).toContain('Netflix is your largest');
  });

  it('always renders the table behind an answer (§6.7)', async () => {
    const { fixture, el } = await render();
    await askWith(fixture, el, 'who do I pay the most?');

    // Not behind a disclosure. §6.7: "Every answer renders the underlying table or
    // chart" — the data is the answer and the prose is commentary on it.
    const cells = [...el.querySelectorAll('.table tbody td')].map((n) => n.textContent?.trim());
    expect(cells).toContain('Netflix');
    expect(cells).toContain('$21.98');
  });

  it('shows the table and the note, and no prose, when validation failed (§6.7)', async () => {
    const { fixture, el } = await render();
    api.next = resultOf({
      answer: null,
      withheldReason: 'The written answer used a figure that is not in the result ($98,765.43).',
    });
    await askWith(fixture, el, 'how much?');

    expect(el.querySelector('.answer')).toBeNull();
    expect(el.querySelector('.withheld')?.textContent).toContain('$98,765.43');
    // The table survives the prose being withheld — that is the whole point of the
    // rule, and a page that hid both would have made the check pointless.
    expect(el.querySelectorAll('.table tbody tr').length).toBe(2);
  });

  it('says what was withheld from the model, and that it stayed local (§2.4)', async () => {
    const { fixture, el } = await render();
    api.next = resultOf({ withheldP2P: 1 });
    await askWith(fixture, el, 'show me everything');

    const note = el.textContent ?? '';
    expect(note).toContain('payment to a person was');
    expect(note).toContain('never leave this machine');
  });

  it('renders `none` as a state with a link to Settings, not an error (§2.3, §6.7)', async () => {
    const { fixture, el } = await render();
    api.failure = new LedgerlineApiError(409, { error: 'llm_disabled', message: 'x' }, 'Ask needs an LLM provider… in Settings.');
    await askWith(fixture, el, 'anything');

    // §6.7: "disabled with a clear explanation and a link to Settings".
    expect(el.querySelector('.disabled__body')?.textContent).toContain('Ask needs an LLM provider');
    const link = el.querySelector('a[href="/settings"]');
    expect(link).not.toBeNull();
    // And the asker is gone — a box that cannot be used is worse than no box.
    expect(el.querySelector('.asker')).toBeNull();
  });

  it('reports an ordinary failure without disabling the page', async () => {
    const { fixture, el } = await render();
    api.failure = new LedgerlineApiError(500, { error: 'internal', message: 'x' }, 'the database is locked');
    await askWith(fixture, el, 'anything');

    expect(el.querySelector('.note--bad')?.textContent).toContain('the database is locked');
    // Still usable: this one is not a configuration state.
    expect(el.querySelector('.asker')).not.toBeNull();
  });

  it('offers examples until something has been asked', async () => {
    const { fixture, el } = await render();
    expect(el.querySelectorAll('.example').length).toBeGreaterThan(0);

    (el.querySelector('.example') as HTMLButtonElement).click();
    // `ngModel` writes to the element in a microtask, so a bare `detectChanges`
    // sees the signal updated and the input still empty.
    await fixture.whenStable();
    fixture.detectChanges();
    expect((el.querySelector('.asker__input') as HTMLInputElement).value).not.toBe('');

    await askWith(fixture, el, 'who do I pay the most?');
    expect(el.querySelectorAll('.example').length).toBe(0);
  });

  it('keeps earlier exchanges, newest first', async () => {
    const { fixture, el } = await render();
    await askWith(fixture, el, 'first question');
    api.next = resultOf({ answer: 'A different answer.' });
    await askWith(fixture, el, 'second question');

    const headings = [...el.querySelectorAll('.panel__heading')].map((n) => n.textContent?.trim());
    expect(headings).toContain('first question');
    expect(headings.indexOf('second question')).toBeLessThan(headings.indexOf('first question'));
  });
});

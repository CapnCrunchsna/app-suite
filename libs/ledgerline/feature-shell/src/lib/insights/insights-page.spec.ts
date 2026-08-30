/**
 * §6.6's page, against a stubbed `LedgerlineApiService`.
 *
 * The API's suite covers what the numbers are and which months §7.2 counts. What only
 * exists here is the *display* half of §6.6's one emphatic sentence: uncovered months
 * are rendered hatched **rather than omitted**, so a gap reads as a gap and not as a
 * drop in spending. A page that dropped them would pass every API test.
 */

import { TestBed } from '@angular/core/testing';
import type { CategoryInsight, FeesInsight, MoversInsight, RuleBackedInsight } from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { InsightsPage } from './insights-page.js';

const WINDOW = { from: '2026-01-01', to: '2026-03-31', coveredMonths: 2, uncoveredMonths: ['2026-02'] };

class ApiStub {
  categories: CategoryInsight = {
    months: [
      {
        month: '2026-01',
        covered: true,
        totalCents: -9099,
        slices: [{ category: 'Groceries', amountCents: -8000 }],
      },
      // The month with a statement that does not span it. Rows exist — that is the
      // point: `covered: false` says the month is unproven, not that it was empty.
      { month: '2026-02', covered: false, totalCents: -3000, slices: [] },
      {
        month: '2026-03',
        covered: true,
        totalCents: -13099,
        slices: [{ category: 'Groceries', amountCents: -12000 }],
      },
    ],
    categories: ['Groceries', 'Streaming'],
    window: WINDOW,
  };

  movers: MoversInsight = {
    fromMonth: '2026-01',
    toMonth: '2026-03',
    risers: [
      { category: 'Groceries', fromCents: -8000, toCents: -12000, deltaCents: 4000, percent: 50 },
    ],
    fallers: [],
    window: WINDOW,
  };

  fees: FeesInsight = { accounts: [], totalCents: 0, window: WINDOW };
  outliers: RuleBackedInsight = { rows: [], unavailableReason: null };
  smallSpend: RuleBackedInsight = { rows: [], unavailableReason: null };

  readonly queries: unknown[] = [];

  getCategoryInsight(query: unknown): Promise<CategoryInsight> {
    this.queries.push(query);
    return Promise.resolve(this.categories);
  }
  getMoversInsight(): Promise<MoversInsight> {
    return Promise.resolve(this.movers);
  }
  getFeesInsight(): Promise<FeesInsight> {
    return Promise.resolve(this.fees);
  }
  getOutlierInsight(): Promise<RuleBackedInsight> {
    return Promise.resolve(this.outliers);
  }
  getSmallSpendInsight(): Promise<RuleBackedInsight> {
    return Promise.resolve(this.smallSpend);
  }
}

describe('InsightsPage (§6.6)', () => {
  let api: ApiStub;

  async function render() {
    api = new ApiStub();
    TestBed.configureTestingModule({
      imports: [InsightsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    });

    const fixture = TestBed.createComponent(InsightsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('draws a column for every month, including the uncovered one', async () => {
    const { el } = await render();

    // §6.6: "rendered hatched rather than omitted". Two columns would be the bug.
    expect(el.querySelectorAll('.chart__col')).toHaveLength(3);
    expect([...el.querySelectorAll('.chart__label')].map((n) => n.textContent?.trim())).toEqual([
      '01',
      '02',
      '03',
    ]);
  });

  it('marks the uncovered month rather than shortening its bar', async () => {
    const { el } = await render();
    const columns = [...el.querySelectorAll('.chart__col')];

    expect(columns[1].classList.contains('chart__col--uncovered')).toBe(true);
    expect(columns[0].classList.contains('chart__col--uncovered')).toBe(false);
    expect(columns[2].classList.contains('chart__col--uncovered')).toBe(false);
  });

  /**
   * The distortion this guards against: an uncovered month holds whatever part of it
   * happened to be imported, and letting that set the axis would shrink every complete
   * month beside it — §7.2's exclusion arriving through the scale instead of the sum.
   */
  it('scales the bars against covered months only', async () => {
    api = new ApiStub();
    const { el } = await render();
    const bars = [...el.querySelectorAll('.chart__bar')] as HTMLElement[];

    // March is the tallest covered month, so it is 100%; the uncovered one is 0.
    expect(bars[2].style.height).toBe('100%');
    expect(bars[1].style.height).toBe('0%');
  });

  it('says in words that the hatched months are left out of the totals', async () => {
    const { el } = await render();

    const text = el.textContent ?? '';
    expect(text).toContain('2 fully covered months');
    expect(text).toContain('left out of every total');
    // The sentence §6.6 exists for — the reader has to know which of the two
    // explanations for a short bar applies.
    expect(text).toContain('not a month you spent nothing');
  });

  it('names the two months it compared, and they are the covered ones', async () => {
    const { el } = await render();

    expect(el.textContent).toContain('2026-01 → 2026-03');
  });

  it('explains an uncomparable range rather than showing an empty table', async () => {
    api = new ApiStub();
    TestBed.resetTestingModule();
    const stub = new ApiStub();
    stub.movers = {
      fromMonth: null,
      toMonth: null,
      risers: [],
      fallers: [],
      window: { ...WINDOW, coveredMonths: 1 },
    };
    TestBed.configureTestingModule({
      imports: [InsightsPage],
      providers: [{ provide: LedgerlineApiService, useValue: stub }],
    });
    const fixture = TestBed.createComponent(InsightsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Two fully covered months are needed',
    );
  });

  it('passes the range to the API when one is chosen', async () => {
    const { fixture, el } = await render();
    api.queries.length = 0;

    const from = el.querySelector('input[name="from"]') as HTMLInputElement;
    from.value = '2026-02-01';
    from.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.queries.at(-1)).toEqual({ from: '2026-02-01' });
  });
});

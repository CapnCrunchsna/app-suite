/**
 * §11.1's results page.
 *
 * This page has one failure mode worth more than all the others: rendering
 * `null` as `0`. `results.py` returns `None` for `hit_rate` and `avg_clv_pct`
 * when nothing has settled, in its own words because "a hit rate of zero and no
 * data yet are very different claims" — and a tile that collapses them tells a
 * reader with an empty database that they lose every bet.
 */

import { TestBed } from '@angular/core/testing';
import type { SummaryResponse } from '@metrum/edgeline-api-client';

import { ResultsPage } from './results-page';
import { EdgelineApiService } from '../../edgeline-api.service';

const EMPTY: SummaryResponse = {
  group: 'day',
  buckets: [],
  totals: { graded: 0, pnl_cents: 0, avg_clv_pct: null, hit_rate: null },
};

const POPULATED: SummaryResponse = {
  group: 'day',
  buckets: [
    {
      key: '2026-09-08T00:00:00.000Z',
      graded: 10,
      pnl_cents: 4200,
      avg_clv_pct: 1.4,
      wins: 6,
      settled: 10,
      hit_rate: 0.6,
      executed: 3,
      executed_pnl_cents: -1500,
      paper: 7,
      needs_manual: 1,
    },
  ],
  totals: {
    graded: 10,
    pnl_cents: 4200,
    avg_clv_pct: 1.4,
    wins: 6,
    settled: 10,
    hit_rate: 0.6,
  },
};

class ApiStub {
  summary: SummaryResponse = EMPTY;
  readonly queries: unknown[] = [];

  getResultsSummary(query: unknown): Promise<SummaryResponse> {
    this.queries.push(query);
    return Promise.resolve(this.summary);
  }
  getHealth() {
    return Promise.resolve({ paper_mode: true, kill_switch: false });
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [ResultsPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(ResultsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, api };
}

async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function tile(el: HTMLElement, label: string): HTMLElement {
  const found = [...el.querySelectorAll('.tile')].find((node) =>
    node.querySelector('.tile__label')?.textContent?.trim().startsWith(label),
  );
  return found as HTMLElement;
}

function clickText(el: HTMLElement, text: string) {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  (button as HTMLButtonElement).click();
}

describe('ResultsPage (§11.1, §12)', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('nothing has settled', () => {
    it('renders hit rate and CLV as no data, never as zero', async () => {
      const { el } = await render();
      expect(tile(el, 'Hit rate').querySelector('.tile__value')?.textContent?.trim()).toBe('—');
      expect(tile(el, 'Average CLV').querySelector('.tile__value')?.textContent?.trim()).toBe('—');
      expect(el.textContent).toContain('nothing has settled yet');
      expect(el.textContent).toContain('no closing lines captured yet');
      expect(el.textContent).not.toContain('0.0%');
    });

    it('renders an ungraded P&L as no data too', async () => {
      const { el } = await render();
      expect(tile(el, 'P&L').querySelector('.tile__value')?.textContent?.trim()).toBe('—');
    });

    it('explains an empty table, and says the em-dash means no data', async () => {
      const { el } = await render();
      const empty = el.querySelector('.empty')?.textContent ?? '';
      expect(empty).toContain('Nothing has been graded');
      expect(empty).toContain('no data');
    });
  });

  describe('with results', () => {
    it('scales a 0–1 hit rate into a percentage', async () => {
      const { el } = await render((api) => {
        api.summary = POPULATED;
      });
      // 0.6 is 60%. `0.6%` here would be the bug.
      expect(tile(el, 'Hit rate').querySelector('.tile__value')?.textContent?.trim()).toBe('60.0%');
      expect(el.textContent).toContain('6 of 10 settled');
    });

    it('renders money from cents, signed', async () => {
      const { el } = await render((api) => {
        api.summary = POPULATED;
      });
      expect(tile(el, 'P&L').querySelector('.tile__value')?.textContent?.trim()).toBe('+$42.00');
    });

    it('flags the P&L as hypothetical while paper mode is on', async () => {
      const { el } = await render((api) => {
        api.summary = POPULATED;
      });
      expect(tile(el, 'P&L').textContent).toContain('hypothetical');
    });

    /** §11.1's rec-vs-executed toggle. The two figures diverge on purpose: only
     *  confirmed bets moved real money. */
    it('switches the P&L and the counts between recommended and executed', async () => {
      const { fixture, el } = await render((api) => {
        api.summary = POPULATED;
      });
      expect(el.querySelector('tbody tr td:nth-child(2)')?.textContent?.trim()).toBe('10');

      clickText(el, 'Executed only');
      await settle(fixture);

      expect(tile(el, 'P&L').querySelector('.tile__value')?.textContent?.trim()).toBe('-$15.00');
      expect(el.textContent).toContain('3 confirmed as placed');
      expect(el.querySelector('tbody tr td:nth-child(2)')?.textContent?.trim()).toBe('3');
    });

    it('re-reads with the grouping the reader chose', async () => {
      const { fixture, el, api } = await render((stub) => {
        stub.summary = POPULATED;
      });
      expect(api.queries.at(-1)).toEqual({ group: 'day' });

      const select = el.querySelector('select') as HTMLSelectElement;
      select.value = 'week';
      select.dispatchEvent(new Event('change'));
      await settle(fixture);

      expect(api.queries.at(-1)).toEqual({ group: 'week' });
      expect(el.textContent).toContain('Week of');
    });
  });
});

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
      expect(el.textContent).toContain('Nothing has settled yet');
      expect(el.textContent).toContain('No closing lines captured yet');
      expect(el.textContent).not.toContain('0.0%');
    });

    it('renders an ungraded P&L as no data too', async () => {
      const { el } = await render();
      expect(tile(el, 'P&L').querySelector('.tile__value')?.textContent?.trim()).toBe('—');
    });
  });

  /**
   * §3.2's `closing_capture_mode` made a CLV either a bought closing price or
   * one derived from the last poll before kickoff — up to twelve hours old at
   * the dev cadence. The tile used to claim "against the closing line" whatever
   * the number was, which is the strongest claim this page makes resting on its
   * weakest data. §15's go-live gate reads this tile.
   */
  describe('the CLV tile names its own evidence', () => {
    const withProvenance = (
      closing: number,
      derived: number,
      avgClosing: number | null = null,
    ): SummaryResponse => ({
      ...POPULATED,
      totals: {
        ...POPULATED.totals,
        clv_from_closing: closing,
        clv_from_derived: derived,
        avg_clv_pct_closing: avgClosing,
      },
    });

    it('claims the closing line only when every figure came from one', async () => {
      const { el } = await render((api) => (api.summary = withProvenance(10, 0)));
      expect(tile(el, 'Average CLV').textContent).toContain('Against the closing line');
    });

    it('says so plainly when every figure was derived', async () => {
      const { el } = await render((api) => (api.summary = withProvenance(0, 10)));
      const text = tile(el, 'Average CLV').textContent ?? '';
      expect(text).toContain('Derived from the last price before kickoff');
      expect(text).not.toContain('Against the closing line');
    });

    it('splits the count on a mix, and shows the stronger average beside it', async () => {
      const { el } = await render((api) => (api.summary = withProvenance(3, 7, -0.5)));
      const text = tile(el, 'Average CLV').textContent ?? '';
      expect(text).toContain('3 against closing lines, 7 derived');
      // The headline is +1.40% from the mix; the evidence alone says -0.50%, and
      // a reader who cannot see both cannot tell those apart.
      expect(text).toContain('+1.40%');
      expect(text).toContain('-0.50%');
      expect(text).toContain('on closing lines alone');
    });

    it('does not show a closing-only average when there is nothing to compare', async () => {
      const { el } = await render((api) => (api.summary = withProvenance(0, 10, null)));
      expect(tile(el, 'Average CLV').textContent).not.toContain('on closing lines alone');
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

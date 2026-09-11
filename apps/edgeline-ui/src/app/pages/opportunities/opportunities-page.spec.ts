/**
 * §11.1's opportunities table.
 *
 * The polling cadence is asserted with fake timers rather than by waiting: the
 * interval is the feature (§11.1 says 15 s), and a test that slept for it would
 * be a slow test that still could not tell 15 s from 60 s.
 */

import { TestBed } from '@angular/core/testing';
import type { OpportunityRow } from '@metrum/edgeline-api-client';

import { OpportunitiesPage, POLL_INTERVAL_MS } from './opportunities-page';
import { EdgelineApiService } from '../../edgeline-api.service';

const ROW: OpportunityRow = {
  id: 'o1',
  type: 'arb',
  event_id: 'evt-1',
  market_key: 'h2h',
  legs: [
    {
      book_key: 'draftkings',
      selection: 'Orioles',
      line: null,
      price_decimal: 2.1,
      devig_prob: 0.49,
      staleness: 0.4,
      bet_first: true,
    },
    {
      book_key: 'fanduel',
      selection: 'Yankees',
      line: null,
      price_decimal: 2.05,
      devig_prob: 0.5,
      staleness: 0.1,
      bet_first: false,
    },
  ],
  edge_pct: 1.75,
  status: 'open',
  detected_at: '2026-09-08T15:00:00Z',
  closing_edge_pct: null,
};

class ApiStub {
  rows: OpportunityRow[] = [ROW];
  readonly queries: unknown[] = [];

  listOpportunities(query: unknown): Promise<OpportunityRow[]> {
    this.queries.push(query);
    return Promise.resolve(this.rows);
  }
  getHealth() {
    return Promise.resolve({ paper_mode: true, kill_switch: false });
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [OpportunitiesPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(OpportunitiesPage);
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

/** Click one of the type filter's chips by its label — `All`, `EV`, `ARB`. */
async function chooseType(
  fixture: { whenStable(): Promise<unknown>; detectChanges(): void },
  el: HTMLElement,
  label: string,
): Promise<void> {
  const option = [...el.querySelectorAll('.segmented__option')].find(
    (node) => node.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
  if (!option) throw new Error(`no type filter option labelled ${label}`);
  option.click();
  await settle(fixture);
}

describe('OpportunitiesPage (§11.1)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders both legs of an arb with decimal and American prices (§1)', async () => {
    const { el } = await render();
    const row = el.querySelector('tbody tr');
    expect(row?.textContent).toContain('draftkings');
    expect(row?.textContent).toContain('2.1');
    expect(row?.textContent).toContain('+110');
    expect(row?.textContent).toContain('1.75%');
  });

  /** §6.6: the leg more likely to move is the one you place first. Losing that
   *  marker turns a two-leg arb into a coin flip on execution order. */
  it('marks which leg to place first', async () => {
    const { el } = await render();
    const flags = [...el.querySelectorAll('.leg__flag')];
    expect(flags).toHaveLength(1);
    expect(flags[0].closest('.leg')?.textContent).toContain('draftkings');
  });

  /**
   * Caught by looking at live data rather than at a stub: the normalizer writes
   * a selection that already carries the handicap, so a row read
   * "Over 29.5  29.5  6 (+500)". The field is still rendered when the selection
   * does *not* carry it, which is why this tests both directions.
   */
  describe('the handicap is not printed twice', () => {
    it('omits the line when the selection already carries it', async () => {
      const { el } = await render((api) => {
        api.rows = [
          {
            ...ROW,
            market_key: 'totals',
            legs: [
              {
                book_key: 'betparx',
                selection: 'Over 29.5',
                line: 29.5,
                price_decimal: 6,
                devig_prob: 0.15,
                staleness: 3.26,
                bet_first: true,
              },
            ],
          },
        ];
      });
      const leg = el.querySelector('.leg')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      expect(leg).toContain('Over 29.5');
      expect(leg).not.toContain('29.5 29.5');
    });

    it('still renders a line the selection leaves out', async () => {
      const { el } = await render((api) => {
        api.rows = [
          {
            ...ROW,
            legs: [
              {
                book_key: 'betparx',
                selection: 'Baltimore Orioles',
                line: -1.5,
                price_decimal: 2.1,
                devig_prob: 0.5,
                staleness: null,
                bet_first: false,
              },
            ],
          },
        ];
      });
      expect(el.querySelector('.leg')?.textContent).toContain('-1.5');
    });
  });

  it('renders a closing edge that has not been captured as no data, not as zero', async () => {
    const { el } = await render();
    const cells = [...(el.querySelectorAll('tbody tr td') ?? [])];
    expect(cells[cells.length - 1].textContent?.trim()).toBe('—');
  });

  describe('filters', () => {
    it('sends the chosen status and type to the API, and "all" as null', async () => {
      const { fixture, el, api } = await render();
      expect(api.queries.at(-1)).toEqual({ status: null, type: null, limit: 200 });

      const status = el.querySelectorAll('select')[0] as HTMLSelectElement;
      status.value = 'alerted';
      status.dispatchEvent(new Event('change'));
      await settle(fixture);

      expect(api.queries.at(-1)).toEqual({ status: 'alerted', type: null, limit: 200 });
    });

    it('blames the filters, not the market, when a filtered view is empty', async () => {
      const { fixture, el } = await render((api) => {
        api.rows = [];
      });
      // The type filter is a segmented control, not a `<select>` — an `<option>`
      // cannot be styled per-option with any consistency, and this filter has to
      // wear the same chips the table does.
      await chooseType(fixture, el, 'ARB');

      expect(el.querySelector('.empty')?.textContent).toContain('Nothing matches these filters');
    });

    it('sends the chosen type to the API', async () => {
      const { fixture, el, api } = await render();
      await chooseType(fixture, el, 'ARB');

      expect(api.queries.at(-1)).toEqual({ status: null, type: 'arb', limit: 200 });
    });
  });

  describe('what the row actually says', () => {
    /**
     * `h2h` and `baseball_mlb:8dafff0a…` are provider keys. They were what this
     * table printed, and they tell a reader nothing about which game they are
     * being asked to bet on — which is the question the page exists to answer.
     */
    it('names the game and the market, not the provider keys', async () => {
      const { el } = await render((api) => {
        api.rows = [
          {
            ...ROW,
            event_id: 'baseball_mlb:8dafff0a',
            event: {
              sport_key: 'baseball_mlb',
              commence_time: '2026-09-11T23:10:00Z',
              home_team: 'Cleveland Guardians',
              away_team: 'Kansas City Royals',
            },
          },
        ];
      });

      const row = el.querySelector('tbody tr');
      expect(row?.textContent).toContain('Kansas City Royals @ Cleveland Guardians');
      expect(row?.textContent).toContain('Moneyline');
      expect(row?.textContent).toContain('MLB');
      expect(row?.textContent).not.toContain('h2h');
      // Still reachable — it is what you quote when asking why a row looks wrong.
      expect(el.querySelector('.event__teams')?.getAttribute('title')).toBe(
        'baseball_mlb:8dafff0a',
      );
    });

    it('says so when the fixture is gone rather than rendering a blank', async () => {
      const { el } = await render();
      expect(el.querySelector('tbody tr')?.textContent).toContain('Fixture no longer on file');
    });

    // `open`/`alerted` and `ev`/`arb` are enum values, not prose.
    it('capitalises the status and upper-cases the type', async () => {
      const { el } = await render();
      const row = el.querySelector('tbody tr');
      expect(row?.textContent).toContain('Open');
      expect(el.querySelector('.chip')?.textContent?.trim()).toBe('ARB');
    });
  });

  /**
   * The refresh used to empty the table for the length of each request, because
   * `resource` reverts to `defaultValue` whenever its params change and the
   * 15-second tick is a param. The rows vanishing collapsed the page's height and
   * the browser pinned the scroll to the top — it read as a full reload every
   * fifteen seconds.
   */
  it('keeps the rows on screen while a refresh is in flight', async () => {
    // A response that is held open, so the assertion lands while the refresh is
    // genuinely mid-flight rather than in whatever gap a timer leaves.
    let release: (rows: OpportunityRow[]) => void = () => undefined;
    const { fixture, el, api } = await render();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);

    api.listOpportunities = (query: unknown) => {
      api.queries.push(query);
      return new Promise<OpportunityRow[]>((resolve) => {
        release = resolve;
      });
    };

    // Driven through the Refresh button rather than the interval: it bumps the
    // same signal by the same path, and it is the one a reader can press.
    (
      [...el.querySelectorAll('button')].find(
        (node) => node.textContent?.trim() === 'Refresh now',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    // The request has gone out and has not come back. Before the fix this was a
    // single "nothing detected" cell, and the height it lost took the scroll
    // position with it.
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(el.querySelector('.empty')).toBeNull();

    release([ROW]);
    await settle(fixture);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  describe('the empty state', () => {
    it('says polling continues even when nothing has been detected', async () => {
      const { el } = await render((api) => {
        api.rows = [];
      });
      const empty = el.querySelector('.empty')?.textContent ?? '';
      expect(empty).toContain('Nothing has been detected');
      expect(empty).toContain('not that polling has stopped');
    });
  });

  /**
   * The interval is driven directly rather than through fake timers. Angular's
   * zoneless stability check schedules its own work on the macrotask queue, so
   * replacing the clock replaces that too and `whenStable` stops meaning
   * anything. Capturing the callback tests the same two facts — the cadence and
   * the cleanup — without pretending to be the event loop.
   */
  describe('polling (§11.1: every 15 s)', () => {
    it('polls at fifteen seconds, not at some other cadence', () => {
      expect(POLL_INTERVAL_MS).toBe(15_000);
    });

    it('registers one interval at that cadence and re-reads when it fires', async () => {
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      const registered: { ms: number; run: () => void; handle: number }[] = [];
      const cleared: number[] = [];
      let nextHandle = 1;

      Object.defineProperty(globalThis, 'setInterval', {
        configurable: true,
        value: (run: () => void, ms: number) => {
          const handle = nextHandle++;
          registered.push({ ms, run, handle });
          return handle;
        },
      });
      Object.defineProperty(globalThis, 'clearInterval', {
        configurable: true,
        value: (handle: number) => cleared.push(handle),
      });

      try {
        const { fixture, api } = await render();
        // The test runner and Angular register intervals of their own, so this
        // looks for the page's rather than asserting on the whole list.
        const ours = registered.filter((entry) => entry.ms === POLL_INTERVAL_MS);
        expect(ours).toHaveLength(1);

        const before = api.queries.length;
        ours[0].run();
        await settle(fixture);
        expect(api.queries.length).toBe(before + 1);

        // An interval that outlives its component keeps a dead page's requests
        // going — and keeps a test runner alive.
        fixture.destroy();
        expect(cleared).toContain(ours[0].handle);
      } finally {
        Object.defineProperty(globalThis, 'setInterval', {
          configurable: true,
          value: realSetInterval,
        });
        Object.defineProperty(globalThis, 'clearInterval', {
          configurable: true,
          value: realClearInterval,
        });
      }
    });
  });
});

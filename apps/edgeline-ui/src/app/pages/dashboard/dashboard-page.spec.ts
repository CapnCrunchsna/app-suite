/**
 * §11.1's dashboard, against a stubbed API.
 *
 * The tests that matter here are the ones about *silence*. Every figure on this
 * page is zero and every list is empty, and will be until the user holds a
 * sportsbook account — so the thing that can actually break is the explanation,
 * and an explanation breaks by disappearing rather than by throwing.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type {
  BankrollResponse,
  HealthResponse,
  RecommendationRow,
  Settings,
  SportsbookRow,
} from '@metrum/edgeline-api-client';

import { DashboardPage } from './dashboard-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function book(id: string, enabled: boolean): SportsbookRow {
  return { id, display_name: id, enabled, md_licensed: true, priority: 1, link_templates: {} };
}

class ApiStub {
  settings: Settings = { min_books_for_consensus: 4, paper_mode: true };
  books: SportsbookRow[] = [book('draftkings', false), book('fanduel', false)];
  recommendations: RecommendationRow[] = [];
  bankroll: BankrollResponse = { total_cents: 100000 };
  health: HealthResponse = {
    paper_mode: true,
    kill_switch: false,
    runtime: {},
    quota: [{ provider: 'the_odds_api', quota_used: 120, quota_budget: 500 }],
    sports_enabled: ['baseball_mlb'],
  };

  readonly killCalls: boolean[] = [];

  getSettings() {
    return Promise.resolve(this.settings);
  }
  listSportsbooks() {
    return Promise.resolve(this.books);
  }
  listRecommendations() {
    return Promise.resolve(this.recommendations);
  }
  getBankroll() {
    return Promise.resolve(this.bankroll);
  }
  getHealth() {
    return Promise.resolve(this.health);
  }
  engageKillSwitch() {
    this.killCalls.push(true);
    this.health = { ...this.health, kill_switch: true };
    return Promise.resolve({ kill_switch: true });
  }
  releaseKillSwitch() {
    this.killCalls.push(false);
    this.health = { ...this.health, kill_switch: false };
    return Promise.resolve({ kill_switch: false });
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [DashboardPage],
    providers: [provideRouter([]), { provide: EdgelineApiService, useValue: api }],
  });

  const fixture = TestBed.createComponent(DashboardPage);
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

describe('DashboardPage (§11.1)', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('explaining the silence', () => {
    it('names the missing sportsbooks rather than showing an unexplained zero', async () => {
      const { el } = await render();
      const text = el.textContent ?? '';
      expect(text).toContain('No sportsbook is enabled');
      expect(text).toContain('Prices are still polled');
    });

    /**
     * The floor is `min_books_for_consensus` from §3.2, not the literal 4. A
     * dashboard quoting 4 while the settings page said 6 would be teaching the
     * reader something false about their own configuration.
     */
    it('quotes the consensus floor from settings, not from a constant', async () => {
      const { el } = await render((api) => {
        api.settings = { min_books_for_consensus: 6 };
        api.books = [book('a', true), book('b', true), book('c', true)];
      });
      const text = el.textContent ?? '';
      expect(text).toContain('Arbitrage can fire; +EV cannot');
      expect(text).toContain('min_books_for_consensus = 6');
      expect(text).toContain('short of the 7');
    });

    /**
     * §6.4 measures a book against the consensus of the **other** books, so the
     * number of books that have to quote a market is one *more* than the
     * setting. Four enabled books at the default gives each of them three
     * others and the gate never opens — the dead end commit db40040 exists to
     * stop anyone rediscovering.
     */
    it('counts the other books, so the +EV floor is the setting plus one', async () => {
      const { el } = await render((api) => {
        api.settings = { min_books_for_consensus: 4 };
        api.books = [book('a', true), book('b', true), book('c', true), book('d', true)];
      });
      const text = el.textContent ?? '';
      // Four enabled at a floor of four is still blocked, not clear.
      expect(text).toContain('Arbitrage can fire; +EV cannot');
      expect(text).toContain('short of the 5');
      expect(text).toContain('5 books have to quote one market');
      expect(text).toContain('not 4');
    });

    it('says one book is not enough for either detector', async () => {
      const { el } = await render((api) => {
        api.books = [book('a', true), book('b', false)];
      });
      const text = el.textContent ?? '';
      expect(text).toContain('One book is not enough for either detector');
      // The arb floor is arithmetic, not configuration.
      expect(text).toContain('at least 2');
    });

    /**
     * The panel stays even when the count clears, because a count that clears
     * is not the same as a detection being possible: the provider still has to
     * quote those books for the market. A dashboard that fell silent at eight
     * enabled books would be the failure the panel exists to prevent.
     */
    it('keeps explaining once the count clears, without claiming all is well', async () => {
      const { el } = await render((api) => {
        api.books = [
          book('a', true),
          book('b', true),
          book('c', true),
          book('d', true),
          book('e', true),
        ];
      });
      const text = el.textContent ?? '';
      expect(text).toContain('in principle');
      expect(text).toContain('necessary, not sufficient');
      // …and the empty table then blames the thresholds, not the configuration.
      expect(text).toContain('found nothing over their thresholds');
    });

    it('never renders an empty recommendation table without a sentence', async () => {
      const { el } = await render();
      expect(el.querySelector('tbody .empty')?.textContent).toContain(
        'Nothing has been recommended today',
      );
      expect(el.textContent).toContain('not a quiet market');
    });
  });

  describe('the figures', () => {
    it('renders the bankroll from cents (§1)', async () => {
      const { el } = await render();
      expect(el.textContent).toContain('$1,000.00');
    });

    it('reads a recommendation’s stake out of the stored stake plan', async () => {
      const { el } = await render((api) => {
        api.recommendations = [
          {
            id: 'r1',
            opportunity_id: 'o1',
            stakes: { total_cents: 2500, legs: [], method: 'kelly', guardrails_applied: [] },
            paper: true,
            channel: 'log',
            sent_at: '2026-09-08T15:00:00Z',
            opportunity: {
              id: 'o1',
              type: 'ev',
              event_id: 'e1',
              market_key: 'h2h',
              legs: [],
              edge_pct: 3.25,
              status: 'alerted',
              detected_at: '2026-09-08T15:00:00Z',
            },
            result: null,
          },
        ];
      });
      const row = el.querySelector('tbody tr');
      expect(row?.textContent).toContain('$25.00');
      expect(row?.textContent).toContain('3.25%');
      expect(row?.textContent).toContain('PAPER');
      expect(row?.textContent).toContain('ungraded');
    });

    it('shows a quota bar against its budget', async () => {
      const { el } = await render();
      expect(el.textContent).toContain('120 / 500 credits');
      const fill = el.querySelector('.quota__fill') as HTMLElement;
      expect(fill.style.width).toBe('24%');
    });

    it('calls the worker stopped when the heartbeat is stale, absent when there is none', async () => {
      const never = await render();
      expect(never.el.textContent).toContain('never seen');
      expect(never.el.textContent).toContain('no heartbeat recorded');
      TestBed.resetTestingModule();

      const stale = await render((api) => {
        api.health = { ...api.health, runtime: { last_heartbeat_at: '2020-01-01T00:00:00Z' } };
      });
      expect(stale.el.textContent).toContain('stopped');
    });
  });

  describe('the KILL/RESUME button (§3.2, §16.2)', () => {
    it('kills on one press, because tightening a guardrail needs no ceremony', async () => {
      const { fixture, el, api } = await render();
      const button = el.querySelector('.kill__button') as HTMLButtonElement;
      expect(button.textContent?.trim()).toBe('KILL ALERTING');

      button.click();
      await settle(fixture);

      expect(api.killCalls).toEqual([true]);
      expect((el.querySelector('.kill__button') as HTMLElement).textContent?.trim()).toBe(
        'RESUME ALERTING',
      );
    });

    /**
     * §16.2 reserves loosening a guardrail to an explicit user action, and §12's
     * daily loss stop can be what engaged this — so the first press asks, and
     * the prompt says where to check before answering.
     */
    it('asks before resuming, and sends nothing until the second press', async () => {
      const { fixture, el, api } = await render((stub) => {
        stub.health = { ...stub.health, kill_switch: true };
      });

      (el.querySelector('.kill__button') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.killCalls).toEqual([]);
      expect(el.querySelector('.kill__confirm')?.textContent).toContain('daily loss stop');
      expect((el.querySelector('.kill__button') as HTMLElement).textContent?.trim()).toBe(
        'YES — RESUME ALERTING',
      );

      (el.querySelector('.kill__button') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.killCalls).toEqual([false]);
    });

    it('lets the reader back out of a resume', async () => {
      const { fixture, el, api } = await render((stub) => {
        stub.health = { ...stub.health, kill_switch: true };
      });

      (el.querySelector('.kill__button') as HTMLButtonElement).click();
      await settle(fixture);
      const cancel = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Cancel',
      ) as HTMLButtonElement;
      cancel.click();
      await settle(fixture);

      expect(api.killCalls).toEqual([]);
      expect(el.querySelector('.kill__confirm')).toBeNull();
    });
  });
});

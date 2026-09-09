/**
 * §11.1's recommendations history and its confirm dialog.
 *
 * Two things here are worth a test more than the table is:
 *
 * - **The dialog says what it does.** §16.1 makes "never places a bet" an
 *   architectural boundary, and a button labelled near a stake field is exactly
 *   where a reader would assume otherwise.
 * - **A missing deep link is words, not an anchor.** Every leg carries
 *   `deep_link: ""` today (§16.3, T4.3), and a blank `<a>` looks tappable, does
 *   nothing, and reads as a bug in the app rather than a fact about the data.
 */

import { TestBed } from '@angular/core/testing';
import type { BetRow, ConfirmBody, RecommendationRow } from '@metrum/edgeline-api-client';

import { RecommendationsPage } from './recommendations-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function recommendation(overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    id: 'r1',
    opportunity_id: 'o1',
    stakes: {
      total_cents: 2500,
      method: 'kelly',
      guardrails_applied: ['max_stake_pct'],
      legs: [
        {
          book_key: 'draftkings',
          selection: 'Orioles',
          stake_cents: 2500,
          to_win_cents: 2750,
          // Today's reality for every book: no verified template (T4.3).
          deep_link: '',
          link_level: 'none',
        },
      ],
    },
    paper: true,
    channel: 'log',
    sent_at: '2026-09-08T15:00:00Z',
    opportunity: {
      id: 'o1',
      type: 'ev',
      event_id: 'evt-1',
      market_key: 'h2h',
      legs: [
        {
          book_key: 'draftkings',
          selection: 'Orioles',
          line: null,
          price_decimal: 2.1,
          devig_prob: 0.5,
          staleness: null,
          bet_first: false,
        },
      ],
      edge_pct: 3.4,
      status: 'alerted',
      detected_at: '2026-09-08T14:59:00Z',
    },
    result: null,
    ...overrides,
  };
}

class ApiStub {
  rows: RecommendationRow[] = [recommendation()];
  readonly queries: unknown[] = [];
  readonly confirms: { id: string; body: ConfirmBody }[] = [];

  listRecommendations(query: unknown): Promise<RecommendationRow[]> {
    this.queries.push(query);
    return Promise.resolve(this.rows);
  }
  confirmRecommendation(id: string, body: ConfirmBody): Promise<BetRow> {
    this.confirms.push({ id, body });
    return Promise.resolve({
      id: 'b1',
      recommendation_id: id,
      confirmed_via: 'ui',
      stake_actual_cents: body.stake_actual_cents,
      odds_actual_decimal: body.odds_actual_decimal,
      placed_at: '2026-09-08T15:10:00Z',
    });
  }
  getHealth() {
    return Promise.resolve({ paper_mode: true, kill_switch: false });
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [RecommendationsPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(RecommendationsPage);
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

function clickText(el: HTMLElement, text: string) {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  (button as HTMLButtonElement).click();
}

describe('RecommendationsPage (§11.1)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reads the stake plan out of the stored blob, cents and all (§1, §5)', async () => {
    const { el } = await render();
    const row = el.querySelector('tbody tr');
    expect(row?.textContent).toContain('$25.00');
    expect(row?.textContent).toContain('kelly');
    expect(row?.textContent).toContain('capped by max_stake_pct');
    expect(row?.textContent).toContain('PAPER');
  });

  describe('deep links (§16.3)', () => {
    it('renders a missing link as words, never as a dead anchor', async () => {
      const { el } = await render();
      expect(el.querySelector('.no-link')?.textContent).toContain('open the book yourself');
      expect(el.querySelector('tbody a[href=""]')).toBeNull();
      expect(el.querySelector('.leg__link')).toBeNull();
    });

    it('renders a verified link when a book finally has one', async () => {
      const { el } = await render((api) => {
        api.rows = [
          recommendation({
            stakes: {
              total_cents: 2500,
              method: 'kelly',
              guardrails_applied: [],
              legs: [
                {
                  book_key: 'draftkings',
                  selection: 'Orioles',
                  stake_cents: 2500,
                  to_win_cents: 2750,
                  deep_link: 'https://sportsbook.example.com/event/123',
                  link_level: 'event',
                },
              ],
            },
          }),
        ];
      });
      const link = el.querySelector('.leg__link') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('https://sportsbook.example.com/event/123');
      expect(link.textContent).toContain('event');
    });
  });

  describe('results on a row (§12)', () => {
    it('keeps "no closing line" apart from a CLV of zero', async () => {
      const { el } = await render((api) => {
        api.rows = [
          recommendation({
            result: {
              bet_id: '',
              outcome: 'win',
              pnl_cents: 2750,
              clv_pct: null,
              needs_manual: false,
              graded_at: '2026-09-09T06:00:00Z',
            },
          }),
        ];
      });
      const row = el.querySelector('tbody tr');
      expect(row?.textContent).toContain('win +$27.50');
      expect(row?.textContent).toContain('not captured');
      expect(row?.textContent).not.toContain('CLV +0.00%');
    });
  });

  describe('the confirm dialog (§9.3, §16.1)', () => {
    it('says the bet was placed by the reader, not by Edgeline', async () => {
      const { fixture, el } = await render();
      clickText(el, 'Confirm bet');
      await settle(fixture);

      const dialog = el.querySelector('.dialog')?.textContent ?? '';
      expect(dialog).toContain('records a bet you have already placed');
      expect(dialog).toContain('does not place bets and cannot');
    });

    it('prefills what was recommended and sends what was actually got', async () => {
      const { fixture, el, api } = await render();
      clickText(el, 'Confirm bet');
      await settle(fixture);

      const inputs = el.querySelectorAll('.dialog input[type="number"]');
      const stake = inputs[0] as HTMLInputElement;
      const odds = inputs[1] as HTMLInputElement;
      expect(stake.value).toBe('25');
      expect(odds.value).toBe('2.1');

      // The line moved between the alert and the tap — which is the whole
      // reason these fields are editable.
      stake.value = '20';
      stake.dispatchEvent(new Event('input'));
      odds.value = '2.05';
      odds.dispatchEvent(new Event('input'));
      await settle(fixture);

      clickText(el, 'Record this bet');
      await settle(fixture);

      expect(api.confirms).toEqual([
        { id: 'r1', body: { stake_actual_cents: 2000, odds_actual_decimal: 2.05 } },
      ]);
    });

    it('refuses odds that are not odds', async () => {
      const { fixture, el, api } = await render();
      clickText(el, 'Confirm bet');
      await settle(fixture);

      const odds = el.querySelectorAll('.dialog input[type="number"]')[1] as HTMLInputElement;
      odds.value = '1';
      odds.dispatchEvent(new Event('input'));
      await settle(fixture);

      const record = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Record this bet',
      ) as HTMLButtonElement;
      expect(record.disabled).toBe(true);
      expect(api.confirms).toEqual([]);
    });

    it('does not offer to confirm a bet already recorded', async () => {
      const { el } = await render((api) => {
        api.rows = [
          recommendation({
            result: {
              bet_id: 'b9',
              outcome: 'loss',
              pnl_cents: -2500,
              clv_pct: -1.2,
              needs_manual: false,
              graded_at: '2026-09-09T06:00:00Z',
            },
          }),
        ];
      });
      expect(
        [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Confirm bet'),
      ).toBe(false);
      expect(el.textContent).toContain('confirmed');
    });
  });

  describe('filters and the empty state', () => {
    it('turns the mode filter into the API’s boolean', async () => {
      const { fixture, el, api } = await render();
      expect(api.queries.at(-1)).toEqual({ paper: null, from: null, to: null, limit: 200 });

      const mode = el.querySelector('select') as HTMLSelectElement;
      mode.value = 'executed';
      mode.dispatchEvent(new Event('change'));
      await settle(fixture);

      expect(api.queries.at(-1)).toEqual({ paper: false, from: null, to: null, limit: 200 });
    });

    /**
     * The sentence names the two things that have to be true, and sends the
     * reader to the page that knows which one is missing. It deliberately does
     * not assert which — this page has not read the sportsbook list, and an
     * empty state that states a fact it did not check is worse than a vague one.
     */
    it('explains an empty history without claiming a cause it has not checked', async () => {
      const { el } = await render((api) => {
        api.rows = [];
      });
      const empty = el.querySelector('.empty')?.textContent ?? '';
      expect(empty).toContain('Nothing has been recommended yet');
      expect(empty).toContain('ev_threshold_pct');
      expect(empty).toContain('The dashboard says which half is missing');
    });
  });
});

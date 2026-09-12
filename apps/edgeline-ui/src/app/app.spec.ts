/**
 * The shell, and the two facts it carries on behalf of all eight pages.
 *
 * Both are here rather than on the dashboard because both are true everywhere,
 * and both are the kind of thing that fails silently: a PAPER badge that stops
 * rendering looks like a tidy header, and an engaged kill switch looks like a
 * working app right up until you notice nothing has been sent for a day.
 */

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { EDGELINE_THEME, METRUM_THEME, ThemeService } from '@metrum/ui';
import type { HealthResponse } from '@metrum/edgeline-api-client';

import { App } from './app';
import { appConfig } from './app.config';
import { EdgelineApiService } from './edgeline-api.service';

const HEALTHY: HealthResponse = {
  paper_mode: true,
  kill_switch: false,
  runtime: { last_heartbeat_at: '2026-09-08T12:00:00Z' },
  quota: [],
  sports_enabled: ['baseball_mlb'],
};

class ApiStub {
  health: HealthResponse = { ...HEALTHY };
  failWith: Error | null = null;

  getHealth(): Promise<HealthResponse> {
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.health);
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [App],
    providers: [provideRouter([]), { provide: EdgelineApiService, useValue: api }],
  });

  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, api };
}

describe('the Edgeline shell (§11.1, §11.2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists §11.1’s eight pages, in §11.1’s order', async () => {
    const { el } = await render();
    expect([...el.querySelectorAll('.rail__item')].map((n) => n.textContent?.trim())).toEqual([
      'Dashboard',
      'Opportunities',
      'Recommendations',
      'Results',
      'Settings',
      'Sportsbooks',
      'Providers',
      'Matching',
    ]);
  });

  it('says in the masthead that it never places a bet (§16.1)', async () => {
    const { el } = await render();
    expect(el.querySelector('.header__tagline')?.textContent).toContain('never places them');
  });

  it('shows the PAPER badge whenever paper_mode is on (§16.2)', async () => {
    const { el } = await render();
    const badge = el.querySelector('.header__badge--paper');
    expect(badge?.textContent?.trim()).toBe('PAPER');
  });

  /**
   * The header must never claim live-money advice on evidence it does not have.
   * Before the first health read lands — and if it never lands — the badge reads
   * PAPER, which is §3.2's own default and the state §15's Phase 4 gate has not
   * moved.
   */
  it('assumes paper before health has answered, and when it never does', async () => {
    const { el } = await render((api) => {
      api.failWith = new Error('connect ECONNREFUSED 127.0.0.1:8000');
    });
    expect(el.querySelector('.header__badge--paper')?.textContent?.trim()).toBe('PAPER');
    expect(el.querySelector('.header__badge--live')).toBeNull();
  });

  it('shows LIVE, with the danger weight, only when health says so', async () => {
    const { el } = await render((api) => {
      api.health = { ...HEALTHY, paper_mode: false };
    });
    expect(el.querySelector('.header__badge--live')?.textContent?.trim()).toBe('LIVE');
    expect(el.querySelector('.header__badge--paper')).toBeNull();
  });

  /**
   * §3.2: "when true: polling continues, all alerting stops." That asymmetry is
   * the whole reason for a banner — every table in the app keeps filling up, so
   * nothing else on screen looks wrong.
   */
  it('explains an engaged kill switch on every page, not just the dashboard', async () => {
    const { el } = await render((api) => {
      api.health = { ...HEALTHY, kill_switch: true };
    });
    const banner = el.querySelector('.banner--killed');
    expect(banner?.textContent).toContain('Alerting is stopped');
    expect(banner?.textContent).toContain('Polling continues');
    expect(el.querySelector('.header__badge--killed')?.textContent?.trim()).toBe('ALERTS OFF');
  });

  it('renders an unreachable engine as an unreachable engine', async () => {
    const { el } = await render((api) => {
      api.failWith = new Error('failed to fetch');
    });
    const banner = el.querySelector('.banner--down');
    expect(banner?.textContent).toContain('The engine is not answering');
    expect(banner?.textContent).toContain('edgeline-api:serve');
  });
});

describe('the theme (§11.2 as amended)', () => {
  /**
   * The app's default is its own palette, not the house one. This is the
   * assertion that would have caught the original problem: registering
   * `METRUM_THEME` here made Edgeline identical to the workspace dashboard *and*
   * collapsed the switcher to a single entry, neither of which looked like a bug
   * from inside the code.
   */
  it('defaults to Edgeline violet, not the house teal', () => {
    expect(EDGELINE_THEME.dark.accent).toBe('#a78bfa');
    expect(EDGELINE_THEME.dark.accent).not.toBe(METRUM_THEME.dark.accent);
  });

  /**
   * The lesson from the amber palette this replaced. A brand colour that sits in
   * the warning family makes every caution in the app compete with the chrome,
   * and the fix was not to tune the ambers — it was to get the brand out of that
   * hue entirely. `warn` being the house amber again is the evidence that
   * happened; pinned so a future palette cannot quietly re-take it.
   */
  it('leaves the warning hues to the warnings', () => {
    expect(EDGELINE_THEME.dark.warn).toBe(METRUM_THEME.dark.warn);
    expect(EDGELINE_THEME.dark.danger).toBe(METRUM_THEME.dark.danger);
    // §4.2's provenance hue has to stay distinct from the brand, which is the
    // same rule read the other way: violet took what `ai` used to be.
    expect(EDGELINE_THEME.dark.ai).not.toBe(EDGELINE_THEME.dark.accent);
  });

  it('offers every suite palette, its own first', () => {
    TestBed.configureTestingModule({ providers: [...appConfig.providers] });

    expect(TestBed.inject(ThemeService).themes().map((theme) => theme.id)).toEqual([
      'edgeline',
      'metrum',
      'ledgerline',
    ]);
  });

  // styles.scss declares these two literally, as the ground painted between the
  // browser reading index.html and Angular's initializer running. They are the
  // only tokens duplicated anywhere in this app, and this is what stops the
  // duplicate from drifting into a one-frame flash of the wrong colour.
  it('matches the pre-bootstrap floor in styles.scss', () => {
    expect(EDGELINE_THEME.dark.bg).toBe('#151320');
    expect(EDGELINE_THEME.dark.text).toBe('#eae8f5');
  });
});

/**
 * §11.1's settings page.
 *
 * Phase 3's exit condition — "every §3.2 setting editable in UI" — is **not**
 * proven here. It is proven at compile time in `settings-fields.ts`, against the
 * generated client's `Settings`, because that is the only version of the check
 * that tracks the engine rather than tracking whatever this file happens to say.
 *
 * What is left here is behaviour a reader could see: that a control renders for
 * each field, that dollars go back as cents, that a patch carries only what
 * changed, and that the two guardrails in §11.1's Safety group need a second,
 * labelled press before they move.
 */

import { TestBed } from '@angular/core/testing';
import type { Settings } from '@metrum/edgeline-api-client';

import { SettingsPage } from './settings-page';
import { ALL_GROUPS } from './settings-fields';
import { EdgelineApiService } from '../../edgeline-api.service';

/**
 * §3.2's complete default set, verbatim, as stub data for the page.
 *
 * It is **not** the completeness oracle — that is the type-level check in
 * `settings-fields.ts`, which reads the generated client's `Settings` and so
 * tracks the engine rather than tracking this file. An earlier version of this
 * spec compared the field table against `Object.keys` of this literal, which is
 * two things the same person wrote at the same time: it stayed green when
 * `regions` was added to §3.2 on 2026-09-09, which is precisely the failure it
 * was written to catch.
 */
const SPEC_DEFAULTS: Settings = {
  paper_mode: true,
  kill_switch: false,
  kelly_fraction: 0.25,
  bankroll_start_cents: 100000,
  ev_threshold_pct: 2.0,
  min_edge_to_bet_pct: 1.5,
  min_books_for_consensus: 4,
  arb_min_profit_pct: 0.5,
  max_stake_cents: 25000,
  max_stake_pct: 2.0,
  daily_exposure_cap_cents: 100000,
  daily_loss_stop_cents: 50000,
  stake_rounding_cents: 100,
  devig_method: 'multiplicative',
  consensus_weights: { default: 1 },
  staleness_sigma_floor: 0.002,
  edge_improve_delta_pct: 0.5,
  alert_cooldown_s: 300,
  sports_enabled: ['baseball_mlb'],
  markets_featured: ['h2h', 'spreads', 'totals'],
  markets_props: ['batter_home_runs', 'pitcher_strikeouts'],
  regions: ['us', 'us2'],
  poll_interval_s: 120,
  poll_interval_dev_s: 43200,
  props_poll_interval_s: 600,
  closing_capture_offset_s: 300,
  quota_monthly_budget: 500,
};

class ApiStub {
  settings: Settings = { ...SPEC_DEFAULTS };
  readonly patches: Record<string, unknown>[] = [];
  rejectWith: unknown = null;

  getSettings(): Promise<Settings> {
    return Promise.resolve({ ...this.settings });
  }
  updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    if (this.rejectWith) return Promise.reject(this.rejectWith);
    this.patches.push(patch);
    this.settings = { ...this.settings, ...patch } as Settings;
    return Promise.resolve({ ...this.settings });
  }
  getHealth() {
    return Promise.resolve({ paper_mode: this.settings.paper_mode ?? true, kill_switch: false });
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [SettingsPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(SettingsPage);
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

function setInput(el: HTMLElement, key: string, value: string) {
  const input = el.querySelector(`#set-${key}`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  return input;
}

describe('SettingsPage (§11.1, §3.2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('completeness — Phase 3’s exit condition', () => {
    /**
     * That every §3.2 key *has* a field is proven at compile time in
     * `settings-fields.ts`, against the generated client's `Settings`. What is
     * left for a runtime test is the thing a type cannot say: that no key is
     * claimed by two groups at once, which would render two controls writing the
     * same setting and let the second silently win.
     */
    it('claims every key exactly once, across the four groups', () => {
      const covered = ALL_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
      expect(new Set(covered).size).toBe(covered.length);
      // The count is §3.2's, and moves when §3.2 does — 26 at Phase 3, plus
      // `regions` on 2026-09-09 and `offline_mode` on 2026-09-10.
      expect(covered).toHaveLength(28);
      expect(covered).toContain('regions');
      expect(covered).toContain('offline_mode');
    });

    it('groups them the way §11.1 names them', () => {
      expect(ALL_GROUPS.map((group) => group.title)).toEqual([
        'Staking',
        'Thresholds',
        'Polling',
        'Safety',
      ]);
    });

    it('renders an input for every one of them', async () => {
      const { el } = await render();
      for (const group of ALL_GROUPS) {
        for (const field of group.fields) {
          const control = el.querySelector(`#set-${field.key}`);
          expect(control, `no control rendered for ${field.key}`).toBeTruthy();
        }
      }
    });
  });

  describe('representations (§1)', () => {
    it('shows money fields in dollars and echoes the cents that will be stored', async () => {
      const { el } = await render();
      expect((el.querySelector('#set-max_stake_cents') as HTMLInputElement).value).toBe('250');
      expect(el.textContent).toContain('25000 cents');
    });

    it('sends cents back, not the dollars that were typed', async () => {
      const { fixture, el, api } = await render();
      setInput(el, 'max_stake_cents', '12.5');
      await settle(fixture);

      (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.patches).toEqual([{ max_stake_cents: 1250 }]);
    });

    it('edits list settings as comma-separated text and stores arrays', async () => {
      const { fixture, el, api } = await render();
      expect((el.querySelector('#set-sports_enabled') as HTMLInputElement).value).toBe(
        'baseball_mlb',
      );

      setInput(el, 'sports_enabled', 'baseball_mlb, americanfootball_nfl');
      await settle(fixture);
      (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.patches).toEqual([{ sports_enabled: ['baseball_mlb', 'americanfootball_nfl'] }]);
    });

    it('refuses consensus weights that are not a flat map of numbers', async () => {
      const { fixture, el, api } = await render();
      setInput(el, 'consensus_weights', '{"pinnacle": "three"}');
      const input = el.querySelector('#set-consensus_weights') as HTMLInputElement;
      input.dispatchEvent(new Event('blur'));
      await settle(fixture);

      (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.patches).toEqual([]);
      expect(el.textContent).toContain('not a flat map of numbers');
    });
  });

  describe('the patch', () => {
    /**
     * `PUT /api/settings` is a patch. Sending settings the reader did not touch
     * means an unrelated save can rewrite a value this page rendered slightly
     * wrong — so what is not changed is not sent.
     */
    it('sends only what changed', async () => {
      const { fixture, el, api } = await render();
      setInput(el, 'kelly_fraction', '0.15');
      await settle(fixture);
      (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await settle(fixture);

      expect(api.patches).toEqual([{ kelly_fraction: 0.15 }]);
    });

    it('sends nothing, and says so, when nothing changed', async () => {
      const { el, api } = await render();
      const submit = el.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(el.textContent).toContain('Nothing changed.');
      expect(api.patches).toEqual([]);
    });

    it('reports a refusal from the engine instead of claiming a save', async () => {
      const { fixture, el, api } = await render((stub) => {
        stub.rejectWith = { body: { detail: 'unknown settings keys (not in §3.2): [nope]' } };
      });
      setInput(el, 'kelly_fraction', '0.15');
      await settle(fixture);
      (el.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await settle(fixture);

      expect(el.textContent).toContain('The engine refused the change');
      expect(api.patches).toEqual([]);
    });
  });

  describe('the Safety group (§16.2)', () => {
    it('keeps the guardrails out of the ordinary Save', async () => {
      const { fixture, el, api } = await render();
      const paper = el.querySelector('#set-paper_mode') as HTMLInputElement;
      paper.click();
      await settle(fixture);

      const submit = el.querySelector('button[type="submit"]') as HTMLButtonElement;
      // Nothing in the tunable form changed, so its Save stays inert…
      expect(submit.disabled).toBe(true);
      // …and the guardrail change is staged on its own instead.
      expect(el.textContent).toContain('This removes a protection');
      expect(api.patches).toEqual([]);
    });

    /**
     * §16.2's direction. Turning paper mode off is the single most consequential
     * flag in the system, and the page has to say what it means before it can be
     * pressed — twice.
     */
    it('takes two labelled presses to turn paper mode off, and names what changes', async () => {
      const { fixture, el, api } = await render();
      (el.querySelector('#set-paper_mode') as HTMLInputElement).click();
      await settle(fixture);

      expect(el.textContent).toContain('live-money advice');
      expect(el.textContent).toContain('200 paper recommendations');

      (
        [...el.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Review this change',
        ) as HTMLButtonElement
      ).click();
      await settle(fixture);
      expect(api.patches).toEqual([]);

      (
        [...el.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Yes — apply',
        ) as HTMLButtonElement
      ).click();
      await settle(fixture);

      expect(api.patches).toEqual([{ paper_mode: false }]);
    });

    it('calls turning a guardrail on what it is, and still asks', async () => {
      const { fixture, el } = await render((stub) => {
        stub.settings = { ...SPEC_DEFAULTS, kill_switch: false };
      });
      (el.querySelector('#set-kill_switch') as HTMLInputElement).click();
      await settle(fixture);

      expect(el.textContent).toContain('This adds a protection');
      expect(el.querySelector('.safety__pending--loosening')).toBeNull();
    });

    it('cancels back to what the engine holds', async () => {
      const { fixture, el, api } = await render();
      (el.querySelector('#set-paper_mode') as HTMLInputElement).click();
      await settle(fixture);
      (
        [...el.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Review this change',
        ) as HTMLButtonElement
      ).click();
      await settle(fixture);
      (
        [...el.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Cancel',
        ) as HTMLButtonElement
      ).click();
      await settle(fixture);

      expect(api.patches).toEqual([]);
      expect((el.querySelector('#set-paper_mode') as HTMLInputElement).checked).toBe(true);
    });
  });
});

/**
 * §11.1's providers page.
 *
 * The quota bar is the point. §8.4 checks projected credit spend against the
 * budget at startup only, so the state that hurts is a month that runs dry
 * mid-cadence — and the one rendering that would hide it is a bar drawn at 0%
 * for a provider that has simply never reported.
 */

import { TestBed } from '@angular/core/testing';
import type { ProviderRow } from '@metrum/edgeline-api-client';

import { ProvidersPage } from './providers-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'the_odds_api',
    display_name: 'The Odds API',
    enabled: true,
    quota_used: 120,
    quota_budget: 500,
    quota_reset_at: '2026-10-01T00:00:00Z',
    config: {},
    ...overrides,
  };
}

class ApiStub {
  providers: ProviderRow[] = [provider()];
  readonly patches: { key: string; body: Record<string, unknown> }[] = [];

  listProviders(): Promise<ProviderRow[]> {
    return Promise.resolve(this.providers);
  }
  patchProvider(key: string, body: Record<string, unknown>): Promise<ProviderRow> {
    this.patches.push({ key, body });
    this.providers = this.providers.map((row) => (row.id === key ? { ...row, ...body } : row));
    return Promise.resolve(this.providers[0]);
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [ProvidersPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(ProvidersPage);
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

describe('ProvidersPage (§11.1, §8.4)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('draws the quota bar against the budget, and names what fills it', async () => {
    const { el } = await render();
    // "used", not just "of": the bar fills with credits spent, and an unlabelled
    // proportion is as readable as remaining-credits by anyone who assumes so.
    expect(el.textContent).toContain('120 of 500 credits used');
    expect((el.querySelector('.quota__fill') as HTMLElement).style.width).toBe('24%');
    expect(el.querySelector('.quota__bar--unknown')).toBeNull();
  });

  /**
   * `quota_used: null` is "never asked". This used to render an empty track
   * beside "— of 500", which is ambiguous in both directions at once — an empty
   * progress bar reads as "nothing left" about as readily as "nothing used" —
   * and the honest answer is neither.
   *
   * Filling it would be the worse fix: a full bar claims 500 credits are
   * available, which is the figure §8.4 must not be wrong about and which no
   * provider has reported.
   */
  it('shows an unreported quota as unknown, not as empty and not as full', async () => {
    const { el } = await render((api) => {
      api.providers = [provider({ quota_used: null })];
    });
    expect(el.querySelector('.quota__fill')).toBeNull();
    expect(el.querySelector('.quota__bar--unknown')).toBeTruthy();
    expect(el.textContent).toContain('Usage unknown');
    expect(el.textContent).toContain('500 credit budget');
    expect(el.textContent).toContain('unknown rather than zero');
  });

  it('names the reported reset date when there is one', async () => {
    const { el } = await render();
    const reset = el.querySelector('.provider__reset') as HTMLElement;
    expect(reset.textContent).toContain('Resets');
    expect(reset.textContent).not.toContain('expected');
    expect(reset.classList.contains('provider__reset--expected')).toBe(false);
  });

  /**
   * §16.3: a value we worked out is never dressed as one the provider reported.
   * "resets —" said nothing to someone judging whether a spent month still
   * matters today, so the first of next month is derived — and labelled.
   */
  it('derives the next reset when none has been reported, and marks it expected', async () => {
    const { el } = await render((api) => {
      api.providers = [provider({ quota_reset_at: null })];
    });
    const reset = el.querySelector('.provider__reset') as HTMLElement;
    const firstOfNextMonth = new Date();
    firstOfNextMonth.setDate(1);
    firstOfNextMonth.setMonth(firstOfNextMonth.getMonth() + 1);

    expect(reset.textContent).toContain('(expected)');
    expect(reset.textContent).toContain(String(firstOfNextMonth.getFullYear()));
    expect(reset.classList.contains('provider__reset--expected')).toBe(true);
    expect(reset.getAttribute('title')).toContain('worked out, not quoted');
  });

  it('marks a nearly-spent budget', async () => {
    const { el } = await render((api) => {
      api.providers = [provider({ quota_used: 460 })];
    });
    expect(el.querySelector('.quota__fill--tight')).toBeTruthy();
  });

  it('patches enabled, not the whole row', async () => {
    const { fixture, el, api } = await render();
    const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(api.patches).toEqual([{ key: 'the_odds_api', body: { enabled: false } }]);
  });

  it('sends a changed budget, and ignores one that has not changed', async () => {
    const { fixture, el, api } = await render();
    const budget = el.querySelector('.budget') as HTMLInputElement;

    budget.value = '500';
    budget.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(api.patches).toEqual([]);

    budget.value = '1000';
    budget.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(api.patches).toEqual([{ key: 'the_odds_api', body: { quota_budget: 1000 } }]);
  });

  /**
   * `edgeline-providers` is deliberately absent from `SEEDS` — unlike the
   * sportsbook list, nothing writes a row until a provider answers and reports
   * its credit usage. Calling that a misconfiguration would send the reader
   * looking for a broken bootstrap that is working correctly.
   */
  it('explains an empty list as "nothing has polled yet", not as a bootstrap failure', async () => {
    const { el } = await render((api) => {
      api.providers = [];
    });
    const empty = el.querySelector('.empty')?.textContent ?? '';
    expect(empty).toContain('No provider has reported yet');
    expect(empty).toContain('not seeded at bootstrap');
    expect(empty).not.toContain('check that the cluster is up');
  });
});

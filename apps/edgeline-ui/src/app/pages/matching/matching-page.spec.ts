/**
 * §11.1's quarantine queue.
 *
 * The empty state is the assertion that matters. An empty queue is the *good*
 * state — every row the normalizer saw mapped cleanly — and a page that showed
 * nothing at all would read as a broken screen at exactly the moment the system
 * is working.
 */

import { TestBed } from '@angular/core/testing';
import type { UnmatchedRowResponse } from '@metrum/edgeline-api-client';

import { MatchingPage } from './matching-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function row(overrides: Partial<UnmatchedRowResponse> = {}): UnmatchedRowResponse {
  return {
    id: 'u1',
    provider_key: 'the_odds_api',
    raw: { home_team: 'Orioles', away_team: 'Yankees', bookmakers: [] },
    reason: 'no canonical event match',
    resolved: false,
    created_at: '2026-09-08T15:00:00Z',
    ...overrides,
  };
}

class ApiStub {
  rows: UnmatchedRowResponse[] = [row()];
  readonly queries: unknown[] = [];
  readonly resolved: string[] = [];

  listUnmatched(query: unknown): Promise<UnmatchedRowResponse[]> {
    this.queries.push(query);
    return Promise.resolve(this.rows);
  }
  resolveUnmatched(id: string): Promise<UnmatchedRowResponse> {
    this.resolved.push(id);
    this.rows = this.rows.filter((item) => item.id !== id);
    return Promise.resolve(row({ id, resolved: true }));
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [MatchingPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(MatchingPage);
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

describe('MatchingPage (§11.1, §7.3, §16.3)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists a quarantined row by the reason it was quarantined', async () => {
    const { el } = await render();
    expect(el.querySelector('.item__reason')?.textContent).toContain('no canonical event match');
    expect(el.textContent).toContain('the_odds_api');
  });

  /** The payload is the page. Whatever put the row here means nothing could be
   *  trusted to read it, so nothing summarises it. */
  it('shows the raw payload verbatim when a row is opened', async () => {
    const { fixture, el } = await render();
    expect(el.querySelector('.item__raw')).toBeNull();

    (el.querySelector('.item__toggle') as HTMLButtonElement).click();
    await settle(fixture);

    const raw = el.querySelector('.item__raw')?.textContent ?? '';
    expect(raw).toContain('"home_team": "Orioles"');
    expect(raw).toContain('"bookmakers": []');
  });

  it('resolves a row, and says resolving is a note rather than a re-match', async () => {
    const { fixture, el, api } = await render();
    clickText(el, 'Mark reviewed');
    await settle(fixture);

    expect(api.resolved).toEqual(['u1']);
    expect(el.querySelector('.notice')?.textContent).toContain('no mapping was written');
  });

  it('offers no editor — a hand-typed match is the guess §16.3 forbids', async () => {
    const { fixture, el } = await render();
    (el.querySelector('.item__toggle') as HTMLButtonElement).click();
    await settle(fixture);

    expect(el.querySelectorAll('input')).toHaveLength(0);
    expect(el.querySelectorAll('select')).toHaveLength(0);
  });

  it('switches between the queue and what has been reviewed', async () => {
    const { fixture, el, api } = await render();
    expect(api.queries.at(-1)).toEqual({ resolved: false, limit: 200 });

    clickText(el, 'Show reviewed rows');
    await settle(fixture);

    expect(api.queries.at(-1)).toEqual({ resolved: true, limit: 200 });
    expect(el.textContent).toContain('Reviewed');
  });

  it('calls an empty queue the good state, not a broken page', async () => {
    const { el } = await render((api) => {
      api.rows = [];
    });
    const empty = el.querySelector('.empty')?.textContent ?? '';
    expect(empty).toContain('The quarantine queue is empty');
    expect(empty).toContain('That is the good state');
  });
});

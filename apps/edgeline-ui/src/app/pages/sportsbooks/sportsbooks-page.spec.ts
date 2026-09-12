/**
 * §11.1's sportsbooks page.
 *
 * The link editor is what these tests are really about. §16.3 forbids guessing
 * a deep-link URL schema, and the way that rule gets broken by a UI is not a
 * deliberate guess — it is a "Test link" button that cheerfully opens a template
 * with `{event_id}` still in it, lands on some page of a real sportsbook, and
 * lets the reader conclude the template works.
 */

import { TestBed } from '@angular/core/testing';
import type { SportsbookRow } from '@metrum/edgeline-api-client';

import { SportsbooksPage } from './sportsbooks-page';
import { EdgelineApiService } from '../../edgeline-api.service';

function book(id: string, overrides: Partial<SportsbookRow> = {}): SportsbookRow {
  return {
    id,
    display_name: id,
    enabled: false,
    md_licensed: true,
    priority: 1,
    link_templates: {},
    ...overrides,
  };
}

class ApiStub {
  books: SportsbookRow[] = [book('draftkings'), book('fanduel', { enabled: true })];
  readonly patches: { key: string; body: Record<string, unknown> }[] = [];

  listSportsbooks(): Promise<SportsbookRow[]> {
    return Promise.resolve(this.books);
  }
  patchSportsbook(key: string, body: Record<string, unknown>): Promise<SportsbookRow> {
    this.patches.push({ key, body });
    this.books = this.books.map((row) => (row.id === key ? { ...row, ...body } : row));
    return Promise.resolve(this.books.find((row) => row.id === key) as SportsbookRow);
  }
}

async function render(configure: (api: ApiStub) => void = () => undefined) {
  const api = new ApiStub();
  configure(api);
  TestBed.configureTestingModule({
    imports: [SportsbooksPage],
    providers: [{ provide: EdgelineApiService, useValue: api }],
  });
  const fixture = TestBed.createComponent(SportsbooksPage);
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

describe('SportsbooksPage (§11.1)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lists every book with its enabled state and priority', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(el.textContent).toContain('1 of 2 enabled');
  });

  it('enables a book through a patch, not a whole-row write', async () => {
    const { fixture, el, api } = await render();
    const toggle = el.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(api.patches).toEqual([{ key: 'draftkings', body: { enabled: true } }]);
  });

  it('does not write a priority that has not changed', async () => {
    const { fixture, el, api } = await render();
    const input = el.querySelector('.priority') as HTMLInputElement;
    input.value = '1';
    input.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(api.patches).toEqual([]);
  });

  describe('deep links (§9.4, §16.3)', () => {
    it('renders a book with no templates as visibly absent, not as a dead link', async () => {
      const { el } = await render();
      expect(el.querySelector('.no-link')?.textContent?.trim()).toBe('No link');
      expect(el.querySelector('tbody a[href=""]')).toBeNull();
    });

    it('summarises the ladder rungs a book actually has', async () => {
      const { el } = await render((api) => {
        api.books = [
          book('draftkings', {
            link_templates: { event: 'https://x.example/e/{event_id}', book_home: 'https://x.example/' },
          }),
        ];
      });
      expect(el.querySelector('tbody tr')?.textContent).toContain('event, book_home');
    });

    /**
     * The rule, as a button state. A template with an unfilled placeholder is
     * not a URL, and opening it would land somewhere real while reading as
     * confirmation.
     */
    it('refuses to test a template that still has a placeholder in it', async () => {
      const { fixture, el } = await render();
      clickText(el, 'Edit links');
      await settle(fixture);

      const input = el.querySelector('#tpl-draftkings-event') as HTMLInputElement;
      input.value = 'https://sportsbook.example.com/event/{event_id}';
      input.dispatchEvent(new Event('input'));
      await settle(fixture);

      const test = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Test link',
      ) as HTMLButtonElement;
      expect(test.disabled).toBe(true);
      expect(el.textContent).toContain('{event_id}');
      expect(el.textContent).toContain('Paste a real event URL from the book');
    });

    it('tests a concrete URL, which is the thing a person can actually verify', async () => {
      const opened: string[] = [];
      const original = window.open;
      Object.defineProperty(window, 'open', {
        configurable: true,
        value: (url: string) => {
          opened.push(url);
          return null;
        },
      });

      try {
        const { fixture, el } = await render();
        clickText(el, 'Edit links');
        await settle(fixture);

        const input = el.querySelector('#tpl-draftkings-book_home') as HTMLInputElement;
        input.value = 'https://sportsbook.example.com/';
        input.dispatchEvent(new Event('input'));
        await settle(fixture);

        const buttons = [...el.querySelectorAll('button')].filter(
          (b) => b.textContent?.trim() === 'Test link',
        ) as HTMLButtonElement[];
        const enabled = buttons.find((b) => !b.disabled);
        expect(enabled).toBeTruthy();
        enabled?.click();

        expect(opened).toEqual(['https://sportsbook.example.com/']);
      } finally {
        Object.defineProperty(window, 'open', { configurable: true, value: original });
      }
    });

    it('stores only the rungs that were filled in', async () => {
      const { fixture, el, api } = await render();
      clickText(el, 'Edit links');
      await settle(fixture);

      const input = el.querySelector('#tpl-draftkings-event') as HTMLInputElement;
      input.value = 'https://sportsbook.example.com/event/{event_id}';
      input.dispatchEvent(new Event('input'));
      await settle(fixture);

      clickText(el, 'Save templates');
      await settle(fixture);

      // An empty rung is omitted, not stored as "". §9.4 walks the ladder
      // looking for a template that is present, and a blank string is present.
      expect(api.patches).toEqual([
        {
          key: 'draftkings',
          body: { link_templates: { event: 'https://sportsbook.example.com/event/{event_id}' } },
        },
      ]);
    });

    it('says what saving nothing means', async () => {
      const { fixture, el } = await render();
      clickText(el, 'Edit links');
      await settle(fixture);
      clickText(el, 'Save templates');
      await settle(fixture);

      expect(el.textContent).toContain('no link templates');
    });
  });

  it('explains an empty list as a bootstrap problem, not as a normal state', async () => {
    const { el } = await render((api) => {
      api.books = [];
    });
    expect(el.querySelector('.empty')?.textContent).toContain('No sportsbooks are seeded');
  });
});

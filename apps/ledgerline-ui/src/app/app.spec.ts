import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTheming } from '@metrum/ui';
import { LedgerlineApiService } from '@metrum/ledgerline-feature-shell';
import type { MerchantReviewQueue, Settings } from '@metrum/api-client';
import { App } from './app';
import { appRoutes } from './app.routes';
import { LEDGERLINE_THEME } from './ledgerline.theme';

/**
 * The shell, and only the shell.
 *
 * The "binds through to the ui panel" guard that used to live here has moved to
 * `libs/ledgerline/feature-shell` — `@metrum/ui` is consumed by the pages now, and
 * the guard has to sit wherever `ui-panel` is actually rendered. Its reasoning is
 * unchanged and is written out there; see also `apps/ledgerline-ui/README.md`.
 *
 * The API is stubbed here for two reasons, and they are the only two things the
 * shell reads. §6.9's rail badge (§9s) needs a count at startup, which is the whole
 * point of the badge. §6.8's provider indicator (§9t) needs the settings row,
 * because which provider is configured is a fact about the *server* rather than UI
 * state. A shell spec that reached the network to render its own navigation would
 * be a spec that fails when nothing is serving.
 */
function queueOf(mergeCandidates: number): MerchantReviewQueue {
  return {
    mergeCandidates: Array.from({ length: mergeCandidates }, () => ({
      keep: reviewMerchant('samsclub', 'SAMSCLUB', 24),
      merge: reviewMerchant('sams-club', 'SAMS CLUB', 14),
      similarity: 0.583,
    })),
    // Deliberately non-empty: provisional merchants are not questions and must not
    // reach the badge.
    provisional: [reviewMerchant('kwik-trip', 'KWIK TRIP', 6)],
    llmProposals: [],
    llmProposalsUnavailableReason: null,
  };
}

function reviewMerchant(id: string, name: string, transactionCount: number) {
  return {
    merchant: {
      id,
      canonicalName: name,
      displayName: name,
      website: null,
      defaultCategoryId: null,
      isKnownSubscription: false,
      isTransferKind: false,
      overlapGroup: null,
      source: 'rule' as const,
    },
    transactionCount,
    sampleDescriptors: [name],
  };
}

function settingsWith(llm: Partial<Settings['llm']>): Settings {
  return {
    configHash: 'abc0123456789def',
    rules: [],
    thresholds: [],
    unsettable: [],
    llm: {
      providerId: 'none',
      model: null,
      redaction: true,
      redactionLocked: false,
      sendsDataOffMachine: false,
      cachedResponses: 0,
      degradedCallCount: 0,
      ...llm,
    },
    databaseFile: ':memory:',
    backupDir: '',
  } as Settings;
}

/**
 * What `GET /api/settings` served before §2.4 put the LLM block on it — the same
 * row minus `llm`, which is what an API binary older than the UI still returns.
 * Cast because the shape is deliberately not a `Settings`: the point of the test
 * is what the shell does when the payload it is handed is not one.
 */
function settingsWithoutLlm(): Settings {
  return {
    configHash: 'abc0123456789def',
    rules: [],
    thresholds: [],
    unsettable: [],
    databaseFile: ':memory:',
    backupDir: '',
  } as unknown as Settings;
}

/** The two reads the shell makes, plus the three the home page makes when a test
 *  navigates to `/`. What the home page renders is `home-page.spec.ts`'s
 *  business; this stub exists only so routing to it does not reach the network. */
class ApiStub {
  queue: MerchantReviewQueue = queueOf(1);
  settings: Settings = settingsWith({});

  getMerchantReviewQueue(): Promise<MerchantReviewQueue> {
    return Promise.resolve(this.queue);
  }

  getSettings(): Promise<Settings> {
    return Promise.resolve(this.settings);
  }

  getFindingsSummary(): Promise<null> {
    return Promise.resolve(null);
  }

  listAccounts(): Promise<[]> {
    return Promise.resolve([]);
  }

  getAccountCoverage(): Promise<null> {
    return Promise.resolve(null);
  }
}

describe('App', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        // The app's real theming, because the header renders the switcher and
        // what it offers is exactly what `provideTheming` registered.
        provideTheming(LEDGERLINE_THEME),
        { provide: LedgerlineApiService, useValue: api },
      ],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const labels = (el: HTMLElement, selector: string) =>
    [...el.querySelectorAll(selector)].map((n) => n.querySelector('.rail__label')?.textContent?.trim());

  it('renders the shell chrome', async () => {
    const el = await render();

    expect(el.querySelector('.header__brand')?.textContent).toContain('Ledgerline');
    // §6.8 — the provider indicator is persistent, not Settings-only. It is worded
    // as what happens to the data rather than as a provider name, because it is
    // read by someone who is not thinking about providers.
    expect(el.querySelector('.header__provider')?.textContent).toContain('Local only');
  });

  /**
   * §6.8: "While it's active, a persistent indicator sits in the app header."
   *
   * Driven off `sendsDataOffMachine` rather than off the provider id, which is
   * §2.4's reason for putting that flag on the interface at all: one fact, one
   * source, and no UI re-deriving the thing that must never be wrong.
   */
  it('marks the header when the provider sends data off this machine', async () => {
    api.settings = settingsWith({ providerId: 'claude-cli', sendsDataOffMachine: true });
    const el = await render();

    const badge = el.querySelector('.header__provider');
    expect(badge?.textContent).toContain('Sending data off this machine');
    expect(badge?.classList.contains('header__provider--remote')).toBe(true);
  });

  /**
   * The indicator is chrome, so it renders on every page — which makes a throw
   * here an error on every page, and one that nothing visibly fails on. An API
   * older than §2.4 serves settings with no `llm` block at all; the shell has to
   * read that as "nothing configured" rather than as a crash, because the two
   * look identical in the header and only one of them is silent.
   *
   * The console assertion is here because the app swallows this, and the spec
   * does not. In the browser `provideBrowserGlobalErrorListeners` catches the
   * throw, the header still renders "Local only", and the only trace is a console
   * error — so the text assertion alone is exactly the check that passed while
   * the bug was live. This spec has no such listener and would fail on the throw,
   * but pinning the console keeps the test honest if that ever changes.
   */
  it('falls back to the defaults when the settings row predates the llm block', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.settings = settingsWithoutLlm();

    const el = await render();

    expect(el.querySelector('.header__provider')?.textContent).toContain('Local only');
    expect(el.querySelector('.header__provider')?.classList.contains('header__provider--remote')).toBe(
      false,
    );
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('says a local model is local, which is not the same as none', async () => {
    api.settings = settingsWith({ providerId: 'ollama', sendsDataOffMachine: false });
    const el = await render();

    const badge = el.querySelector('.header__provider');
    expect(badge?.textContent).toContain('AI on this machine');
    expect(badge?.classList.contains('header__provider--remote')).toBe(false);
  });

  // The app name is the way home — the one navigation convention every user
  // already has, and the reason the front door needs no rail item of its own.
  it('makes the app name the way home', async () => {
    const el = await render();

    expect(el.querySelector('a.header__brand')?.getAttribute('href')).toBe('/');
  });

  /**
   * The mark sits *inside* that link rather than beside it. Two adjacent links to
   * `/` would be two tab stops and two announcements of one destination, so the
   * icon and the wordmark are one target — and the icon's `alt` is empty because
   * the link is already named by the word next to it.
   */
  it('puts the app icon in the header, inside the link home', async () => {
    const el = await render();

    const mark = el.querySelector('a.header__brand img.header__mark');
    expect(mark?.getAttribute('src')).toBe('icon.svg');
    expect(mark?.getAttribute('alt')).toBe('');
  });

  // Theming is `@metrum/ui`'s, and the switcher is chrome: it is true on every
  // page, so putting it on one would make it false on the other nine.
  it('carries the theme and mode switcher in the header', async () => {
    const el = await render();

    const switcher = el.querySelector('.header ui-theme-switcher');
    expect(switcher).not.toBeNull();
    // Two themes are registered, so the picker has something to pick.
    expect(switcher?.querySelector('select')).not.toBeNull();
    expect(switcher?.querySelectorAll('.modes__button')).toHaveLength(3);
  });

  // §6.9's Review is last in the spec and fourth here: it is about your data, not
  // about the app, and under Settings is where it was buried (§9s).
  it('rails all nine §6 sections, with Review among the data pages', async () => {
    const el = await render();

    expect(labels(el, '.rail__item')).toEqual([
      'Import',
      'Accounts',
      'Transactions',
      'Review',
      'Findings',
      'Subscriptions',
      'Insights',
      'Ask',
      'Settings',
    ]);
  });

  /**
   * Every §6 section now has a page (§9aa), so this asserts the whole rail rather
   * than a subset — and the pending count is zero rather than the case being
   * deleted. The rule it guards outlives the last unbuilt section: a rail item that
   * routes nowhere is a link to a blank screen, and §6 is not the last section this
   * app will grow.
   */
  it('links every section, now that all nine are built', async () => {
    const el = await render();

    expect(labels(el, 'a.rail__item')).toEqual([
      'Import',
      'Accounts',
      'Transactions',
      'Review',
      'Findings',
      'Subscriptions',
      'Insights',
      'Ask',
      'Settings',
    ]);
    expect(el.querySelectorAll('.rail__item--pending')).toHaveLength(0);
  });

  describe('§6.9’s badge', () => {
    it('shows what is waiting, before anyone has opened the page', async () => {
      const el = await render();

      expect(el.querySelector('.rail__badge')?.textContent?.trim()).toBe('1');
      // The number alone says nothing read aloud, so the link carries it too.
      const review = [...el.querySelectorAll('a.rail__item')].find((a) =>
        a.querySelector('.rail__label')?.textContent?.includes('Review'),
      );
      expect(review?.getAttribute('aria-label')).toBe('Review, 1 waiting for an answer');
    });

    it('counts the questions and not the provisional merchants beside them', async () => {
      api.queue = queueOf(2);
      const el = await render();

      expect(el.querySelector('.rail__badge')?.textContent?.trim()).toBe('2');
    });

    it('renders nothing at all when the queue is empty', async () => {
      api.queue = queueOf(0);
      const el = await render();

      // Not a zero. A badge showing 0 is a badge you stop looking at.
      expect(el.querySelector('.rail__badge')).toBeNull();
      const review = [...el.querySelectorAll('a.rail__item')].find((a) =>
        a.querySelector('.rail__label')?.textContent?.includes('Review'),
      );
      expect(review?.getAttribute('aria-label')).toBeNull();
    });
  });

  // §9u: the app opens on the front door rather than on §6.4. Findings is still
  // the hero and the home page's headline figure links straight to it — what
  // changed is that a fresh database now opens on something other than three
  // em-dashes.
  it('opens on the home page rather than redirecting into a section', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');

    expect(router.url).toBe('/');
  });
});

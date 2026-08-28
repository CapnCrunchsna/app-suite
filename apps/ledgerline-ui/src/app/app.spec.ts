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

  // A rail item becomes a link only once its page exists. Two of the nine are
  // spans, so none of them can be clicked into a blank screen.
  it('links only the sections that are built', async () => {
    const el = await render();

    expect(labels(el, 'a.rail__item')).toEqual([
      'Import',
      'Accounts',
      'Transactions',
      'Review',
      'Findings',
      'Subscriptions',
      'Settings',
    ]);
    expect(el.querySelectorAll('.rail__item--pending')).toHaveLength(2);
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

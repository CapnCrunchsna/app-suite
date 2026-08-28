import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { LedgerlineApiService } from '@metrum/ledgerline-feature-shell';
import type { MerchantReviewQueue } from '@metrum/api-client';
import { App } from './app';
import { appRoutes } from './app.routes';

/**
 * The shell, and only the shell.
 *
 * The "binds through to the ui panel" guard that used to live here has moved to
 * `libs/ledgerline/feature-shell` — `@metrum/ui` is consumed by the pages now, and
 * the guard has to sit wherever `ui-panel` is actually rendered. Its reasoning is
 * unchanged and is written out there; see also `apps/ledgerline-ui/README.md`.
 *
 * The API is stubbed here for one reason: §6.9's rail badge (§9s). The shell reads
 * a count at startup, which is the whole point of the badge, and a shell spec that
 * reached the network to render its own navigation would be a spec that fails when
 * nothing is serving.
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

describe('App', () => {
  let queue: MerchantReviewQueue;

  beforeEach(async () => {
    queue = queueOf(1);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(appRoutes),
        {
          provide: LedgerlineApiService,
          useValue: { getMerchantReviewQueue: () => Promise.resolve(queue) },
        },
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
    // §6.8 — the provider indicator is persistent, not Settings-only.
    expect(el.querySelector('.header__provider')?.textContent).toContain('LLM: none');
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
      queue = queueOf(2);
      const el = await render();

      expect(el.querySelector('.rail__badge')?.textContent?.trim()).toBe('2');
    });

    it('renders nothing at all when the queue is empty', async () => {
      queue = queueOf(0);
      const el = await render();

      // Not a zero. A badge showing 0 is a badge you stop looking at.
      expect(el.querySelector('.rail__badge')).toBeNull();
      const review = [...el.querySelectorAll('a.rail__item')].find((a) =>
        a.querySelector('.rail__label')?.textContent?.includes('Review'),
      );
      expect(review?.getAttribute('aria-label')).toBeNull();
    });
  });

  // §6.4 is the page §6 calls the hero, so it is what the app opens on now that
  // it exists — Transactions held that position only until it did.
  it('opens on Findings, the page §6 calls the hero', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');

    expect(router.url).toBe('/findings');
  });
});

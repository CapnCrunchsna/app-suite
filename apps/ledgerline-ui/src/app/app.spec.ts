import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';

/**
 * The shell, and only the shell.
 *
 * The "binds through to the ui panel" guard that used to live here has moved to
 * `libs/ledgerline/feature-shell` — `@metrum/ui` is consumed by the pages now, and
 * the guard has to sit wherever `ui-panel` is actually rendered. Its reasoning is
 * unchanged and is written out there; see also `apps/ledgerline-ui/README.md`.
 */
describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(appRoutes)],
    }).compileComponents();
  });

  it('renders the shell chrome', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.header__brand')?.textContent).toContain('Ledgerline');
    // §6.8 — the provider indicator is persistent, not Settings-only.
    expect(el.querySelector('.header__provider')?.textContent).toContain('LLM: none');
  });

  it('rails all eight §6 sections', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const labels = [...el.querySelectorAll('.rail__item')].map((n) => n.textContent?.trim());
    expect(labels).toEqual([
      'Import',
      'Accounts',
      'Transactions',
      'Findings',
      'Subscriptions',
      'Insights',
      'Ask',
      'Settings',
    ]);
  });

  // A rail item becomes a link only once its page exists. Six of the eight are
  // spans, so none of them can be clicked into a blank screen.
  it('links only the sections that are built', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const linked = [...el.querySelectorAll('a.rail__item')].map((n) => n.textContent?.trim());
    expect(linked).toEqual(['Import', 'Transactions']);
    expect(el.querySelectorAll('.rail__item--pending')).toHaveLength(6);
  });

  it('opens on Transactions, the one page that renders stored data', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');

    expect(router.url).toBe('/transactions');
  });
});

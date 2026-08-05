import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('renders the shell chrome', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.header__brand')?.textContent).toContain(
      'Ledgerline',
    );
    // §6.8 — the provider indicator is persistent, not Settings-only.
    expect(el.querySelector('.header__provider')?.textContent).toContain(
      'LLM: none',
    );
  });

  it('rails all eight §6 sections', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const labels = [...el.querySelectorAll('.rail__item')].map((n) =>
      n.textContent?.trim(),
    );
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

  // Guards `@metrum/ui`'s build. If that lib ever stops producing real
  // ngtsc output, Panel gets JIT-compiled from its decorator alone, `heading`
  // silently stops being an input, and everything still renders — this is the
  // only thing that notices. See apps/ledgerline-ui/README.md.
  it('binds through to the ui panel', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('ui-panel .panel__heading')?.textContent).toContain(
      'Findings',
    );

    const accounts = [...el.querySelectorAll('.rail__item')].find(
      (n) => n.textContent?.trim() === 'Accounts',
    ) as HTMLButtonElement;
    accounts.click();
    await fixture.whenStable();

    expect(el.querySelector('ui-panel .panel__heading')?.textContent).toContain(
      'Accounts',
    );
  });
});

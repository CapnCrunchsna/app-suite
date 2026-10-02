import { TestBed } from '@angular/core/testing';
import { METRUM_THEME, provideTheming } from '@metrum/ui';
import { App, STORAGE_KEY } from './app';

describe('App', () => {
  beforeEach(async () => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideTheming(METRUM_THEME)],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('opens on the sample data and says so', async () => {
    const el = await render();

    expect(el.querySelector('.notice')?.textContent).toContain('made-up sample data');
    // The sample: $555,000 on the 1% / 0.85% / 0.65% tiered schedule = $5,467.50
    // advisory, plus fund expenses — one tile carries the all-in figure.
    expect(el.querySelector('.tile__value')?.textContent).toMatch(/^\$\d{1,2},\d{3}$/);
    expect(el.querySelectorAll('pc-projection-chart path.line')).toHaveLength(2);
  });

  it('does not save the sample over real numbers until it is edited', async () => {
    await render();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('frames results as what the numbers show, with a disclaimer on the page', async () => {
    const el = await render();

    expect(el.querySelector('.disclaimer')?.textContent).toContain('not personalized investment');
    expect(el.textContent).not.toMatch(/you should (fire|leave|switch)/i);
  });
});

/**
 * The theming system, and the one claim in it that cannot be made by reading:
 * that the light palettes are legible.
 *
 * `auditTheme` is run here over the house theme, and every app that registers its
 * own is expected to run it over that one — `apps/ledgerline-ui` does. Between
 * them, no palette in the suite can ship a foreground nobody can read on the
 * ground it sits on.
 */

import { TestBed } from '@angular/core/testing';

import { auditTheme, contrastRatio, relativeLuminance } from './contrast.js';
import { METRUM_THEME } from './metrum.theme.js';
import { provideTheming } from './provide-theming.js';
import { ThemeService } from './theme.service.js';
import { ThemeSwitcher } from './theme-switcher.js';
import { tokenName, type Theme } from './theme.js';

const OTHER_THEME: Theme = {
  id: 'paper',
  label: 'Paper',
  note: 'A second theme, so the switcher has something to switch',
  radius: '4px',
  dark: { ...METRUM_THEME.dark, accent: '#ff8800' },
  light: { ...METRUM_THEME.light, accent: '#8a4a00' },
};

/** The element the service paints. Read from the global rather than through
 *  `TestBed.inject(DOCUMENT)`, which would instantiate the test module before
 *  `configureTestingModule` has run — it is the same object either way. */
function root(): HTMLElement {
  return document.documentElement;
}

/** jsdom answers `matchMedia` with a stub that never matches, so "system" is
 *  light unless a test says otherwise. This replaces it for the ones that care. */
function stubPrefersDark(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe('contrast', () => {
  it('computes the WCAG ratio at its two anchors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#7ea8a1', '#7ea8a1')).toBeCloseTo(1, 5);
  });

  it('expands three-digit hex', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(relativeLuminance('#ffffff'), 10);
  });

  // Silently returning a number for a colour it cannot read would make every
  // audit pass by accident, which is the one failure mode that matters here.
  it('refuses a colour it cannot actually read', () => {
    expect(() => relativeLuminance('rgb(0 0 0)')).toThrow(/hex colour/);
  });
});

describe('the house theme', () => {
  it('is legible in both modes, on every ground', () => {
    expect(auditTheme(METRUM_THEME).map((failure) => failure.message)).toEqual([]);
  });

  // The dark half is the palette the workspace has been shipping. If it drifts,
  // the app and the artifact dashboard stop reading as one place.
  it('keeps the workspace palette verbatim in dark mode', () => {
    expect(METRUM_THEME.dark.bg).toBe('#0a1517');
    expect(METRUM_THEME.dark.accent).toBe('#2dd4bf');
    expect(METRUM_THEME.dark.text).toBe('#dcefeb');
  });
});

describe('token names', () => {
  // A near miss (`--surface2`) would leave every existing `var(--surface-2, …)`
  // silently falling back to its hardcoded default, in every component.
  it('match the properties the suite already consumes', () => {
    expect(tokenName('bg')).toBe('--bg');
    expect(tokenName('textDim')).toBe('--text-dim');
    expect(tokenName('surface1')).toBe('--surface-1');
    expect(tokenName('accent2')).toBe('--accent-2');
    expect(tokenName('onAccent')).toBe('--on-accent');
    expect(tokenName('dangerSoft')).toBe('--danger-soft');
  });
});

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    stubPrefersDark(true);
    TestBed.resetTestingModule();
    root().removeAttribute('style');
  });

  function boot(...providers: unknown[]) {
    TestBed.configureTestingModule({
      providers: [provideTheming(OTHER_THEME), ...(providers as [])],
    });
    return TestBed.inject(ThemeService);
  }

  it('offers the app theme first, then the house theme', () => {
    expect(boot().themes().map((theme) => theme.id)).toEqual(['paper', 'metrum']);
  });

  it('defaults to the app theme, following the system for mode', () => {
    const theming = boot();

    expect(theming.themeId()).toBe('paper');
    expect(theming.mode()).toBe('system');
    expect(theming.resolvedMode()).toBe('dark');
  });

  it('paints the root element before anything renders', () => {
    boot();

    // No component has been created — the environment initializer did this.
    expect(root().style.getPropertyValue('--accent')).toBe('#ff8800');
    expect(root().style.getPropertyValue('--text-dim')).toBe(METRUM_THEME.dark.textDim);
    expect(root().style.getPropertyValue('--radius')).toBe('4px');
    expect(root().getAttribute('data-theme')).toBe('paper');
  });

  // Without this, a light theme keeps dark native scrollbars, form controls and
  // caret — which is how a theme ends up looking broken rather than light.
  it('keeps color-scheme in step with the mode', () => {
    const theming = boot();
    expect(root().style.getPropertyValue('color-scheme')).toBe('dark');

    theming.setMode('light');

    expect(root().style.getPropertyValue('color-scheme')).toBe('light');
    expect(root().getAttribute('data-mode')).toBe('light');
  });

  it('swaps the whole palette when the mode changes', () => {
    const theming = boot();
    theming.setMode('light');

    expect(root().style.getPropertyValue('--accent')).toBe('#8a4a00');
    expect(root().style.getPropertyValue('--bg')).toBe(METRUM_THEME.light.bg);
  });

  it('swaps the whole palette when the theme changes', () => {
    const theming = boot();
    theming.setTheme('metrum');

    expect(theming.theme().id).toBe('metrum');
    expect(root().style.getPropertyValue('--accent')).toBe(METRUM_THEME.dark.accent);
  });

  it('ignores a theme it does not have', () => {
    const theming = boot();
    theming.setTheme('nonsense');

    expect(theming.themeId()).toBe('paper');
  });

  describe('persistence', () => {
    it('survives a reload', () => {
      const first = boot();
      first.setTheme('metrum');
      first.setMode('light');

      TestBed.resetTestingModule();
      root().removeAttribute('style');
      const second = boot();

      expect(second.themeId()).toBe('metrum');
      expect(second.mode()).toBe('light');
      expect(root().style.getPropertyValue('--accent')).toBe(METRUM_THEME.light.accent);
    });

    // An app can drop a theme between releases. Honouring the stored id would
    // boot into a palette that no longer exists.
    it('falls back when the stored theme is gone', () => {
      localStorage.setItem(
        'metrum-ui.theme:paper',
        JSON.stringify({ theme: 'retired', mode: 'light' }),
      );

      const theming = boot();

      expect(theming.themeId()).toBe('paper');
      // The mode half of the same record is still good and is still honoured.
      expect(theming.mode()).toBe('light');
    });

    it('shrugs off a corrupt record', () => {
      localStorage.setItem('metrum-ui.theme:paper', 'not json');

      expect(boot().themeId()).toBe('paper');
    });

    // Two apps on localhost in development must not overwrite each other.
    it('keys storage per app', () => {
      boot().setMode('light');

      expect(localStorage.getItem('metrum-ui.theme:paper')).toContain('"mode":"light"');
      expect(localStorage.getItem('metrum-ui.theme:metrum')).toBeNull();
    });
  });

  describe('system mode', () => {
    it('reads prefers-color-scheme rather than asking twice', () => {
      stubPrefersDark(false);

      expect(boot().resolvedMode()).toBe('light');
    });

    // An explicit choice is a choice, and the OS flipping at sunset must not
    // undo it.
    it('is not overridden by the OS once the user has picked', () => {
      stubPrefersDark(false);
      const theming = boot();
      theming.setMode('dark');

      expect(theming.resolvedMode()).toBe('dark');
      expect(root().style.getPropertyValue('--bg')).toBe(METRUM_THEME.dark.bg);
    });
  });

  // Rendering `ui-panel` in a test with no theme provider must not explode.
  it('works with no app theme at all', () => {
    TestBed.configureTestingModule({});
    const theming = TestBed.inject(ThemeService);

    expect(theming.themes().map((theme) => theme.id)).toEqual(['metrum']);
  });
});

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    stubPrefersDark(true);
    TestBed.resetTestingModule();
    root().removeAttribute('style');
  });

  async function render(providers: unknown[] = [provideTheming(OTHER_THEME)]) {
    TestBed.configureTestingModule({ imports: [ThemeSwitcher], providers: providers as [] });
    const fixture = TestBed.createComponent(ThemeSwitcher);
    await fixture.whenStable();
    return fixture;
  }

  it('offers every registered theme and shows the active one', async () => {
    const fixture = await render();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      'Paper',
      'Metrum Digital',
    ]);
    expect(select.value).toBe('paper');
  });

  /**
   * The restored case, and the reason the options carry `[selected]` rather than
   * the select carrying `[value]`.
   *
   * With `[value]` this passed on the default — the active theme happened to be
   * the first option — and failed the moment a stored choice pointed anywhere
   * else: the select's value is applied before `@for` has created the options, so
   * the browser resets to index 0 and the control reads "Paper" while the page is
   * painted Metrum. Caught in the browser, pinned here.
   */
  it('shows the restored theme and not the first one', async () => {
    localStorage.setItem(
      'metrum-ui.theme:paper',
      JSON.stringify({ theme: 'metrum', mode: 'dark' }),
    );

    const fixture = await render();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    expect(select.value).toBe('metrum');
    expect(select.selectedIndex).toBe(1);
  });

  it('changes the theme, and the page with it', async () => {
    const fixture = await render();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    select.value = 'metrum';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();

    expect(TestBed.inject(ThemeService).themeId()).toBe('metrum');
    expect(root().style.getPropertyValue('--accent')).toBe(METRUM_THEME.dark.accent);
  });

  it('shows all three modes and marks the live one', async () => {
    const fixture = await render();
    const buttons = [...fixture.nativeElement.querySelectorAll('.modes__button')] as HTMLElement[];

    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Light',
      'Dark',
      'System',
    ]);
    // "System" and not "Dark": the user's choice is the fact worth showing.
    expect(buttons.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent)
      .toContain('System');
  });

  it('switches mode on click', async () => {
    const fixture = await render();
    const light = fixture.nativeElement.querySelector('.modes__button') as HTMLElement;

    light.click();
    await fixture.whenStable();

    expect(TestBed.inject(ThemeService).mode()).toBe('light');
    expect(root().style.getPropertyValue('color-scheme')).toBe('light');
  });

  // A select with one option is a control that cannot do anything, and it is the
  // normal case for the first app to adopt this.
  it('hides the theme picker when there is only one theme', async () => {
    const fixture = await render([]);

    expect(fixture.nativeElement.querySelector('select')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.modes__button')).toHaveLength(3);
  });
});

/**
 * The one thing in this lib that is not a presentational component.
 *
 * ## Why a service is allowed here
 *
 * `panel.ts` states the rule this lib lives by — "no injected services, no HTTP,
 * no app state, no knowledge that Ledgerline exists" — and that rule is about
 * *components*. §2.2's actual constraint is on dependencies: `type:ui` may depend
 * only on `type:ui`, and this file depends on `@angular/core` and the DOM and
 * nothing else. It holds no domain object, issues no request, and would behave
 * identically in an app about weather.
 *
 * It has to be a service rather than a component because two unrelated places
 * need the same answer: the switcher renders the current choice, and the root
 * element has to be painted with it before anything renders at all. That is the
 * same argument `ReviewQueue` makes for the rail badge, one layer down.
 *
 * ## Why the DOM write is imperative and not an `effect`
 *
 * An `effect` runs after the next change detection pass. The palette has to be on
 * `:root` *before* the first paint, or the app flashes the stylesheet's fallback
 * values — which for a light-mode user is a full dark screen for one frame.
 * `provideTheming` constructs this service in an environment initializer, the
 * constructor applies immediately, and every setter re-applies. Deterministic,
 * and a test can assert the root element without pumping change detection.
 *
 * ## Why localStorage
 *
 * The choice is a per-device presentation preference, and it needs three things:
 * to be readable **synchronously at bootstrap** (an async read reintroduces the
 * flash), to survive a reload, and to stay put. `localStorage` is the only
 * browser store that gives all three.
 *
 * It deliberately does **not** go to the API. Ledgerline's SQLite file holds
 * statement data — §2.3 backs it up, exports it, and wipes it — and a scrollbar
 * colour has no business in a backup of someone's bank records, or in the JSON
 * they hand to an accountant. The key is namespaced per app so two apps served
 * from `localhost` in development do not overwrite each other's answer.
 */

import {
  DOCUMENT,
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';

import { METRUM_THEME } from './metrum.theme.js';
import { paletteFor, tokenName, type ResolvedMode, type Theme, type ThemeMode } from './theme.js';

export interface ThemingOptions {
  /** Further themes to offer beyond the house theme and the app's own. */
  readonly also?: readonly Theme[];
  /** localStorage namespace. Defaults to the app theme's id. */
  readonly storageKey?: string;
}

export interface ThemingConfig extends ThemingOptions {
  /** The app's own theme. Offered in the switcher, and the app's default. */
  readonly theme: Theme;
}

export const THEMING_CONFIG = new InjectionToken<ThemingConfig>('THEMING_CONFIG');

/** One key, one JSON value: two keys can be written apart and read back inconsistent. */
interface StoredChoice {
  readonly theme?: string;
  readonly mode?: string;
}

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  /**
   * Optional so the lib's own components can be rendered in a test — or in a
   * future app — without a theme provider. Without one there is exactly the house
   * theme, which is the same thing an app got before any of this existed.
   */
  private readonly config = inject(THEMING_CONFIG, { optional: true });

  private readonly registry = signal<readonly Theme[]>(
    this.config
      ? dedupeById([this.config.theme, METRUM_THEME, ...(this.config.also ?? [])])
      : [METRUM_THEME],
  );

  private readonly storageKey = `metrum-ui.theme:${this.config?.storageKey ?? this.config?.theme.id ?? 'metrum'}`;

  private readonly selectedId = signal<string>(this.config?.theme.id ?? METRUM_THEME.id);
  private readonly requestedMode = signal<ThemeMode>('system');
  private readonly systemPrefersDark = signal(false);

  /** Everything the switcher may offer, app theme first. */
  readonly themes = this.registry.asReadonly();
  readonly themeId = this.selectedId.asReadonly();
  /** What the user picked — including `system`, which is a choice and not a resolved value. */
  readonly mode = this.requestedMode.asReadonly();

  /** `system` resolved against `prefers-color-scheme`. What actually gets painted. */
  readonly resolvedMode = computed<ResolvedMode>(() => {
    const requested = this.requestedMode();
    if (requested !== 'system') return requested;
    return this.systemPrefersDark() ? 'dark' : 'light';
  });

  readonly theme = computed<Theme>(() => {
    const themes = this.registry();
    return themes.find((candidate) => candidate.id === this.selectedId()) ?? themes[0];
  });

  constructor() {
    const media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (media) {
      this.systemPrefersDark.set(media.matches);
      // `prefers-color-scheme` is the honest reading of "system": the OS already
      // knows, and asking it is cheaper and more correct than making the user say
      // it twice. The listener matters because the OS can flip at sunset while
      // the app is open.
      const onChange = (event: MediaQueryListEvent) => {
        this.systemPrefersDark.set(event.matches);
        this.apply();
      };
      media.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', onChange));
    }

    this.restore();
    this.apply();
  }

  setTheme(id: string): void {
    if (!this.registry().some((candidate) => candidate.id === id)) return;
    this.selectedId.set(id);
    this.persist();
    this.apply();
  }

  setMode(mode: ThemeMode): void {
    if (!MODES.includes(mode)) return;
    this.requestedMode.set(mode);
    this.persist();
    this.apply();
  }

  /**
   * Paint the root element.
   *
   * Custom properties go on `:root` rather than on a wrapper element because that
   * is where the stylesheet already declares its fallbacks, and because `body`'s
   * own background has to change too — a themed app inside an unthemed page is a
   * light card floating on a black margin.
   */
  private apply(): void {
    const root = this.document.documentElement;
    if (!root) return;

    const theme = this.theme();
    const mode = this.resolvedMode();
    const palette = paletteFor(theme, mode);

    for (const [key, value] of Object.entries(palette)) {
      root.style.setProperty(tokenName(key), value);
    }
    root.style.setProperty('--radius', theme.radius);

    // Kept in step with the palette, and not decoration: scrollbars, form
    // controls, spinners and the default text caret are painted by the browser
    // from this property alone. Without it a light theme gets dark native
    // scrollbars, which is how a theme ends up looking broken rather than light.
    root.style.setProperty('color-scheme', mode);

    // For anything that needs to branch in CSS rather than in a token — a
    // background image, a border treatment that only makes sense on paper.
    root.setAttribute('data-theme', theme.id);
    root.setAttribute('data-mode', mode);
  }

  /**
   * A stored choice that no longer makes sense is discarded rather than honoured.
   * An app can drop a theme between releases, and the alternative to falling back
   * is booting into a palette that does not exist.
   */
  private restore(): void {
    const raw = this.storage()?.getItem(this.storageKey);
    if (!raw) return;

    let stored: StoredChoice;
    try {
      stored = JSON.parse(raw) as StoredChoice;
    } catch {
      return;
    }

    if (stored.theme && this.registry().some((candidate) => candidate.id === stored.theme)) {
      this.selectedId.set(stored.theme);
    }
    if (stored.mode && (MODES as readonly string[]).includes(stored.mode)) {
      this.requestedMode.set(stored.mode as ThemeMode);
    }
  }

  private persist(): void {
    const choice: StoredChoice = { theme: this.selectedId(), mode: this.requestedMode() };
    try {
      this.storage()?.setItem(this.storageKey, JSON.stringify(choice));
    } catch {
      // Private browsing, a full quota, or a policy that blocks storage. The app
      // is entirely usable without a remembered choice, and refusing to render
      // over it would not be.
    }
  }

  /** Reading `localStorage` throws outright under some privacy settings, so even
   *  the lookup is guarded. */
  private storage(): Storage | null {
    try {
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * App theme first, house theme second, extras after — and never the same id twice.
 *
 * The order is the switcher's order, and it puts the app's own identity at the
 * top because that is what the app is. The dedupe is what lets an app register a
 * theme with the id `metrum`: it replaces the house one rather than sitting next
 * to a second entry with the same name.
 */
function dedupeById(themes: readonly Theme[]): readonly Theme[] {
  const seen = new Set<string>();
  const unique: Theme[] = [];

  for (const theme of themes) {
    if (seen.has(theme.id)) continue;
    seen.add(theme.id);
    unique.push(theme);
  }

  return unique;
}

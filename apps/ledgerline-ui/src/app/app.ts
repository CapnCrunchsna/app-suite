import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Panel } from '@metrum/ui';

/** Spec §6's eight sections, in spec order. */
const SECTIONS = [
  'Import',
  'Accounts',
  'Transactions',
  'Findings',
  'Subscriptions',
  'Insights',
  'Ask',
  'Settings',
] as const;

type Section = (typeof SECTIONS)[number];

/**
 * The app shell — header, section rail, content area. Wireframe only: §6's
 * pages are components in `libs/ledgerline/feature-shell`, and the rail becomes
 * `routerLink`s when `appRoutes` has something to point at.
 *
 * §2.2 keeps this a shell. The app may reach `type:feature`, `type:ui`,
 * `type:api-client` and `type:domain`, and talks to the API over HTTP only.
 */
@Component({
  selector: 'll-root',
  imports: [RouterOutlet, Panel],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly sections = SECTIONS;

  /** Stands in for the active route until there are routes. */
  protected readonly active = signal<Section>('Findings');

  /**
   * §6.8's persistent header indicator. `none` is the default provider, and the
   * only one that keeps every descriptor on this machine; the header says so
   * at all times rather than only in Settings. Reads `GET /api/settings` once
   * `@metrum/api-client` is generated.
   */
  protected readonly llmProvider = signal<'none' | 'claude-cli' | 'ollama'>(
    'none',
  );

  protected select(section: Section): void {
    this.active.set(section);
  }
}

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** Spec §6's eight sections, in spec order. `path` is null until the page exists —
 *  a rail item that routes nowhere is a link to a blank screen. */
const SECTIONS = [
  { label: 'Import', path: null },
  { label: 'Accounts', path: null },
  { label: 'Transactions', path: 'transactions' },
  { label: 'Findings', path: null },
  { label: 'Subscriptions', path: null },
  { label: 'Insights', path: null },
  { label: 'Ask', path: null },
  { label: 'Settings', path: null },
] as const;

/**
 * The app shell — header, section rail, content area.
 *
 * §2.2 keeps this a shell. The app may reach `type:feature`, `type:ui`,
 * `type:api-client` and `type:domain`, and talks to the API over HTTP only. §6's
 * pages are components in `libs/ledgerline/feature-shell`; this file knows their
 * names and their routes, and nothing about what they render.
 */
@Component({
  selector: 'll-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly sections = SECTIONS;

  /**
   * §6.8's persistent header indicator. `none` is the default provider, and the
   * only one that keeps every descriptor on this machine; the header says so
   * at all times rather than only in Settings. Reads `GET /api/settings` once that
   * endpoint exists.
   */
  protected readonly llmProvider = signal<'none' | 'claude-cli' | 'ollama'>('none');
}

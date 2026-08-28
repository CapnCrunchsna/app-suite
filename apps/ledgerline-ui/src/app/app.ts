import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ReviewQueue } from '@metrum/ledgerline-feature-shell';

/**
 * Spec §6's nine sections. `path` is null until the page exists — a rail item that
 * routes nowhere is a link to a blank screen.
 *
 * Spec order, with one deliberate exception. §6.9's Review is the newest section
 * and so the last one numbered, but it sits here with the three pages about *your
 * data* rather than under Settings, where it started and where it was buried
 * (§9s). Import, Accounts, Transactions, Review is also the order the work happens
 * in: the questions Review asks are the ones the import raised, and answering them
 * is what makes the analysis below it correct.
 */
const SECTIONS = [
  { label: 'Import', path: 'imports', badge: false },
  { label: 'Accounts', path: 'accounts', badge: false },
  { label: 'Transactions', path: 'transactions', badge: false },
  { label: 'Review', path: 'review', badge: true },
  { label: 'Findings', path: 'findings', badge: false },
  { label: 'Subscriptions', path: 'subscriptions', badge: false },
  { label: 'Insights', path: null, badge: false },
  { label: 'Ask', path: null, badge: false },
  { label: 'Settings', path: 'settings', badge: false },
] as const;

/**
 * The app shell — header, section rail, content area.
 *
 * §2.2 keeps this a shell. The app may reach `type:feature`, `type:ui`,
 * `type:api-client` and `type:domain`, and talks to the API over HTTP only. §6's
 * pages are components in `libs/ledgerline/feature-shell`; this file knows their
 * names and their routes, and nothing about what they render.
 *
 * The one exception is §6.9's badge, and it is an exception on purpose: the count
 * has to be here, because a queue you only find out about by opening the page is a
 * queue nobody opens. The shell still knows nothing about what a merge candidate
 * *is* — it renders a number that `ReviewQueue` owns, and that file argues why the
 * number lives there rather than on either screen that shows it.
 */
@Component({
  selector: 'll-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly reviewQueue = inject(ReviewQueue);

  protected readonly sections = SECTIONS;

  /** §6.9's rail badge: how many questions are waiting on an answer. */
  protected readonly reviewCount = this.reviewQueue.outstanding;

  /**
   * §6.8's persistent header indicator. `none` is the default provider, and the
   * only one that keeps every descriptor on this machine; the header says so
   * at all times rather than only in Settings. Reads `GET /api/settings` once that
   * endpoint exists.
   */
  protected readonly llmProvider = signal<'none' | 'claude-cli' | 'ollama'>('none');

  constructor() {
    // Read at startup, not on a timer. Nothing outside this UI writes an alias, so
    // the pages that change the count refresh it themselves; polling would spend a
    // request every few seconds to be told what they already know.
    void this.reviewQueue.ensureLoaded();
  }
}

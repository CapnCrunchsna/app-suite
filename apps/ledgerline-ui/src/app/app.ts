import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeSwitcher } from '@metrum/ui';
import { LedgerlineApiService, ReviewQueue } from '@metrum/ledgerline-feature-shell';

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
 * The header carries three things beyond the app's name: the theme and mode
 * switcher from `@metrum/ui`, §6.8's provider indicator, and the link home. All
 * three are chrome by the same test — they are true on every page, and putting
 * any of them on a page would make it false on the other nine.
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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ThemeSwitcher],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly reviewQueue = inject(ReviewQueue);
  private readonly api = inject(LedgerlineApiService);

  protected readonly sections = SECTIONS;

  /** §6.9's rail badge: how many questions are waiting on an answer. */
  protected readonly reviewCount = this.reviewQueue.outstanding;

  /**
   * §6.8's persistent header indicator: "While it's active, a persistent indicator
   * sits in the app header."
   *
   * Read from `GET /api/settings` rather than held as UI state, because the fact it
   * reports is a property of the *server* — the provider is a settings row, and a
   * second tab that changed it has changed it for this one too. `none` is the
   * default while the first read is in flight, which is both the true default and
   * the safe direction to be wrong in: the indicator never claims local when it is
   * not, only the reverse, and the reverse resolves within a request.
   *
   * `sendsDataOffMachine` drives the emphasis rather than a comparison against
   * `'claude-cli'`, for §2.4's reason: it is on the provider interface precisely so
   * that one fact has one source, and a UI that re-derived it would be the second.
   */
  private readonly settings = resource({
    params: () => 0,
    loader: () => this.api.getSettings(),
  });

  protected readonly llmProvider = computed(() => this.settings.value()?.llm.providerId ?? 'none');
  protected readonly sendsDataOffMachine = computed(
    () => this.settings.value()?.llm.sendsDataOffMachine ?? false,
  );

  constructor() {
    // Read at startup, not on a timer. Nothing outside this UI writes an alias, so
    // the pages that change the count refresh it themselves; polling would spend a
    // request every few seconds to be told what they already know.
    void this.reviewQueue.ensureLoaded();
  }
}

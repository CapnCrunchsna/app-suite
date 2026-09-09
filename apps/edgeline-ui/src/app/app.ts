import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeSwitcher } from '@metrum/ui';

import { SystemStatus } from './system-status.service';

/** §11.1's eight routes, in §11.1's order. */
interface Section {
  readonly label: string;
  readonly path: string;
}

const SECTIONS: readonly Section[] = [
  { label: 'Dashboard', path: 'dashboard' },
  { label: 'Opportunities', path: 'opportunities' },
  { label: 'Recommendations', path: 'recommendations' },
  { label: 'Results', path: 'results' },
  { label: 'Settings', path: 'settings' },
  { label: 'Sportsbooks', path: 'sportsbooks' },
  { label: 'Providers', path: 'providers' },
  { label: 'Matching', path: 'matching' },
];

/**
 * The app shell — header, section rail, content area.
 *
 * The header carries two things beyond the app's name and the theme switcher,
 * and both are here rather than on a page because both are true on all eight:
 * the PAPER badge (§16.2 — "visible on anything that looks like betting advice",
 * and every page here is that) and the alerting state, which is what makes an
 * engaged kill switch legible from the opportunities table rather than only from
 * the dashboard that engaged it.
 *
 * §16.1 is worth naming in the chrome and not just in a comment: nothing in this
 * app places a bet. The tagline says so on every screen, because a
 * configuration UI for a betting engine is exactly the thing a passer-by would
 * assume otherwise.
 */
@Component({
  selector: 'el-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ThemeSwitcher],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly status = inject(SystemStatus);

  protected readonly sections = SECTIONS;
  protected readonly paperMode = this.status.paperMode;
  protected readonly killSwitch = this.status.killSwitch;
  protected readonly failure = this.status.failure;

  constructor() {
    // Read at startup, not on a timer. The dashboard refreshes it when it polls
    // and the KILL button writes through the same service, so a heartbeat poll
    // here would be a second request to be told what those already know.
    void this.status.ensureLoaded();
  }
}

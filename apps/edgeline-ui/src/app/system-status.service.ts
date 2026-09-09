/**
 * `GET /api/system/health`, held once for the whole app.
 *
 * Two facts on it belong in the chrome rather than on a page, and both for the
 * same reason: they are true everywhere, so putting either on the dashboard
 * would make it false on the other seven screens.
 *
 * - **`paper_mode`.** §16.2 and §15's Phase 4 gate make this the most
 *   consequential flag in the system, and the brief for §11 is explicit that it
 *   "must be visible on anything that looks like betting advice". Every page
 *   here looks like betting advice.
 * - **`kill_switch`.** §3.2: "when true: polling continues, all alerting stops."
 *   That is the single most misreadable state the app can be in — the
 *   opportunities table keeps filling up while nothing is being sent — so the
 *   banner that explains it has to follow the reader onto the table.
 *
 * Held here rather than fetched per page so the dashboard's KILL/RESUME button
 * and the header badge cannot disagree: the button writes through this service,
 * so the header updates from the same value the dashboard just changed.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import type { HealthResponse } from '@metrum/edgeline-api-client';

import { EdgelineApiService } from './edgeline-api.service';

@Injectable({ providedIn: 'root' })
export class SystemStatus {
  private readonly api = inject(EdgelineApiService);

  private readonly state = signal<HealthResponse | null>(null);
  private readonly error = signal<Error | null>(null);
  private readonly busy = signal(false);
  private loaded = false;

  readonly health = this.state.asReadonly();
  /** Set when the API could not be reached. Every page renders it as "the
   *  engine is not running", never as an empty result. */
  readonly failure = this.error.asReadonly();
  /** True while a kill/resume request is in flight. */
  readonly pending = this.busy.asReadonly();

  /**
   * `true` until health says otherwise — including before the first read
   * lands.
   *
   * That is the direction §3.2's own default points (`paper_mode: true`) and the
   * one §15's Phase 4 gate has not yet moved: nobody has reviewed a CLV report,
   * so live is not a state this system is supposed to be in. Being briefly wrong
   * the other way would mean the header announcing live-money advice on evidence
   * it does not have.
   */
  readonly paperMode = computed(() => this.state()?.paper_mode !== false);
  readonly killSwitch = computed(() => this.state()?.kill_switch === true);
  readonly quota = computed(() => this.state()?.quota ?? []);
  readonly sportsEnabled = computed(() => this.state()?.sports_enabled ?? []);

  /**
   * §13 stamps `last_heartbeat_at` on the `runtime` document every 60 seconds,
   * so its age — not its existence — is what says the worker is alive.
   * `runtime` is an open map on the wire, hence the indexed read.
   */
  readonly lastHeartbeatAt = computed(() => readIsoField(this.state(), 'last_heartbeat_at'));
  readonly lastPollAt = computed(() => readIsoField(this.state(), 'last_poll_at'));
  readonly lastGradingAt = computed(() => readIsoField(this.state(), 'last_grading_at'));

  /** Read once per app load. Pages that change health call `refresh()`. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      this.state.set(await this.api.getHealth());
      this.error.set(null);
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /**
   * §3.2's kill switch, both ways.
   *
   * The response carries the new value, so the header flips from the write
   * rather than from a re-read — but a full `refresh()` follows anyway, because
   * `kill_switch` is not the only thing that changed: §12's daily loss stop can
   * set it too, and a reader who just resumed deserves to see the rest of health
   * as it is now.
   */
  async setKillSwitch(engaged: boolean): Promise<void> {
    this.busy.set(true);
    try {
      const response = engaged
        ? await this.api.engageKillSwitch()
        : await this.api.releaseKillSwitch();
      this.state.update((current) =>
        current ? { ...current, kill_switch: response.kill_switch } : current,
      );
      this.error.set(null);
      await this.refresh();
    } catch (cause) {
      this.error.set(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      this.busy.set(false);
    }
  }
}

function readIsoField(health: HealthResponse | null, key: string): string | null {
  const value = health?.runtime?.[key];
  return typeof value === 'string' ? value : null;
}

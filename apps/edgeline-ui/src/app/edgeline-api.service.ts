/**
 * The one seam between this app and the engine.
 *
 * §11.3 is a hard rule: "UI code imports ONLY from `libs/api-client` — no
 * hand-written `HttpClient` calls." `@metrum/edgeline-api-client` is a plain
 * `fetch` client with no Angular in it, so somebody has to make it injectable,
 * and this is the only file in the app that knows the transport exists. Every
 * method is a pass-through; the moment one starts reshaping a response it
 * becomes a second, undocumented API surface that drifts from `openapi.json` —
 * the exact failure the generation step exists to prevent.
 *
 * ## Why the base URL is empty, and what that means for `nx serve`
 *
 * §10's last line: "FastAPI serves the built Angular bundle as static files at
 * `/` in production mode." In production the UI and the API are one origin, so
 * the correct base URL is the empty string and every request is a same-origin
 * `/api/...`.
 *
 * Dev is the case that has to be made to match, and there are two ways to do it:
 *
 * - **Absolute URL + CORS**: the UI calls the engine's own host and port, and
 *   the engine allows the dev server's origin.
 * - **A dev-server proxy**, which is what this app does: `proxy.conf.json` sends
 *   `/api` to `127.0.0.1:8000`, so the browser only ever talks to `:4200`.
 *
 * The proxy wins because this API *does* serve the bundle: with CORS the app
 * would need one base URL in dev and a different one in production — a
 * build-time switch, and a class of bug that only shows up after a deploy. With
 * the proxy the string is `''` in both, and the FastAPI app needs no CORS
 * middleware at all, which is the safer default for a service bound to loopback.
 *
 * Ledgerline used to be the counter-example here and is not any more: its API
 * serves its bundle too (that spec's §9aj), for the same reasons and after the
 * CORS-only bug its §9ab records. Both apps now have one arrangement rather than
 * two.
 *
 * The token still exists so a test (or a second dev server) can point elsewhere
 * without editing this file.
 */

import { Injectable, InjectionToken, inject } from '@angular/core';
import { EdgelineApiClient } from '@metrum/edgeline-api-client';
import type {
  AdjustBody,
  BankrollResponse,
  BetRow,
  ConfirmBody,
  HealthResponse,
  KillSwitchResponse,
  LedgerEntry,
  OpportunityRow,
  ProviderPatch,
  ProviderRow,
  RecommendationRow,
  Settings,
  SportsbookPatch,
  SportsbookRow,
  SummaryResponse,
  UnmatchedRowResponse,
} from '@metrum/edgeline-api-client';

/** Same origin as the page. See the note above on why this is not `:8000`. */
export const EDGELINE_API_BASE_URL = new InjectionToken<string>('EDGELINE_API_BASE_URL');

@Injectable({ providedIn: 'root' })
export class EdgelineApiService {
  private readonly api = new EdgelineApiClient(
    (inject(EDGELINE_API_BASE_URL, { optional: true }) ?? '').replace(/\/$/, ''),
  );

  // §3.2's map. `updateSettings` is a patch — send only what changed.
  getSettings(): Promise<Settings> {
    return this.api.getSettings();
  }
  updateSettings(patch: Record<string, unknown>): Promise<Settings> {
    return this.api.updateSettings(patch);
  }

  listProviders(): Promise<ProviderRow[]> {
    return this.api.listProviders();
  }
  patchProvider(key: string, patch: ProviderPatch): Promise<ProviderRow> {
    return this.api.patchProvider(key, patch);
  }

  listSportsbooks(): Promise<SportsbookRow[]> {
    return this.api.listSportsbooks();
  }
  patchSportsbook(key: string, patch: SportsbookPatch): Promise<SportsbookRow> {
    return this.api.patchSportsbook(key, patch);
  }

  listOpportunities(query?: {
    status?: 'open' | 'alerted' | 'closed' | 'expired' | null;
    type?: 'ev' | 'arb' | null;
    limit?: number;
  }): Promise<OpportunityRow[]> {
    return this.api.listOpportunities(query);
  }

  listRecommendations(query?: {
    paper?: boolean | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  }): Promise<RecommendationRow[]> {
    return this.api.listRecommendations(query);
  }

  /**
   * §9.3's ✅ button, from the UI. Records that **a human placed a bet** —
   * `confirmed_via='ui'`. It does not place anything and cannot; §16.1 makes
   * that an architectural boundary rather than a missing feature.
   */
  confirmRecommendation(recommendationId: string, body: ConfirmBody): Promise<BetRow> {
    return this.api.confirmRecommendation(recommendationId, body);
  }

  getResultsSummary(query?: { group?: 'day' | 'week' }): Promise<SummaryResponse> {
    return this.api.getResultsSummary(query);
  }

  getBankroll(query?: { limit?: number }): Promise<BankrollResponse> {
    return this.api.getBankroll(query);
  }
  adjustBankroll(body: AdjustBody): Promise<LedgerEntry> {
    return this.api.adjustBankroll(body);
  }

  listUnmatched(query?: { resolved?: boolean; limit?: number }): Promise<UnmatchedRowResponse[]> {
    return this.api.listUnmatched(query);
  }
  resolveUnmatched(unmatchedId: string): Promise<UnmatchedRowResponse> {
    return this.api.resolveUnmatched(unmatchedId);
  }

  getHealth(): Promise<HealthResponse> {
    return this.api.getHealth();
  }
  engageKillSwitch(): Promise<KillSwitchResponse> {
    return this.api.engageKillSwitch();
  }
  releaseKillSwitch(): Promise<KillSwitchResponse> {
    return this.api.releaseKillSwitch();
  }
}

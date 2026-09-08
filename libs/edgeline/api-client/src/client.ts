// GENERATED — NEVER HAND-EDIT.
//
// Emitted by `tools/generate-edgeline-api-client.mjs` from
// `apps/edgeline-api/openapi.json` (spec §11.3). Hand edits are silently
// overwritten by the next generation run.
//
// To change anything here, change the FastAPI route that produces it, then:
//
//     npx nx run edgeline-api-client:generate-client

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
} from './types.js';

export interface RequestOptions {
  /** Overrides the client's base URL for a single call. */
  baseUrl?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Thrown for any non-2xx response, carrying the parsed body when there is one. */
export class EdgelineApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`${status} for ${url}`);
    this.name = 'EdgelineApiError';
  }
}

interface CallOptions extends RequestOptions {
  body?: unknown;
  query?: Record<string, unknown>;
}

export class EdgelineApiClient {
  constructor(private readonly baseUrl = '') {}

  private async request<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const base = options.baseUrl ?? this.baseUrl;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const query = search.toString();
    const url = `${base}${path}${query ? `?${query}` : ''}`;

    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(url, {
      method,
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new EdgelineApiError(response.status, url, parsed);
    return parsed as T;
  }

  /** Read Settings */
  async getSettings(options?: RequestOptions): Promise<Settings> {
    return this.request<Settings>(
      "GET",
      `/api/settings`,
      { ...options },
    );
  }

  /** Update Settings */
  async updateSettings(body: Record<string, unknown>, options?: RequestOptions): Promise<Settings> {
    return this.request<Settings>(
      "PUT",
      `/api/settings`,
      { body, ...options },
    );
  }

  /** List Providers */
  async listProviders(options?: RequestOptions): Promise<ProviderRow[]> {
    return this.request<ProviderRow[]>(
      "GET",
      `/api/providers`,
      { ...options },
    );
  }

  /** Patch Provider */
  async patchProvider(key: string, body: ProviderPatch, options?: RequestOptions): Promise<ProviderRow> {
    return this.request<ProviderRow>(
      "PATCH",
      `/api/providers/${encodeURIComponent(String(key))}`,
      { body, ...options },
    );
  }

  /** List Sportsbooks */
  async listSportsbooks(options?: RequestOptions): Promise<SportsbookRow[]> {
    return this.request<SportsbookRow[]>(
      "GET",
      `/api/sportsbooks`,
      { ...options },
    );
  }

  /** Patch Sportsbook */
  async patchSportsbook(key: string, body: SportsbookPatch, options?: RequestOptions): Promise<SportsbookRow> {
    return this.request<SportsbookRow>(
      "PATCH",
      `/api/sportsbooks/${encodeURIComponent(String(key))}`,
      { body, ...options },
    );
  }

  /** List Opportunities */
  async listOpportunities(query?: {
    "status"?: "open" | "alerted" | "closed" | "expired" | null;
    "type"?: "ev" | "arb" | null;
    "limit"?: number;
  }, options?: RequestOptions): Promise<OpportunityRow[]> {
    return this.request<OpportunityRow[]>(
      "GET",
      `/api/opportunities`,
      { query, ...options },
    );
  }

  /** List Recommendations */
  async listRecommendations(query?: {
    "paper"?: boolean | null;
    "from"?: string | null;
    "to"?: string | null;
    "limit"?: number;
  }, options?: RequestOptions): Promise<RecommendationRow[]> {
    return this.request<RecommendationRow[]>(
      "GET",
      `/api/recommendations`,
      { query, ...options },
    );
  }

  /** Confirm */
  async confirmRecommendation(recommendationId: string, body: ConfirmBody, options?: RequestOptions): Promise<BetRow> {
    return this.request<BetRow>(
      "POST",
      `/api/recommendations/${encodeURIComponent(String(recommendationId))}/confirm`,
      { body, ...options },
    );
  }

  /** Summary */
  async getResultsSummary(query?: {
    "group"?: "day" | "week";
  }, options?: RequestOptions): Promise<SummaryResponse> {
    return this.request<SummaryResponse>(
      "GET",
      `/api/results/summary`,
      { query, ...options },
    );
  }

  /** Read Bankroll */
  async getBankroll(query?: {
    "limit"?: number;
  }, options?: RequestOptions): Promise<BankrollResponse> {
    return this.request<BankrollResponse>(
      "GET",
      `/api/bankroll`,
      { query, ...options },
    );
  }

  /** Adjust */
  async adjustBankroll(body: AdjustBody, options?: RequestOptions): Promise<LedgerEntry> {
    return this.request<LedgerEntry>(
      "POST",
      `/api/bankroll/adjust`,
      { body, ...options },
    );
  }

  /** List Unmatched */
  async listUnmatched(query?: {
    "resolved"?: boolean;
    "limit"?: number;
  }, options?: RequestOptions): Promise<UnmatchedRowResponse[]> {
    return this.request<UnmatchedRowResponse[]>(
      "GET",
      `/api/matching`,
      { query, ...options },
    );
  }

  /** Resolve */
  async resolveUnmatched(unmatchedId: string, options?: RequestOptions): Promise<UnmatchedRowResponse> {
    return this.request<UnmatchedRowResponse>(
      "POST",
      `/api/matching/${encodeURIComponent(String(unmatchedId))}/resolve`,
      { ...options },
    );
  }

  /** Health */
  async getHealth(options?: RequestOptions): Promise<HealthResponse> {
    return this.request<HealthResponse>(
      "GET",
      `/api/system/health`,
      { ...options },
    );
  }

  /** Kill */
  async engageKillSwitch(options?: RequestOptions): Promise<KillSwitchResponse> {
    return this.request<KillSwitchResponse>(
      "POST",
      `/api/system/kill`,
      { ...options },
    );
  }

  /** Resume */
  async releaseKillSwitch(options?: RequestOptions): Promise<KillSwitchResponse> {
    return this.request<KillSwitchResponse>(
      "POST",
      `/api/system/resume`,
      { ...options },
    );
  }
}

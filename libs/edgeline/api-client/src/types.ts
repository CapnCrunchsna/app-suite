// GENERATED — NEVER HAND-EDIT.
//
// Emitted by `tools/generate-edgeline-api-client.mjs` from
// `apps/edgeline-api/openapi.json` (spec §11.3). Hand edits are silently
// overwritten by the next generation run.
//
// To change anything here, change the FastAPI route that produces it, then:
//
//     npx nx run edgeline-api-client:generate-client

export interface AdjustBody {
  book_key: string;
  delta_cents: number;
  reason?: "deposit" | "withdrawal" | "manual_adjust";
}

export interface BankrollResponse {
  total_cents: number;
  by_book?: BookBalance[];
  entries?: LedgerEntry[];
}

export interface BetRow {
  id: string;
  recommendation_id: string;
  confirmed_via: string;
  stake_actual_cents: number;
  odds_actual_decimal: number;
  placed_at: string;
}

export interface BookBalance {
  book_key: string;
  balance_cents: number;
}

/** What the human actually got on the book. */
export interface ConfirmBody {
  stake_actual_cents: number;
  odds_actual_decimal: number;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}

export interface HealthResponse {
  paper_mode: boolean;
  kill_switch: boolean;
  offline_mode?: boolean;
  runtime?: Record<string, unknown>;
  quota?: QuotaRow[];
  sports_enabled?: string[];
}

export interface KillSwitchResponse {
  kill_switch: boolean;
}

export interface LedgerEntry {
  id: string;
  book_key: string;
  delta_cents: number;
  reason: string;
  ref_result_id?: string;
  "@timestamp": string;
}

export interface OpportunityLegRow {
  book_key: string;
  selection: string;
  line?: number | null;
  price_decimal: number;
  devig_prob?: number | null;
  staleness?: number | null;
  bet_first?: boolean;
}

export interface OpportunityRow {
  id: string;
  type: string;
  event_id: string;
  market_key: string;
  legs?: OpportunityLegRow[];
  edge_pct: number;
  status: string;
  detected_at: string;
  expires_at?: string | null;
  closed_at?: string | null;
  closing_edge_pct?: number | null;
}

export interface ProviderPatch {
  display_name?: string | null;
  enabled?: boolean | null;
  quota_budget?: number | null;
  config?: Record<string, unknown> | null;
}

export interface ProviderRow {
  id: string;
  display_name?: string | null;
  enabled?: boolean | null;
  quota_used?: number | null;
  quota_budget?: number | null;
  quota_reset_at?: string | null;
  config?: Record<string, unknown> | null;
}

export interface QuotaRow {
  provider: string;
  quota_used?: number | null;
  quota_budget?: number | null;
  quota_reset_at?: string | null;
}

export interface RecommendationRow {
  id: string;
  opportunity_id: string;
  stakes?: Record<string, unknown>;
  paper: boolean;
  channel: string;
  sent_at: string;
  message_ref?: string | null;
  opportunity?: OpportunityRow | null;
  result?: ResultRow | null;
}

export interface ResultRow {
  bet_id?: string;
  outcome: string;
  pnl_cents: number;
  clv_pct?: number | null;
  needs_manual?: boolean;
  graded_at: string;
}

/** The complete §3.2 default set, typed, with the spec's defaults verbatim. */
export interface Settings {
  paper_mode?: boolean;
  kill_switch?: boolean;
  offline_mode?: boolean;
  kelly_fraction?: number;
  bankroll_start_cents?: number;
  ev_threshold_pct?: number;
  min_edge_to_bet_pct?: number;
  min_books_for_consensus?: number;
  arb_min_profit_pct?: number;
  max_stake_cents?: number;
  max_stake_pct?: number;
  daily_exposure_cap_cents?: number;
  daily_loss_stop_cents?: number;
  stake_rounding_cents?: number;
  devig_method?: "multiplicative" | "additive" | "power" | "shin";
  consensus_weights?: Record<string, number>;
  staleness_sigma_floor?: number;
  edge_improve_delta_pct?: number;
  alert_cooldown_s?: number;
  sports_enabled?: string[];
  markets_featured?: string[];
  markets_props?: string[];
  regions?: string[];
  poll_interval_s?: number;
  poll_interval_dev_s?: number;
  props_poll_interval_s?: number;
  closing_capture_offset_s?: number;
  closing_capture_mode?: "off" | "recommended" | "all";
  quota_monthly_budget?: number;
}

/** Every field optional — this is a patch, not a replacement. */
export interface SportsbookPatch {
  display_name?: string | null;
  enabled?: boolean | null;
  md_licensed?: boolean | null;
  priority?: number | null;
  link_templates?: Record<string, unknown> | null;
}

export interface SportsbookRow {
  id: string;
  display_name?: string | null;
  enabled?: boolean;
  md_licensed?: boolean | null;
  priority?: number | null;
  link_templates?: Record<string, unknown>;
}

export interface SummaryBucket {
  key: string;
  graded: number;
  pnl_cents: number;
  avg_clv_pct?: number | null;
  wins: number;
  settled: number;
  hit_rate?: number | null;
  executed: number;
  executed_pnl_cents: number;
  paper: number;
  needs_manual: number;
}

export interface SummaryResponse {
  group: string;
  buckets?: SummaryBucket[];
  totals: SummaryTotals;
}

export interface SummaryTotals {
  graded: number;
  pnl_cents: number;
  avg_clv_pct?: number | null;
  wins?: number;
  settled?: number;
  hit_rate?: number | null;
}

export interface UnmatchedRowResponse {
  id: string;
  provider_key: string;
  raw?: Record<string, unknown>;
  reason: string;
  resolved: boolean;
  created_at: string;
}

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

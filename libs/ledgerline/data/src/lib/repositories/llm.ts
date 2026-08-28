/**
 * The three tables §2.4 and §4.2 write: `llm_cache`, `llm_degraded_call` and
 * `llm_proposal` (§3.1, migration 006).
 *
 * This repository stores and returns rows. It does not know what a provider is,
 * what a prompt costs, or when a cached answer is worth reusing — `type:data-access`
 * may depend on `type:domain` and nothing else (§2.2), so it cannot reach `llm`
 * even to name its types. The composition root owns those decisions and hands the
 * results here, exactly as it does for the §4 chain.
 *
 * That boundary is why the cache is a *store* here and a *wrapper* in
 * `apps/ledgerline-api/src/lib/llm-service.ts`: the key is
 * `sha256(provider + model + prompt)` (§2.4), which is a fact about a call, and a
 * call is something only the app knows how to make.
 */

import { newStamp } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

export interface LlmCacheEntry {
  readonly promptSha256: string;
  readonly provider: string;
  readonly model: string;
  readonly responseJson: string;
  readonly createdAt: string;
}

export interface DegradedCallInput {
  /** The event's own time, from `llmAssist`. Not `created_at` — see migration 006. */
  readonly at: string;
  readonly provider: string;
  readonly operation: string;
  readonly reason: string;
}

export interface DegradedCallRecord extends DegradedCallInput {
  readonly id: string;
}

export type LlmProposalStatus = 'pending' | 'applied' | 'blocked' | 'rejected';

export interface LlmProposalInput {
  readonly descriptor: string;
  readonly merchantName: string;
  readonly categoryName: string | null;
  readonly confidence: number;
  readonly status: LlmProposalStatus;
  readonly blockedReason: string | null;
  readonly provider: string;
  readonly model: string;
}

export interface LlmProposalRecord extends LlmProposalInput {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CacheRow {
  prompt_sha256: string;
  provider: string;
  model: string;
  response_json: string;
  created_at: string;
}

interface DegradedRow {
  id: string;
  at: string;
  provider: string;
  operation: string;
  reason: string;
}

interface ProposalRow {
  id: string;
  descriptor: string;
  merchant_name: string;
  category_name: string | null;
  confidence: number;
  status: LlmProposalStatus;
  blocked_reason: string | null;
  provider: string;
  model: string;
  created_at: string;
  updated_at: string;
}

const SELECT_PROPOSAL = `SELECT id, descriptor, merchant_name, category_name, confidence, status,
                                blocked_reason, provider, model, created_at, updated_at
                           FROM llm_proposal`;

function toProposal(row: ProposalRow): LlmProposalRecord {
  return {
    id: row.id,
    descriptor: row.descriptor,
    merchantName: row.merchant_name,
    categoryName: row.category_name,
    confidence: row.confidence,
    status: row.status,
    blockedReason: row.blocked_reason,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LlmRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------- cache ---

  /**
   * §2.4: "Every call is keyed by `sha256(provider + model + prompt)` into
   * `llm_cache`."
   *
   * The key alone, with no expiry and no provider filter in the lookup. The
   * provider and model are already *inside* the hash, so a row can only be found
   * by the call that would have produced it — which is what makes §2.4's second
   * claim true, that caching "makes runs reproducible". A TTL would make the same
   * run return different answers on different days, which is the property being
   * bought.
   */
  getCached(promptSha256: string): LlmCacheEntry | null {
    const row = this.db
      .prepare<[string], CacheRow>(
        `SELECT prompt_sha256, provider, model, response_json, created_at
           FROM llm_cache WHERE prompt_sha256 = ?`,
      )
      .get(promptSha256);

    return row
      ? {
          promptSha256: row.prompt_sha256,
          provider: row.provider,
          model: row.model,
          responseJson: row.response_json,
          createdAt: row.created_at,
        }
      : null;
  }

  putCached(entry: Omit<LlmCacheEntry, 'createdAt'>): void {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO llm_cache (id, prompt_sha256, provider, model, response_json,
                                created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (prompt_sha256) DO UPDATE SET
           response_json = excluded.response_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        stamp.id,
        entry.promptSha256,
        entry.provider,
        entry.model,
        entry.responseJson,
        stamp.createdAt,
        stamp.updatedAt,
      );
  }

  countCached(): number {
    return (
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM llm_cache').get()?.n ?? 0
    );
  }

  // --------------------------------------------------- degraded calls ---

  recordDegraded(input: DegradedCallInput): void {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO llm_degraded_call (id, at, provider, operation, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp.id,
        input.at,
        input.provider,
        input.operation,
        input.reason,
        stamp.createdAt,
        stamp.updatedAt,
      );
  }

  /**
   * Newest first, capped.
   *
   * §6.8 shows this in the Data section, where the reader's question is "has my
   * provider been failing?" — which the last few dozen events answer and the
   * whole history does not. `countDegraded` carries the rest of the answer, so a
   * capped list never has to pretend it is the total.
   */
  listDegraded(limit = 50): DegradedCallRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    return this.db
      .prepare<[number], DegradedRow>(
        `SELECT id, at, provider, operation, reason
           FROM llm_degraded_call ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(bounded)
      .map((row) => ({
        id: row.id,
        at: row.at,
        provider: row.provider,
        operation: row.operation,
        reason: row.reason,
      }));
  }

  countDegraded(): number {
    return (
      this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM llm_degraded_call').get()?.n ??
      0
    );
  }

  // --------------------------------------------------------- proposals ---

  /**
   * One live proposal per descriptor (§4.1 step 7 asks each question once).
   *
   * A `rejected` row is never overwritten. §4.3 puts a user decision above every
   * other source and calls it permanent; a re-run that re-proposed something the
   * user has already declined would be a model quietly overruling them one
   * afternoon later, which is the same failure the alias precedence exists to
   * prevent. Returns the row as it stands afterwards, so a caller can see that it
   * did not win.
   */
  upsertProposal(input: LlmProposalInput): LlmProposalRecord {
    const existing = this.getProposal(input.descriptor);
    if (existing?.status === 'rejected') return existing;

    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO llm_proposal (id, descriptor, merchant_name, category_name, confidence,
                                   status, blocked_reason, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (descriptor) DO UPDATE SET
           merchant_name = excluded.merchant_name,
           category_name = excluded.category_name,
           confidence = excluded.confidence,
           status = excluded.status,
           blocked_reason = excluded.blocked_reason,
           provider = excluded.provider,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(
        stamp.id,
        input.descriptor,
        input.merchantName,
        input.categoryName,
        input.confidence,
        input.status,
        input.blockedReason,
        input.provider,
        input.model,
        stamp.createdAt,
        stamp.updatedAt,
      );

    return this.getProposal(input.descriptor) as LlmProposalRecord;
  }

  getProposal(descriptor: string): LlmProposalRecord | null {
    const row = this.db
      .prepare<[string], ProposalRow>(`${SELECT_PROPOSAL} WHERE descriptor = ?`)
      .get(descriptor);
    return row ? toProposal(row) : null;
  }

  getProposalById(id: string): LlmProposalRecord | null {
    const row = this.db.prepare<[string], ProposalRow>(`${SELECT_PROPOSAL} WHERE id = ?`).get(id);
    return row ? toProposal(row) : null;
  }

  /** Most confident first: the queue's job is to put the answerable questions in
   *  front of a person, and a 0.8 proposal is a better use of their attention
   *  than a 0.4 one. */
  listProposals(statuses?: readonly LlmProposalStatus[]): LlmProposalRecord[] {
    if (!statuses) {
      return this.db
        .prepare<[], ProposalRow>(`${SELECT_PROPOSAL} ORDER BY confidence DESC, descriptor`)
        .all()
        .map(toProposal);
    }
    if (statuses.length === 0) return [];

    const placeholders = statuses.map(() => '?').join(', ');
    return this.db
      .prepare<string[], ProposalRow>(
        `${SELECT_PROPOSAL} WHERE status IN (${placeholders}) ORDER BY confidence DESC, descriptor`,
      )
      .all(...statuses)
      .map(toProposal);
  }

  setProposalStatus(id: string, status: LlmProposalStatus): LlmProposalRecord | null {
    this.db
      .prepare('UPDATE llm_proposal SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.clock.now(), id);
    return this.getProposalById(id);
  }
}

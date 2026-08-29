/**
 * §5.1's finding lifecycle, and the two tables §3.1 keeps apart on purpose.
 *
 * ## The lifecycle is an upsert, and `last_run_id` is what makes the sweep exact
 *
 * §5.1: "Findings are **upserted by natural key**, so user state survives every
 * re-run. A finding present in the previous run but absent from the current one
 * becomes `resolved` rather than being deleted — 'this stopped being true' is
 * itself information."
 *
 * `applyRun` does both halves in one transaction. The upsert is
 * `ON CONFLICT (natural_key)`, which §3.2's UNIQUE index exists to make possible,
 * and it stamps `last_run_id` with the run that produced it. The sweep is then
 * every row this run did **not** stamp — no set difference computed in
 * JavaScript, no second pass over ids, and no way for a row to be missed because
 * the caller forgot to mention it.
 *
 * `first_detected_at` is the one column the upsert never overwrites. It is the
 * age of the *problem*, not of the row, and re-stamping it every run would erase
 * the only evidence that a finding has been ignored for four months.
 *
 * ## `finding_state` versus `dismissal_rule`
 *
 * §3.1: "the design session put all three dismissal scopes in one table keyed by
 * finding natural key, but 'dismiss this rule for this merchant' and 'dismiss this
 * rule' are not findings and have no natural key. They are separate concerns and
 * are now separate tables: `finding_state` is per-finding user state,
 * `dismissal_rule` is a standing filter applied at emit time."
 *
 * The consequence worth naming: **`finding_state` is keyed on the natural key, not
 * on the finding's surrogate id**, so it is not a child of the row it describes.
 * A finding that resolves, disappears for six months and comes back keeps the
 * dismissal that was recorded against it, which is the behaviour §5.1's evidence
 * hash is written to depend on. Nothing here deletes a `finding_state` row when
 * its finding resolves.
 *
 * A standing `dismissal_rule` is applied by the caller, not here: matching one
 * needs to know which merchant a *series* finding is about, and only the
 * composition root holds the series. What this file owns is the verdict —
 * `status = 'suppressed'` — and the read paths that honour it.
 */

import { newStamp, asInt } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

/**
 * Where a finding is in §5.1's run lifecycle. Distinct from the user's own
 * verdict, which lives in `finding_state`, because they answer different
 * questions: this one is "does the data still say this", that one is "have you
 * dealt with it".
 *
 * `suppressed` is the third state a standing `dismissal_rule` produces. It is not
 * `resolved`: the run *did* produce the finding and its numbers are current, the
 * user has simply said they never want to hear about this rule (or this rule at
 * this merchant) again. Collapsing the two would make deleting a dismissal rule
 * indistinguishable from a subscription coming back.
 */
export type FindingLifecycleStatus = 'active' | 'resolved' | 'suppressed';

/** §5.1 and §6.4's per-card actions. */
export type FindingUserStatus = 'acknowledged' | 'snoozed' | 'dismissed';

export type FindingImpactKind = 'savings' | 'visibility';
export type FindingBand = 'high' | 'medium' | 'low' | 'suppressed';

/** §5.1's other two dismissal scopes. `merchant_rule` carries a merchant;
 *  `rule` does not, and §3.1's CHECK constraint enforces that pairing. */
export type DismissalScope = 'merchant_rule' | 'rule';

/**
 * One finding as the composition root hands it over.
 *
 * Restated rather than imported from `analyzers` for the reason §2.2 gives —
 * `type:data-access` may depend on `type:domain` and nothing else — and the
 * restatement earns its keep twice over. `evidenceTransactionIds` arrives as bare
 * ids because a rule has no idea which account a transaction belongs to, and
 * `finding_evidence` needs one (§3.1); resolving that is this file's job. And
 * `status` arrives already decided, because the standing-rule filter is the
 * caller's.
 */
export interface FindingInput {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly naturalKey: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  /** The rule's structured payload, already serialized. `data` may not name an
   *  analyzer's types, and a finding detail is a different shape per rule. */
  readonly detailJson: string;
  readonly confidence: number;
  readonly band: FindingBand;
  readonly impactKind: FindingImpactKind;
  readonly impactMonthlyCents: number;
  readonly impactAnnualCents: number;
  readonly llmDependent: boolean;
  readonly evidenceHash: string;
  readonly evidenceTransactionIds: readonly string[];
  readonly status: FindingLifecycleStatus;
}

export interface FindingRecord {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly naturalKey: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
  readonly detailJson: string;
  readonly confidence: number;
  readonly band: FindingBand;
  readonly impactKind: FindingImpactKind;
  readonly impactMonthlyCents: number;
  readonly impactAnnualCents: number;
  readonly llmDependent: boolean;
  readonly evidenceHash: string;
  /** When this finding was *first* seen, never re-stamped (see the header). */
  readonly firstDetectedAt: string;
  readonly lastRunId: string | null;
  readonly status: FindingLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FindingStateRecord {
  readonly id: string;
  readonly naturalKey: string;
  readonly status: FindingUserStatus;
  readonly reason: string | null;
  readonly snoozeUntil: string | null;
  /** §5.1: "Dismissing a single finding stores its `evidence_hash`." */
  readonly dismissedEvidenceHash: string | null;
  /** The config in force when it was dismissed, so §5.1's second resurfacing
   *  reason can be told from the first (migration 002). */
  readonly dismissedConfigHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DismissalRuleRecord {
  readonly id: string;
  readonly scope: DismissalScope;
  readonly ruleId: string;
  readonly merchantId: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A finding with the user state recorded against its natural key, and the
 *  evidence rows that back it. One shape, because every read path needs all
 *  three and joining them at the call site is how they come apart. */
export interface FindingView {
  readonly finding: FindingRecord;
  readonly state: FindingStateRecord | null;
  readonly evidenceTransactionIds: readonly string[];
}

/**
 * What a user-facing list is allowed to hide.
 *
 * `visible` is the default a page wants: everything except a dismissal that is
 * still honest and a snooze that has not run out. The predicate is in SQL rather
 * than a filter over a loaded page because it has to compose with `LIMIT` — a
 * page of 25 that then drops the dismissed ones is a page of 19 with a "25 of
 * 120" counter beside it.
 */
export type FindingVisibility = 'visible' | 'hidden' | 'all';

export interface FindingQuery {
  readonly ruleIds?: readonly string[];
  readonly bands?: readonly FindingBand[];
  readonly statuses?: readonly FindingLifecycleStatus[];
  /**
   * The user's own verdict, from `finding_state` — a different question from
   * `statuses` (§5.1: "does the data still say this" versus "have you dealt with it").
   *
   * `visibility: 'hidden'` is the near neighbour and is not a substitute: it returns
   * dismissed *and* snoozed together, and §6.8's re-evaluation warning is about
   * dismissals specifically. A snooze expires on its own; a dismissal is what §5.1
   * reopens when `config_hash` moves, so counting the two as one would overstate what
   * changing a threshold disturbs.
   */
  readonly userStatuses?: readonly FindingUserStatus[];
  readonly impactKind?: FindingImpactKind;
  /** Through `finding_evidence` — §6.4's account filter. A finding is "on" an
   *  account when any of its evidence is. */
  readonly accountIds?: readonly string[];
  readonly minAnnualImpactCents?: number;
  readonly visibility?: FindingVisibility;
  /** Evaluated against `snooze_until`; the caller supplies it so a test can. */
  readonly now?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface FindingPage {
  readonly rows: readonly FindingView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** §6.4's top strip, minus the subscription half, which is `recurring_series`'
 *  to answer (`AnalysisRepository.seriesTotals`). */
export interface FindingTotals {
  /** §5.1 and §7.3: **only `savings` sums.** A visibility finding is money
   *  already being spent knowingly and adding it here would double-count the
   *  same transactions the savings findings describe. */
  readonly savingsAnnualCents: number;
  readonly savingsMonthlyCents: number;
  readonly activeCount: number;
  /** No `finding_state` row at all — never acknowledged, snoozed or dismissed. */
  readonly unreviewedCount: number;
  readonly countsByRule: Readonly<Record<string, number>>;
  readonly countsByBand: Readonly<Record<string, number>>;
}

export interface ApplyRunInput {
  readonly runId: string;
  /** Every finding this run emitted, each already carrying the verdict a
   *  standing `dismissal_rule` produced. */
  readonly findings: readonly FindingInput[];
}

export interface ApplyRunResult {
  readonly inserted: number;
  readonly updated: number;
  /** Present in a previous run, absent from this one (§5.1). */
  readonly resolved: number;
  readonly suppressed: number;
  readonly evidenceRows: number;
}

interface FindingRow {
  id: string;
  rule_id: string;
  rule_version: string;
  config_hash: string;
  natural_key: string;
  subject_type: string;
  subject_id: string;
  title: string;
  detail_json: string;
  confidence: string;
  band: FindingBand;
  impact_kind: FindingImpactKind;
  impact_monthly_cents: number;
  impact_annual_cents: number;
  llm_dependent: number;
  evidence_hash: string;
  first_detected_at: string;
  last_run_id: string | null;
  status: FindingLifecycleStatus;
  created_at: string;
  updated_at: string;
}

interface FindingStateRow {
  id: string;
  natural_key: string;
  status: FindingUserStatus;
  reason: string | null;
  snooze_until: string | null;
  dismissed_evidence_hash: string | null;
  dismissed_config_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface DismissalRuleRow {
  id: string;
  scope: DismissalScope;
  rule_id: string;
  merchant_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

const FINDING_COLUMNS = `id, rule_id, rule_version, config_hash, natural_key, subject_type,
                         subject_id, title, detail_json, confidence, band, impact_kind,
                         impact_monthly_cents, impact_annual_cents, llm_dependent, evidence_hash,
                         first_detected_at, last_run_id, status, created_at, updated_at`;

const SELECT_FINDING = `SELECT ${FINDING_COLUMNS} FROM finding`;

const SELECT_STATE = `SELECT id, natural_key, status, reason, snooze_until,
                             dismissed_evidence_hash, dismissed_config_hash, created_at, updated_at
                        FROM finding_state`;

const SELECT_DISMISSAL = `SELECT id, scope, rule_id, merchant_id, reason, created_at, updated_at
                            FROM dismissal_rule`;

/**
 * §3.1 declares `finding.confidence` and `recurring_series.confidence` as TEXT,
 * so SQLite's TEXT affinity stores the number as its decimal string. The round
 * trip is exact — JavaScript's `String(number)` is the shortest form that parses
 * back to the same double — but it is a conversion, and doing it in one place is
 * what stops a caller comparing `"0.85" > 0.8` and getting the wrong answer.
 */
const toConfidence = (value: string): number => Number(value);

function toFinding(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    configHash: row.config_hash,
    naturalKey: row.natural_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    title: row.title,
    detailJson: row.detail_json,
    confidence: toConfidence(row.confidence),
    band: row.band,
    impactKind: row.impact_kind,
    impactMonthlyCents: row.impact_monthly_cents,
    impactAnnualCents: row.impact_annual_cents,
    llmDependent: row.llm_dependent === 1,
    evidenceHash: row.evidence_hash,
    firstDetectedAt: row.first_detected_at,
    lastRunId: row.last_run_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toState(row: FindingStateRow): FindingStateRecord {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    status: row.status,
    reason: row.reason,
    snoozeUntil: row.snooze_until,
    dismissedEvidenceHash: row.dismissed_evidence_hash,
    dismissedConfigHash: row.dismissed_config_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDismissalRule(row: DismissalRuleRow): DismissalRuleRecord {
  return {
    id: row.id,
    scope: row.scope,
    ruleId: row.rule_id,
    merchantId: row.merchant_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * §5.1's "is this still hidden" test, as one SQL predicate over `finding f` and
 * `finding_state fs`.
 *
 * Two ways a finding stays out of the user's way, and both are conditional on
 * nothing having changed:
 *
 * - **Dismissed**, while the evidence hash it was dismissed under still matches.
 *   "if the price changes or a lapsed series resumes, the hash changes and the
 *   finding returns" — that return is this comparison failing.
 * - **Snoozed**, until `snooze_until` passes. §5.1's fourth option, 90 days by
 *   default: "yes, I know, deal with it later."
 *
 * The config-hash arm is §5.1's other resurfacing rule — "A `rule_version` or
 * `config_hash` bump also resurfaces findings" — and `IS` rather than `=` so a
 * row dismissed before migration 002 existed (NULL) is not resurfaced by having
 * no answer recorded.
 *
 * `acknowledged` is deliberately absent. §6.4 lists Acknowledge and Dismiss as
 * separate actions, and acknowledging is "I have seen this", not "stop showing
 * me this" — it moves a finding out of the *unreviewed* count and nowhere else.
 *
 * Every comparison is `IS` rather than `=`, so the predicate is never NULL. A
 * dismissal recorded without an evidence hash would otherwise make `NOT (...)`
 * evaluate to NULL and drop the finding from the visible list — hiding it *more*
 * thoroughly than a valid dismissal would. `IS` makes that case false, so the
 * finding shows: the safe direction when the record of a dismissal is incomplete.
 */
const HIDDEN_PREDICATE = `(
  fs.status = 'dismissed'
    AND fs.dismissed_evidence_hash IS f.evidence_hash
    AND (fs.dismissed_config_hash IS NULL OR fs.dismissed_config_hash IS f.config_hash)
) OR (
  fs.status = 'snoozed' AND fs.snooze_until IS NOT NULL AND fs.snooze_until > ?
)`;

export class FindingRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------ the run lifecycle ---

  /**
   * §5.1's whole lifecycle, in one transaction.
   *
   * The transaction is not a nicety. Between the upsert and the sweep, every
   * finding this run did not emit is momentarily indistinguishable from every
   * finding that has never existed; a read landing there would show a Findings
   * page with half its cards resolved. `better-sqlite3` is synchronous and this
   * process is single-user (§2.7), so the window is small — but "small" is not a
   * property to rely on when `BEGIN` is free.
   */
  applyRun(input: ApplyRunInput): ApplyRunResult {
    return this.db.transaction((): ApplyRunResult => {
      const now = this.clock.now();
      let inserted = 0;
      let updated = 0;
      let evidenceRows = 0;

      const upsert = this.db.prepare(
        `INSERT INTO finding
           (id, rule_id, rule_version, config_hash, natural_key, subject_type, subject_id,
            title, detail_json, confidence, band, impact_kind, impact_monthly_cents,
            impact_annual_cents, llm_dependent, evidence_hash, first_detected_at,
            last_run_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (natural_key) DO UPDATE SET
           rule_version = excluded.rule_version,
           config_hash = excluded.config_hash,
           title = excluded.title,
           detail_json = excluded.detail_json,
           confidence = excluded.confidence,
           band = excluded.band,
           impact_kind = excluded.impact_kind,
           impact_monthly_cents = excluded.impact_monthly_cents,
           impact_annual_cents = excluded.impact_annual_cents,
           llm_dependent = excluded.llm_dependent,
           evidence_hash = excluded.evidence_hash,
           last_run_id = excluded.last_run_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      );

      for (const finding of input.findings) {
        const existing = this.getByNaturalKey(finding.naturalKey);
        const stamp = newStamp(this.clock);

        upsert.run(
          stamp.id,
          finding.ruleId,
          finding.ruleVersion,
          finding.configHash,
          finding.naturalKey,
          finding.subjectType,
          finding.subjectId,
          finding.title,
          finding.detailJson,
          String(finding.confidence),
          finding.band,
          finding.impactKind,
          finding.impactMonthlyCents,
          finding.impactAnnualCents,
          asInt(finding.llmDependent),
          finding.evidenceHash,
          // Only ever supplied for an insert: `ON CONFLICT` above does not name
          // this column, so an existing row keeps the timestamp it was born with.
          now,
          input.runId,
          finding.status,
          stamp.createdAt,
          stamp.updatedAt,
        );

        const id = existing?.id ?? stamp.id;
        if (existing) updated += 1;
        else inserted += 1;

        evidenceRows += this.replaceEvidence(id, finding.evidenceTransactionIds, now);
      }

      // §5.1: "A finding present in the previous run but absent from the current
      // one becomes `resolved` rather than being deleted." Absent means "this run
      // did not stamp it" — no id set to diff, and no way to disagree with the
      // loop above about what was emitted.
      const resolved = this.db
        .prepare(
          `UPDATE finding
              SET status = 'resolved', updated_at = ?
            WHERE status <> 'resolved'
              AND (last_run_id IS NULL OR last_run_id <> ?)`,
        )
        .run(now, input.runId).changes;

      return {
        inserted,
        updated,
        resolved,
        suppressed: input.findings.filter((finding) => finding.status === 'suppressed').length,
        evidenceRows,
      };
    })();
  }

  /**
   * `finding_evidence` is replaced wholesale rather than merged (§3.1).
   *
   * The evidence *is* the finding's current claim — "explicit transaction ids,
   * materialized into `finding_evidence`" (§5.1) — so a re-run that merged would
   * accumulate every transaction the finding has ever cited, and §6.3's
   * has-finding filter would keep flagging rows the rule stopped pointing at.
   *
   * `account_id` is looked up rather than supplied: a rule reads a snapshot, and
   * §5.1's evidence is a list of transaction ids with no account on it. An id
   * that no longer resolves is dropped, because `finding_evidence` FKs to
   * `transaction` under RESTRICT (§3.2) and a stale id would fail the whole run
   * rather than the one row.
   */
  private replaceEvidence(
    findingId: string,
    transactionIds: readonly string[],
    now: string,
  ): number {
    this.db.prepare('DELETE FROM finding_evidence WHERE finding_id = ?').run(findingId);

    const unique = [...new Set(transactionIds)];
    if (unique.length === 0) return 0;

    const lookup = this.db.prepare<[string], { id: string; account_id: string }>(
      'SELECT id, account_id FROM "transaction" WHERE id = ?',
    );
    const insert = this.db.prepare(
      `INSERT INTO finding_evidence (id, finding_id, transaction_id, account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let written = 0;
    for (const transactionId of unique) {
      const row = lookup.get(transactionId);
      if (!row) continue;
      insert.run(this.clock.newId(), findingId, row.id, row.account_id, now, now);
      written += 1;
    }
    return written;
  }

  // ------------------------------------------------------------- read paths ---

  get(id: string): FindingRecord | null {
    const row = this.db.prepare<[string], FindingRow>(`${SELECT_FINDING} WHERE id = ?`).get(id);
    return row ? toFinding(row) : null;
  }

  getByNaturalKey(naturalKey: string): FindingRecord | null {
    const row = this.db
      .prepare<[string], FindingRow>(`${SELECT_FINDING} WHERE natural_key = ?`)
      .get(naturalKey);
    return row ? toFinding(row) : null;
  }

  /**
   * §6.4's list: "grouped by rule, sorted by **annual impact** descending."
   *
   * Sorted by absolute annual impact, for the reason §5.1's emission policy sorts
   * that way — a rule may express a saving as a negative number, and "the biggest
   * ones" must not depend on which sign it chose.
   */
  search(query: FindingQuery): FindingPage {
    const { clause, params } = this.buildFilter(query);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);

    const total =
      this.db
        .prepare<unknown[], { n: number }>(
          `SELECT COUNT(*) AS n
             FROM finding AS f
             LEFT JOIN finding_state AS fs ON fs.natural_key = f.natural_key
            ${clause}`,
        )
        .get(...params)?.n ?? 0;

    const rows = this.db
      .prepare<unknown[], FindingRow>(
        `SELECT ${FINDING_COLUMNS.split(',')
          .map((column) => `f.${column.trim()}`)
          .join(', ')}
           FROM finding AS f
           LEFT JOIN finding_state AS fs ON fs.natural_key = f.natural_key
           ${clause}
          ORDER BY f.rule_id, ABS(f.impact_annual_cents) DESC, f.id
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map(toFinding);

    return { rows: rows.map((finding) => this.hydrate(finding)), total, limit, offset };
  }

  /** §6.4's top strip. Computed over the same filter the list uses, so the
   *  headline and the cards below it can never describe different sets. */
  totals(query: FindingQuery = {}): FindingTotals {
    const { clause, params } = this.buildFilter({ ...query, impactKind: undefined });

    const savings = this.db
      .prepare<unknown[], { annual: number | null; monthly: number | null }>(
        `SELECT SUM(f.impact_annual_cents) AS annual, SUM(f.impact_monthly_cents) AS monthly
           FROM finding AS f
           LEFT JOIN finding_state AS fs ON fs.natural_key = f.natural_key
           ${clause}${clause ? ' AND' : 'WHERE'} f.impact_kind = 'savings'`,
      )
      .get(...params);

    const counts = this.db
      .prepare<unknown[], { rule_id: string; band: string; n: number; unreviewed: number }>(
        `SELECT f.rule_id AS rule_id,
                f.band AS band,
                COUNT(*) AS n,
                SUM(CASE WHEN fs.natural_key IS NULL THEN 1 ELSE 0 END) AS unreviewed
           FROM finding AS f
           LEFT JOIN finding_state AS fs ON fs.natural_key = f.natural_key
           ${clause}
          GROUP BY f.rule_id, f.band`,
      )
      .all(...params);

    const countsByRule: Record<string, number> = {};
    const countsByBand: Record<string, number> = {};
    let activeCount = 0;
    let unreviewedCount = 0;

    for (const row of counts) {
      countsByRule[row.rule_id] = (countsByRule[row.rule_id] ?? 0) + row.n;
      countsByBand[row.band] = (countsByBand[row.band] ?? 0) + row.n;
      activeCount += row.n;
      unreviewedCount += row.unreviewed;
    }

    return {
      savingsAnnualCents: savings?.annual ?? 0,
      savingsMonthlyCents: savings?.monthly ?? 0,
      activeCount,
      unreviewedCount,
      countsByRule,
      countsByBand,
    };
  }

  private hydrate(finding: FindingRecord): FindingView {
    return {
      finding,
      state: this.getState(finding.naturalKey),
      evidenceTransactionIds: this.listEvidence(finding.id),
    };
  }

  /**
   * A finding's evidence ids, **oldest charge first**.
   *
   * This used to order by `transaction_id`, which is stable and means nothing:
   * ids are `randomUUID` (see `clock.ts`), so that ordering is a shuffle that
   * happens to be reproducible. It was harmless while the only consumer was a
   * count. §6.4's mini-table changed that — a card shows a few charges, not all
   * of a `micro.v1` group, and "a few" is only a defensible sample if the caller
   * can tell which end of the list is recent. Chronological order is what lets
   * the page take the tail and get the newest charges rather than an arbitrary
   * handful.
   *
   * `effective_date` is §7.1's one date. `transaction_id` stays as the tiebreak
   * so the order is still total: a merchant billing twice on one day must not
   * reorder between two reads of the same row set.
   */
  listEvidence(findingId: string): string[] {
    return this.db
      .prepare<[string], { transaction_id: string }>(
        `SELECT fe.transaction_id
           FROM finding_evidence AS fe
           JOIN "transaction" AS t ON t.id = fe.transaction_id
          WHERE fe.finding_id = ?
          ORDER BY t.effective_date, fe.transaction_id`,
      )
      .all(findingId)
      .map((row) => row.transaction_id);
  }

  private buildFilter(query: FindingQuery): { clause: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];

    // §6.4's page is about live findings, so `active` is the default rather than
    // "everything". A resolved finding is history and a suppressed one was asked
    // for by a standing rule; showing either by default would undo both.
    const statuses = query.statuses ?? (['active'] as const);
    if (statuses.length > 0) {
      where.push(`f.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }

    if (query.ruleIds?.length) {
      where.push(`f.rule_id IN (${query.ruleIds.map(() => '?').join(', ')})`);
      params.push(...query.ruleIds);
    }
    if (query.userStatuses?.length) {
      // `fs.status`, not `f.status`. The two tables both have a `status` column and
      // they mean different things — §5.1's "does the data still say this" versus
      // "have you dealt with it" — so the alias is doing real work here.
      where.push(`fs.status IN (${query.userStatuses.map(() => '?').join(', ')})`);
      params.push(...query.userStatuses);
    }
    if (query.bands?.length) {
      where.push(`f.band IN (${query.bands.map(() => '?').join(', ')})`);
      params.push(...query.bands);
    }
    if (query.impactKind) {
      where.push('f.impact_kind = ?');
      params.push(query.impactKind);
    }
    if (query.minAnnualImpactCents !== undefined) {
      where.push('ABS(f.impact_annual_cents) >= ?');
      params.push(query.minAnnualImpactCents);
    }
    if (query.accountIds?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM finding_evidence AS fe
                  WHERE fe.finding_id = f.id
                    AND fe.account_id IN (${query.accountIds.map(() => '?').join(', ')}))`,
      );
      params.push(...query.accountIds);
    }

    const visibility = query.visibility ?? 'visible';
    if (visibility !== 'all') {
      const now = query.now ?? this.clock.now();
      // The `fs.natural_key IS NULL` arm is not belt and braces. Over a LEFT JOIN
      // that matched nothing, every comparison inside the predicate is NULL and
      // `NOT (NULL)` is NULL rather than true — so without it, a finding the user
      // has never touched would be filtered out by the predicate meant to keep it.
      where.push(
        visibility === 'visible'
          ? `(fs.natural_key IS NULL OR NOT (${HIDDEN_PREDICATE}))`
          : `(fs.natural_key IS NOT NULL AND (${HIDDEN_PREDICATE}))`,
      );
      params.push(now);
    }

    return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  // ------------------------------------------------------------ user state ---

  getState(naturalKey: string): FindingStateRecord | null {
    const row = this.db
      .prepare<[string], FindingStateRow>(`${SELECT_STATE} WHERE natural_key = ?`)
      .get(naturalKey);
    return row ? toState(row) : null;
  }

  /**
   * Record the user's verdict on one finding (§2.3's
   * `POST /api/findings/:id/state`).
   *
   * Keyed on the natural key rather than the finding id, per §3.1, so it survives
   * the finding resolving and coming back. `dismissed_evidence_hash` and
   * `dismissed_config_hash` are captured here rather than at read time because
   * they are a snapshot of *what was true when the user decided* — reading them
   * off the finding later would always match, and the dismissal would never
   * expire.
   */
  setState(input: {
    readonly naturalKey: string;
    readonly status: FindingUserStatus;
    readonly reason?: string | null;
    readonly snoozeUntil?: string | null;
    readonly evidenceHash?: string | null;
    readonly configHash?: string | null;
  }): FindingStateRecord {
    const stamp = newStamp(this.clock);
    const dismissing = input.status === 'dismissed';

    this.db
      .prepare(
        `INSERT INTO finding_state
           (id, natural_key, status, reason, snooze_until,
            dismissed_evidence_hash, dismissed_config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (natural_key) DO UPDATE SET
           status = excluded.status,
           reason = excluded.reason,
           snooze_until = excluded.snooze_until,
           dismissed_evidence_hash = excluded.dismissed_evidence_hash,
           dismissed_config_hash = excluded.dismissed_config_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        stamp.id,
        input.naturalKey,
        input.status,
        input.reason ?? null,
        input.snoozeUntil ?? null,
        // Cleared on any verdict that is not a dismissal: a finding the user
        // un-dismisses by acknowledging must not keep a hash that would later
        // read as "still dismissed, and unchanged".
        dismissing ? (input.evidenceHash ?? null) : null,
        dismissing ? (input.configHash ?? null) : null,
        stamp.createdAt,
        stamp.updatedAt,
      );

    return this.getState(input.naturalKey) as FindingStateRecord;
  }

  clearState(naturalKey: string): void {
    this.db.prepare('DELETE FROM finding_state WHERE natural_key = ?').run(naturalKey);
  }

  // -------------------------------------------------------- standing rules ---

  listDismissalRules(): DismissalRuleRecord[] {
    return this.db
      .prepare<[], DismissalRuleRow>(`${SELECT_DISMISSAL} ORDER BY rule_id, scope, merchant_id`)
      .all()
      .map(toDismissalRule);
  }

  getDismissalRule(id: string): DismissalRuleRecord | null {
    const row = this.db
      .prepare<[string], DismissalRuleRow>(`${SELECT_DISMISSAL} WHERE id = ?`)
      .get(id);
    return row ? toDismissalRule(row) : null;
  }

  /**
   * §5.1's other two dismissal scopes. Idempotent on `(scope, rule_id,
   * merchant_id)`: clicking "dismiss this rule" twice is one standing rule, not
   * two rows that both have to be deleted before the findings come back.
   */
  createDismissalRule(input: {
    readonly scope: DismissalScope;
    readonly ruleId: string;
    readonly merchantId?: string | null;
    readonly reason?: string | null;
  }): DismissalRuleRecord {
    const merchantId = input.scope === 'merchant_rule' ? (input.merchantId ?? null) : null;

    const existing = this.db
      .prepare<[DismissalScope, string, string | null], DismissalRuleRow>(
        `${SELECT_DISMISSAL} WHERE scope = ? AND rule_id = ? AND merchant_id IS ?`,
      )
      .get(input.scope, input.ruleId, merchantId);
    if (existing) return toDismissalRule(existing);

    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO dismissal_rule (id, scope, rule_id, merchant_id, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp.id,
        input.scope,
        input.ruleId,
        merchantId,
        input.reason ?? null,
        stamp.createdAt,
        stamp.updatedAt,
      );

    return this.getDismissalRule(stamp.id) as DismissalRuleRecord;
  }

  deleteDismissalRule(id: string): boolean {
    return this.db.prepare('DELETE FROM dismissal_rule WHERE id = ?').run(id).changes > 0;
  }
}


// ============================================================ §7.6's corpus ===

/** §7.6's judgement, in the three answers a person can actually give. `unsure`
 *  is not a cop-out — it is the honest answer for a finding whose evidence a
 *  reader cannot check without a bank statement in front of them, and counting
 *  it as either of the others would put noise into the one number tuning reads. */
export type FindingVerdict = 'correct' | 'incorrect' | 'unsure';

export interface FindingLabelInput {
  readonly naturalKey: string;
  readonly ruleId: string;
  readonly verdict: FindingVerdict;
  readonly note?: string | null;
  /** What was true when the judgement was made — see migration 007. */
  readonly evidenceHash: string;
  readonly configHash: string;
}

export interface FindingLabelRecord extends FindingLabelInput {
  readonly id: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Per-rule accuracy, as §6.8's Analyzers section shows it beside the thresholds. */
export interface RuleAccuracy {
  readonly ruleId: string;
  readonly correct: number;
  readonly incorrect: number;
  readonly unsure: number;
  /**
   * Labels whose evidence has moved since the judgement was made.
   *
   * Counted and excluded rather than silently dropped: a rule whose labels are
   * mostly stale has an accuracy figure resting on a handful of current ones, and
   * a reader about to move a threshold on the strength of it should be told.
   */
  readonly stale: number;
}

interface LabelRow {
  id: string;
  natural_key: string;
  rule_id: string;
  verdict: FindingVerdict;
  note: string | null;
  labelled_evidence_hash: string;
  labelled_config_hash: string;
  created_at: string;
  updated_at: string;
}

const SELECT_LABEL = `SELECT id, natural_key, rule_id, verdict, note, labelled_evidence_hash,
                             labelled_config_hash, created_at, updated_at
                        FROM finding_label`;

function toLabel(row: LabelRow): FindingLabelRecord {
  return {
    id: row.id,
    naturalKey: row.natural_key,
    ruleId: row.rule_id,
    verdict: row.verdict,
    note: row.note,
    evidenceHash: row.labelled_evidence_hash,
    configHash: row.labelled_config_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * §7.6's fixture corpus, collected a finding at a time (§9z).
 *
 * Separate from `FindingRepository` because a label **outlives the finding it
 * judged**. §5.1 resolves a finding that stops firing rather than deleting it, but a
 * threshold change can remove it from every future run — and the judgement about
 * how the rule behaved at the old threshold is exactly what tuning wants to look
 * back at. Keeping labels in their own table with their own `rule_id` is what makes
 * that possible; joining them to `finding` would lose the ones that matter most.
 */
export class FindingLabelRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock
  ) {}

  get(naturalKey: string): FindingLabelRecord | null {
    const row = this.db
      .prepare<[string], LabelRow>(`${SELECT_LABEL} WHERE natural_key = ?`)
      .get(naturalKey);
    return row ? toLabel(row) : null;
  }

  /** Every label, newest judgement first. `GET /api/findings/labels` and the
   *  export both read this — §7.6's corpus is meant to leave the machine. */
  list(limit = 500): FindingLabelRecord[] {
    const bounded = Math.min(Math.max(limit, 1), 5000);
    return this.db
      .prepare<[number], LabelRow>(`${SELECT_LABEL} ORDER BY updated_at DESC LIMIT ?`)
      .all(bounded)
      .map(toLabel);
  }

  /** Set or change the judgement on one claim. Changing your mind updates the row;
   *  §7.6 wants the current best answer, not an audit trail. */
  put(input: FindingLabelInput): FindingLabelRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO finding_label
           (id, natural_key, rule_id, verdict, note, labelled_evidence_hash,
            labelled_config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (natural_key) DO UPDATE SET
           rule_id = excluded.rule_id,
           verdict = excluded.verdict,
           note = excluded.note,
           labelled_evidence_hash = excluded.labelled_evidence_hash,
           labelled_config_hash = excluded.labelled_config_hash,
           updated_at = excluded.updated_at`
      )
      .run(
        stamp.id,
        input.naturalKey,
        input.ruleId,
        input.verdict,
        input.note ?? null,
        input.evidenceHash,
        input.configHash,
        stamp.createdAt,
        stamp.updatedAt
      );

    return this.get(input.naturalKey) as FindingLabelRecord;
  }

  remove(naturalKey: string): boolean {
    return (
      this.db.prepare('DELETE FROM finding_label WHERE natural_key = ?').run(naturalKey).changes > 0
    );
  }

  /**
   * Accuracy per rule, with stale labels separated out.
   *
   * "Stale" is decided by joining back to the current `finding` row and comparing
   * `evidence_hash` — the same test §5.1 applies to a dismissal. A label on a claim
   * that has since changed is a label about a different claim, and the join is a
   * LEFT one because a finding that no longer exists at all is *not* stale: the
   * judgement about it stands, and it is exactly the history a threshold change
   * should be measured against.
   */
  accuracyByRule(): Map<string, RuleAccuracy> {
    const rows = this.db
      .prepare<[], { rule_id: string; verdict: FindingVerdict; stale: number; n: number }>(
        `SELECT l.rule_id AS rule_id,
                l.verdict AS verdict,
                CASE WHEN f.natural_key IS NOT NULL
                      AND f.evidence_hash <> l.labelled_evidence_hash
                     THEN 1 ELSE 0 END AS stale,
                COUNT(*) AS n
           FROM finding_label AS l
           LEFT JOIN finding AS f ON f.natural_key = l.natural_key
          GROUP BY l.rule_id, l.verdict, stale`
      )
      .all();

    const byRule = new Map<string, RuleAccuracy>();
    const blank = (ruleId: string): RuleAccuracy => ({
      ruleId,
      correct: 0,
      incorrect: 0,
      unsure: 0,
      stale: 0,
    });

    for (const row of rows) {
      const current = byRule.get(row.rule_id) ?? blank(row.rule_id);
      byRule.set(
        row.rule_id,
        row.stale === 1
          ? { ...current, stale: current.stale + row.n }
          : { ...current, [row.verdict]: current[row.verdict] + row.n }
      );
    }

    return byRule;
  }
}

/**
 * `analysis_run` and `recurring_series` (§3.1) — what a run *was*, and what §5.2
 * produced.
 *
 * ## Why the run row is opened before the analysis and closed after
 *
 * §2.2 requires `analysis_run` to record the snapshot row count, and §7.4
 * requires it to record `config_hash`. Neither is knowable until `analyze()` has
 * returned, but `finding.last_run_id` FKs to this table under RESTRICT (§3.2) —
 * so the row has to exist *before* the findings are written and be completed
 * *after*. `start` and `finish` are that pair, and the gap between them is also
 * what makes a crashed run visible: a row with a `started_at` and no
 * `finished_at` is a run that did not come back, which is worth more than no row.
 *
 * ## Series are derived data with three user-owned columns
 *
 * §6.5 puts `cancellation_url`, `notes` and a manual `user_status` on
 * `recurring_series`, and "a manual status always beats the computed one". Every
 * re-run recomputes everything else. `replaceSeries` therefore upserts on the id
 * §5.2 derives — merchant, account and the anchor date, which is stable across
 * runs precisely so this works — and never writes those three columns after the
 * insert.
 */

import { newStamp } from './stamp.js';
import type { TombstoneRepository } from './tombstones.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';

export type SeriesStatus = 'active' | 'lapsed' | 'cancelled';

/**
 * One charge in a series, as §5.2 fitted it.
 *
 * Restated here rather than imported from `analyzers`: a `type:data-access` lib may
 * depend on `type:domain` and nothing else (§2.2), which is the same arrangement this
 * lib already has with the parser's format profile. The composition root does the
 * one-line conversion.
 */
export interface SeriesCharge {
  readonly transactionId: string;
  /** Signed, as stored — negative is money leaving (§3.1). */
  readonly amountCents: number;
  readonly effectiveDate: string;
}

/** One price change inside a series, as §5.5 derived it. Magnitudes, not signed
 *  amounts — a price is a positive number. */
export interface SeriesPriceStep {
  /** Effective date of the first charge at the new price. */
  readonly at: string;
  readonly fromCents: number;
  readonly toCents: number;
  /** Positive for an increase. */
  readonly deltaCents: number;
  readonly occurrencesAtNewPrice: number;
  /** §5.5: an unconfirmed step is reported at reduced confidence and labelled
   *  "one charge at the new price" rather than withheld. */
  readonly confirmed: boolean;
}

export interface AnalysisRunRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly ruleVersionsJson: string | null;
  readonly configHash: string | null;
  readonly snapshotRows: number | null;
  readonly countsJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One series as §5.2 computed it. The user columns are absent by design — this
 *  is the computed half, and `patchSeries` owns the other. */
export interface SeriesInput {
  readonly id: string;
  readonly merchantId: string;
  readonly accountId: string;
  /**
   * Fractional, and `number` rather than `integer` on purpose: §5.2's cadence
   * table is `monthly = 30.44 days, 12/year` and `weekly = 7 days, 52.18/year`,
   * because a calendar month is not 30 days and a year is not 52 weeks. §3.1
   * declares both columns INTEGER; SQLite's INTEGER affinity stores a REAL that
   * cannot be losslessly narrowed as a REAL, so the values survive — but the
   * declared type does not describe them. Recorded in §9e.
   */
  readonly cadenceDays: number | null;
  readonly cadenceLabel: string | null;
  readonly cadencesPerYear: number | null;
  readonly amountCentsCurrent: number | null;
  readonly amountCentsFirst: number | null;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  readonly nextExpected: string | null;
  readonly occurrenceCount: number;
  readonly status: SeriesStatus;
  readonly regularity: number | null;
  readonly confidence: number | null;
  /**
   * §5.3's "ordered charge list" and "price steps", carried rather than re-derived.
   *
   * §5.3 forbids re-deriving the series contract downstream, and a read-time
   * derivation would answer with *today's* grouping rather than the run's — a
   * merchant correction or a later import moves which charges a series is made of.
   * §9f made the same call for `transfer_link.detail_json`. Recorded in §9i.
   */
  readonly charges: readonly SeriesCharge[];
  readonly priceSteps: readonly SeriesPriceStep[];
}

/** §6.5's three user-owned columns, and only those. The computed half belongs to
 *  `replaceSeries`, which never writes these after the insert. */
export interface SeriesPatch {
  /** §6.5's manual override. "A manual status always beats the computed one."
   *  `null` clears it and hands the series back to §5.2's computed status. */
  readonly userStatus?: SeriesStatus | null;
  readonly cancellationUrl?: string | null;
  readonly notes?: string | null;
}

export interface SeriesRecord extends SeriesInput {
  /** §6.5's manual override. "A manual status always beats the computed one." */
  readonly userStatus: SeriesStatus | null;
  readonly cancellationUrl: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** §6.4's first headline number: "active subscriptions and their monthly/annual
 *  total". `user_status` wins where it is set, per §6.5. */
export interface SeriesTotals {
  readonly activeCount: number;
  readonly lapsedCount: number;
  readonly monthlyCents: number;
  readonly annualCents: number;
}

export interface ReplaceSeriesResult {
  readonly inserted: number;
  readonly updated: number;
  readonly removed: number;
}

interface AnalysisRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  rule_versions_json: string | null;
  config_hash: string | null;
  snapshot_rows: number | null;
  counts_json: string | null;
  created_at: string;
  updated_at: string;
}

interface SeriesRow {
  id: string;
  merchant_id: string;
  account_id: string;
  cadence_days: number | null;
  cadence_label: string | null;
  cadences_per_year: number | null;
  amount_cents_current: number | null;
  amount_cents_first: number | null;
  first_seen: string | null;
  last_seen: string | null;
  next_expected: string | null;
  occurrence_count: number;
  status: SeriesStatus;
  user_status: SeriesStatus | null;
  cancellation_url: string | null;
  notes: string | null;
  regularity: number | null;
  confidence: string | null;
  charges_json: string | null;
  price_steps_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_RUN = `SELECT id, started_at, finished_at, rule_versions_json, config_hash,
                           snapshot_rows, counts_json, created_at, updated_at
                      FROM analysis_run`;

const SELECT_SERIES = `SELECT id, merchant_id, account_id, cadence_days, cadence_label,
                              cadences_per_year, amount_cents_current, amount_cents_first,
                              first_seen, last_seen, next_expected, occurrence_count, status,
                              user_status, cancellation_url, notes, regularity, confidence,
                              charges_json, price_steps_json, created_at, updated_at
                         FROM recurring_series`;

function toRun(row: AnalysisRunRow): AnalysisRunRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ruleVersionsJson: row.rule_versions_json,
    configHash: row.config_hash,
    snapshotRows: row.snapshot_rows,
    countsJson: row.counts_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** §3.1 declares `recurring_series.confidence` TEXT, so SQLite stores the number
 *  as its decimal string; `String(n)` round-trips exactly through `Number`. */
/** Malformed JSON in a derived column is a bad write, not a reason to fail every
 *  read of the Subscriptions page. The summary still renders; the drawer shows no
 *  history, which is what a null column means anyway. */
function parseJsonArray<T>(json: string | null): readonly T[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toSeries(row: SeriesRow): SeriesRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    accountId: row.account_id,
    cadenceDays: row.cadence_days,
    cadenceLabel: row.cadence_label,
    cadencesPerYear: row.cadences_per_year,
    amountCentsCurrent: row.amount_cents_current,
    amountCentsFirst: row.amount_cents_first,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    nextExpected: row.next_expected,
    occurrenceCount: row.occurrence_count,
    status: row.status,
    userStatus: row.user_status,
    cancellationUrl: row.cancellation_url,
    notes: row.notes,
    regularity: row.regularity,
    confidence: row.confidence === null ? null : Number(row.confidence),
    // A row written before migration 005 has no history, and an empty list is the
    // honest reading: this series carries none. The next run fills it in.
    charges: parseJsonArray<SeriesCharge>(row.charges_json),
    priceSteps: parseJsonArray<SeriesPriceStep>(row.price_steps_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AnalysisRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly tombstones: TombstoneRepository,
  ) {}

  // ------------------------------------------------------------------ runs ---

  /** Opens the row `finding.last_run_id` will point at. */
  start(): AnalysisRunRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO analysis_run
           (id, started_at, finished_at, rule_versions_json, config_hash, snapshot_rows,
            counts_json, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(stamp.id, stamp.createdAt, stamp.createdAt, stamp.updatedAt);
    return this.get(stamp.id) as AnalysisRunRecord;
  }

  finish(
    id: string,
    input: {
      readonly ruleVersions: Readonly<Record<string, string>>;
      readonly configHash: string;
      readonly snapshotRows: number;
      readonly counts: Readonly<Record<string, unknown>>;
    },
  ): AnalysisRunRecord {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE analysis_run
            SET finished_at = ?, rule_versions_json = ?, config_hash = ?, snapshot_rows = ?,
                counts_json = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        now,
        JSON.stringify(input.ruleVersions),
        input.configHash,
        input.snapshotRows,
        JSON.stringify(input.counts),
        now,
        id,
      );
    return this.get(id) as AnalysisRunRecord;
  }

  get(id: string): AnalysisRunRecord | null {
    const row = this.db.prepare<[string], AnalysisRunRow>(`${SELECT_RUN} WHERE id = ?`).get(id);
    return row ? toRun(row) : null;
  }

  /** The most recent *completed* run. A run that started and never finished has
   *  no `config_hash` to explain the findings on screen, so it is not the one to
   *  quote. */
  latestFinished(): AnalysisRunRecord | null {
    const row = this.db
      .prepare<[], AnalysisRunRow>(
        `${SELECT_RUN} WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )
      .get();
    return row ? toRun(row) : null;
  }

  listRuns(limit = 20): AnalysisRunRecord[] {
    return this.db
      .prepare<[number], AnalysisRunRow>(`${SELECT_RUN} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(limit)
      .map(toRun);
  }

  // ---------------------------------------------------------------- series ---

  /**
   * Persist this run's series, preserving §6.5's user columns and removing the
   * series this run no longer produces.
   *
   * Removal rather than a `resolved` marker, which is where this deliberately
   * parts company with §5.1's finding lifecycle. A finding that stops being true
   * is information — "this subscription is no longer over-priced" is worth
   * saying. A *series* that stops being produced is not a subscription that
   * ended: §5.2 marks that one `lapsed` and still emits it. It is a series whose
   * charges were re-grouped, usually because a merchant correction merged two
   * spellings into one (§4.3) — and keeping the superseded row would show the
   * Subscriptions page a duplicate and hand §5.4 a same-merchant multiplicity
   * finding built out of the user's own correction.
   *
   * The cost is that a `cancellation_url` or note attached to a series that later
   * re-groups goes with it. Tombstoned, not silently dropped (§3.4).
   */
  replaceSeries(series: readonly SeriesInput[]): ReplaceSeriesResult {
    return this.db.transaction((): ReplaceSeriesResult => {
      const now = this.clock.now();
      const existing = new Set(
        this.db
          .prepare<[], { id: string }>('SELECT id FROM recurring_series')
          .all()
          .map((row) => row.id),
      );

      const upsert = this.db.prepare(
        `INSERT INTO recurring_series
           (id, merchant_id, account_id, cadence_days, cadence_label, cadences_per_year,
            amount_cents_current, amount_cents_first, first_seen, last_seen, next_expected,
            occurrence_count, status, user_status, cancellation_url, notes, regularity,
            confidence, charges_json, price_steps_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           merchant_id = excluded.merchant_id,
           account_id = excluded.account_id,
           cadence_days = excluded.cadence_days,
           cadence_label = excluded.cadence_label,
           cadences_per_year = excluded.cadences_per_year,
           amount_cents_current = excluded.amount_cents_current,
           amount_cents_first = excluded.amount_cents_first,
           first_seen = excluded.first_seen,
           last_seen = excluded.last_seen,
           next_expected = excluded.next_expected,
           occurrence_count = excluded.occurrence_count,
           status = excluded.status,
           regularity = excluded.regularity,
           confidence = excluded.confidence,
           charges_json = excluded.charges_json,
           price_steps_json = excluded.price_steps_json,
           updated_at = excluded.updated_at`,
      );

      let inserted = 0;
      let updated = 0;

      for (const entry of series) {
        if (existing.has(entry.id)) updated += 1;
        else inserted += 1;

        upsert.run(
          entry.id,
          entry.merchantId,
          entry.accountId,
          entry.cadenceDays,
          entry.cadenceLabel,
          entry.cadencesPerYear,
          entry.amountCentsCurrent,
          entry.amountCentsFirst,
          entry.firstSeen,
          entry.lastSeen,
          entry.nextExpected,
          entry.occurrenceCount,
          entry.status,
          entry.regularity,
          entry.confidence === null ? null : String(entry.confidence),
          JSON.stringify(entry.charges),
          JSON.stringify(entry.priceSteps),
          now,
          now,
        );

        existing.delete(entry.id);
      }

      const remove = this.db.prepare('DELETE FROM recurring_series WHERE id = ?');
      for (const id of existing) {
        remove.run(id);
        this.tombstones.record('recurring_series', id);
      }

      return { inserted, updated, removed: existing.size };
    })();
  }

  /**
   * §6.5's three user-owned columns — the other half of the split this file's header
   * describes, and the `patchSeries` it names.
   *
   * Only the columns the patch actually mentions are written, for the reason
   * `TransactionRepository.applyBulk` gives: a read-then-write of every column would
   * rewrite `notes` to the value it already had every time someone saved a URL, and
   * would clobber a concurrent edit to a field this caller never mentioned.
   *
   * An explicit `null` for `userStatus` is a real value and clears the override,
   * handing the series back to §5.2's computed status — which is why the three fields
   * are optional rather than nullable-required. "Unset the override" and "leave the
   * override alone" are different requests and must stay distinguishable.
   *
   * Returns `null` for an unknown id rather than throwing, so the route answers 404.
   */
  patchSeries(id: string, patch: SeriesPatch): SeriesRecord | null {
    const assignments: string[] = [];
    const values: unknown[] = [];

    // A fixed column map, per §3.4: no caller string reaches SQL uninterpreted.
    if (patch.userStatus !== undefined) {
      assignments.push('user_status = ?');
      values.push(patch.userStatus);
    }
    if (patch.cancellationUrl !== undefined) {
      assignments.push('cancellation_url = ?');
      values.push(patch.cancellationUrl);
    }
    if (patch.notes !== undefined) {
      assignments.push('notes = ?');
      values.push(patch.notes);
    }

    if (assignments.length === 0) return this.getSeries(id);

    const changed = this.db
      .prepare(`UPDATE recurring_series SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, this.clock.now(), id);

    return changed.changes === 0 ? null : this.getSeries(id);
  }

  listSeries(): SeriesRecord[] {
    return this.db
      .prepare<[], SeriesRow>(`${SELECT_SERIES} ORDER BY merchant_id, account_id, first_seen`)
      .all()
      .map(toSeries);
  }

  getSeries(id: string): SeriesRecord | null {
    const row = this.db.prepare<[string], SeriesRow>(`${SELECT_SERIES} WHERE id = ?`).get(id);
    return row ? toSeries(row) : null;
  }

  /**
   * §6.4's subscription headline.
   *
   * `COALESCE(user_status, status)` is §6.5's "a manual status always beats the
   * computed one" applied to the total: a subscription the user has marked
   * cancelled stops counting the moment they say so, without waiting for
   * `1.5 × cadence` of silence to make §5.2 agree.
   *
   * `cadences_per_year` is the multiplier rather than a per-cadence guess, and
   * the arithmetic stays in integer cents (§7.3) — the annual figure is rounded
   * once, at the end, rather than per series.
   */
  seriesTotals(): SeriesTotals {
    const rows = this.db
      .prepare<[], { effective: SeriesStatus; annual: number | null; n: number }>(
        `SELECT COALESCE(user_status, status) AS effective,
                SUM(amount_cents_current * cadences_per_year) AS annual,
                COUNT(*) AS n
           FROM recurring_series
          GROUP BY effective`,
      )
      .all();

    const active = rows.find((row) => row.effective === 'active');
    const annualCents = Math.round(active?.annual ?? 0);

    return {
      activeCount: active?.n ?? 0,
      lapsedCount: rows
        .filter((row) => row.effective !== 'active')
        .reduce((total, row) => total + row.n, 0),
      monthlyCents: Math.round(annualCents / 12),
      annualCents,
    };
  }
}

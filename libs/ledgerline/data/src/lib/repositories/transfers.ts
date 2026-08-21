/**
 * `transfer_link` and `transfer_rule` (§3.1) — the "persist" half of §2.5's
 * `link` stage.
 *
 * §2.5 assigns the stage to "`analyzers` (match) + `data` (persist)". The match is
 * a pure function over the snapshot and lives in `analyzers`; everything below is
 * what happens to its answer, plus the two things a run can never decide: what the
 * user already confirmed, and what they already rejected.
 *
 * ## Ownership, and why a re-run is safe
 *
 * `state` splits the table in two. `auto` and `proposed` are the **run's**: every
 * pass replaces them wholesale, which is what lets an auto-link be *withdrawn*
 * when the evidence moves — a link that could only ever be created would make
 * §2.6's "a false link removes money from every total invisibly" permanent.
 * `confirmed` and `rejected` are the **user's** and no run touches them. Same
 * arrangement `replaceSeries` has with §6.5's three user columns, for the same
 * reason.
 *
 * ## What a link does to a transaction, and what it must never do
 *
 * A live link (`auto` or `confirmed`) sets `is_internal_transfer = 1` and stamps
 * both rows with a shared `transfer_pair_id`. Withdrawing one clears both —
 * **but only on rows carrying that link's own pair id**. §6.3 lets a user mark a
 * transfer by hand, and such a row has `transfer_pair_id IS NULL`; clearing it
 * because no link claims it would silently undo an edit made on another page. The
 * pair id is what tells a machine-set flag from a hand-set one.
 *
 * A `proposed` link sets nothing. §2.6 is explicit that a proposal "is *not*
 * excluded from spend until confirmed", and that is the entire reason §6.2 has a
 * queue rather than an audit log.
 *
 * ## A partial payment is several rows and one decision
 *
 * §3.1 models a link as one debit and one credit, and §3.2 keys it
 * `UNIQUE (debit, credit)`. §2.6's partial-payment pass produces one credit
 * against two or three debits, which is therefore two or three rows — and
 * `ix_transfer_link_credit` is the index that reads them back as a group in one
 * lookup. So a **group is every row sharing a credit transaction and a state**,
 * and confirming or rejecting any of them acts on all: half a split payment linked
 * and half not is a state no total could be computed from. The state is part of
 * the key because a credit can carry a pair the user rejected last month *and* a
 * different pair this run proposed. Recorded in §9f.
 */

import { newStamp } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toAccount, toTransaction } from '../records.js';
import type { AccountRecord, AccountRow, TransactionRecord, TransactionRow } from '../records.js';

/** §3.1's `transfer_link.state`. */
export type TransferLinkState = 'proposed' | 'confirmed' | 'rejected' | 'auto';

/** The two a run owns; see the header. */
export const MACHINE_LINK_STATES: readonly TransferLinkState[] = ['auto', 'proposed'];

export interface TransferLinkRecord {
  readonly id: string;
  readonly debitTransactionId: string;
  readonly creditTransactionId: string;
  readonly score: number;
  readonly state: TransferLinkState;
  readonly ruleId: string | null;
  /** §2.6's reasons and the match kind, as the matcher produced them. Stored so
   *  §6.2 can explain a proposal without re-deriving a score against a snapshot
   *  that has since moved (migration 003, §9f). */
  readonly detailJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferRuleRecord {
  readonly id: string;
  readonly descriptorPattern: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of a link as a run proposes it. */
export interface TransferLinkInput {
  readonly debitTransactionId: string;
  readonly creditTransactionId: string;
  readonly score: number;
  readonly state: Extract<TransferLinkState, 'auto' | 'proposed'>;
  readonly ruleId: string | null;
  readonly detailJson: string | null;
}

/**
 * A link group as §6.2 reads it: both sides' rows, their accounts, and the money.
 *
 * The transactions travel with it rather than as ids to fetch. §6.2 asks for
 * "proposed pairs with **both rows**, the score's reasons, and the dollar effect
 * of confirming" — a queue whose rows arrive one round trip later is a queue
 * confirmed against a spinner.
 */
export interface TransferLinkView {
  /** The group's representative `transfer_link.id` — what §2.3's
   *  `POST /api/transfers/:id/confirm` and `DELETE /api/transfers/:id` take. */
  readonly id: string;
  /** Every row of the group, oldest first. More than one only for a partial
   *  payment (§2.6). */
  readonly links: readonly TransferLinkRecord[];
  readonly state: TransferLinkState;
  readonly score: number;
  readonly detailJson: string | null;
  readonly debits: readonly TransactionRecord[];
  readonly credit: TransactionRecord;
  readonly debitAccount: AccountRecord | null;
  readonly creditAccount: AccountRecord | null;
  /**
   * What confirming takes out of spending, in integer cents (§7.3).
   *
   * The debit total, not the debit total plus the credit: §6.2 asks for "the
   * dollar effect of confirming", and the effect the user is deciding about is
   * that this much stops being counted as money spent. The credit side is the
   * same money arriving, and adding the two would state the effect at double.
   */
  readonly spendReductionCents: number;
}

export interface ReplaceLinksResult {
  readonly inserted: number;
  readonly updated: number;
  readonly removed: number;
  /** Rows whose `is_internal_transfer` this pass turned on, and off. */
  readonly flagged: number;
  readonly unflagged: number;
}

interface TransferLinkRow {
  id: string;
  debit_transaction_id: string;
  credit_transaction_id: string;
  score: number;
  state: TransferLinkState;
  rule_id: string | null;
  detail_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TransferRuleRow {
  id: string;
  descriptor_pattern: string;
  debit_account_id: string;
  credit_account_id: string;
  created_at: string;
  updated_at: string;
}

const SELECT_LINK = `SELECT id, debit_transaction_id, credit_transaction_id, score, state,
                            rule_id, detail_json, created_at, updated_at
                       FROM transfer_link`;

const SELECT_RULE = `SELECT id, descriptor_pattern, debit_account_id, credit_account_id,
                            created_at, updated_at
                       FROM transfer_rule`;

const SELECT_TRANSACTION = `SELECT id, account_id, raw_row_id, posted_date, transaction_date,
                                   effective_date, amount_cents, balance_cents, currency,
                                   description_raw, description_normalized, merchant_id,
                                   category_id, category_source, is_pending, is_internal_transfer,
                                   transfer_pair_id, refund_pair_id, is_excluded,
                                   allows_zero_amount, dedupe_key, dedupe_key_version,
                                   occurrence_index, created_at, updated_at
                              FROM "transaction"`;

const SELECT_ACCOUNT = `SELECT id, display_name, institution, account_type, last4, currency,
                               is_active, created_at, updated_at
                          FROM account`;

const pairKeyOf = (debitTransactionId: string, creditTransactionId: string): string =>
  `${debitTransactionId}|${creditTransactionId}`;

function toLink(row: TransferLinkRow): TransferLinkRecord {
  return {
    id: row.id,
    debitTransactionId: row.debit_transaction_id,
    creditTransactionId: row.credit_transaction_id,
    score: row.score,
    state: row.state,
    ruleId: row.rule_id,
    detailJson: row.detail_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRule(row: TransferRuleRow): TransferRuleRecord {
  return {
    id: row.id,
    descriptorPattern: row.descriptor_pattern,
    debitAccountId: row.debit_account_id,
    creditAccountId: row.credit_account_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Oldest first, then by id — a total order, so the representative link a group
 *  is named by does not depend on SQLite's row order. */
const byCreatedThenId = (a: TransferLinkRecord, b: TransferLinkRecord): number =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

export interface TransferLinkQuery {
  readonly states?: readonly TransferLinkState[];
  readonly accountIds?: readonly string[];
}

export class TransferRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  // --------------------------------------------------------------- the run ---

  /**
   * Replace every machine-owned link with this pass's, and move the flags to
   * match.
   *
   * One transaction, because the half-applied state is incoherent: a link row
   * saying `auto` beside a transaction that is not flagged is a total that is
   * wrong with no way to tell that it is wrong.
   */
  replaceMachineLinks(matches: readonly TransferLinkInput[]): ReplaceLinksResult {
    return this.db.transaction((): ReplaceLinksResult => {
      const now = this.clock.now();

      const existing = new Map(
        this.machineLinks().map((link) => [
          pairKeyOf(link.debitTransactionId, link.creditTransactionId),
          link,
        ]),
      );

      // Every group's representative, so a stale partial group's flags are cleared
      // against the id they were actually stamped with.
      const representativeOf = this.representatives([...existing.values()]);

      // A pair the user has settled is not the run's to re-state. The matcher is
      // told the same thing; this is the copy that holds the write lock.
      const settled = new Set(
        this.db
          .prepare<[], { debit_transaction_id: string; credit_transaction_id: string }>(
            `SELECT debit_transaction_id, credit_transaction_id FROM transfer_link
              WHERE state IN ('confirmed', 'rejected')`,
          )
          .all()
          .map((row) => pairKeyOf(row.debit_transaction_id, row.credit_transaction_id)),
      );

      const upsert = this.db.prepare(
        `INSERT INTO transfer_link
           (id, debit_transaction_id, credit_transaction_id, score, state, rule_id, detail_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (debit_transaction_id, credit_transaction_id) DO UPDATE SET
           score = excluded.score,
           state = excluded.state,
           rule_id = excluded.rule_id,
           detail_json = excluded.detail_json,
           updated_at = excluded.updated_at`,
      );

      let inserted = 0;
      let updated = 0;
      const wanted: { readonly link: TransferLinkInput; readonly id: string }[] = [];

      for (const match of matches) {
        const key = pairKeyOf(match.debitTransactionId, match.creditTransactionId);
        if (settled.has(key)) continue;

        const previous = existing.get(key);
        const stamp = newStamp(this.clock);
        const id = previous?.id ?? stamp.id;

        upsert.run(
          id,
          match.debitTransactionId,
          match.creditTransactionId,
          match.score,
          match.state,
          match.ruleId,
          match.detailJson,
          previous?.createdAt ?? stamp.createdAt,
          stamp.updatedAt,
        );

        if (previous) updated += 1;
        else inserted += 1;
        existing.delete(key);
        wanted.push({ link: match, id });
      }

      // Withdraw everything this pass did not produce, undoing its flags first —
      // §3.2's RESTRICT would refuse the delete otherwise, and a flag left behind
      // is money missing from a total with no row to explain it.
      let unflagged = 0;
      const remove = this.db.prepare('DELETE FROM transfer_link WHERE id = ?');
      for (const stale of existing.values()) {
        unflagged += this.clearFlags(
          [stale.debitTransactionId, stale.creditTransactionId],
          representativeOf.get(stale.id) ?? stale.id,
          now,
        );
        remove.run(stale.id);
      }

      // Flags second, and against the *new* representatives: a group whose first
      // row changed between runs keeps one pair id across both of its rows.
      const survivors = this.machineLinks();
      const newRepresentative = this.representatives(survivors);
      let flagged = 0;

      for (const entry of wanted) {
        const pairId = newRepresentative.get(entry.id) ?? entry.id;
        const ids = [entry.link.debitTransactionId, entry.link.creditTransactionId];
        if (entry.link.state === 'auto') flagged += this.setFlags(ids, pairId, now);
        else unflagged += this.clearFlags(ids, pairId, now);
      }

      return { inserted, updated, removed: existing.size, flagged, unflagged };
    })();
  }

  // --------------------------------------------------- the user's two verbs ---

  /**
   * §2.6's confirm: the pair is a transfer, and both sides leave the totals.
   *
   * Acts on the whole group (see the header) and is reversible — `reject` puts
   * every one of these changes back. §6.2 shows the dollar effect first because
   * this is the moment a number on the Findings page moves.
   */
  confirm(linkId: string): TransferLinkView | null {
    return this.db.transaction((): TransferLinkView | null => {
      const group = this.groupFor(linkId);
      if (group.length === 0) return null;

      const now = this.clock.now();
      const update = this.db.prepare(
        `UPDATE transfer_link SET state = 'confirmed', updated_at = ? WHERE id = ?`,
      );
      for (const link of group) update.run(now, link.id);

      this.setFlags(
        [...group.map((link) => link.debitTransactionId), group[0].creditTransactionId],
        group[0].id,
        now,
      );

      return this.get(group[0].id);
    })();
  }

  /**
   * §2.6's other verb, and the undo for `confirm`.
   *
   * The row is kept in state `rejected` rather than deleted, which is what makes
   * the decision durable: a deleted row is one the next run re-proposes, so "no,
   * that is not a transfer" would have to be said once a month forever.
   */
  reject(linkId: string): TransferLinkView | null {
    return this.db.transaction((): TransferLinkView | null => {
      const group = this.groupFor(linkId);
      if (group.length === 0) return null;

      const now = this.clock.now();
      this.clearFlags(
        [...group.map((link) => link.debitTransactionId), group[0].creditTransactionId],
        group[0].id,
        now,
      );

      const update = this.db.prepare(
        `UPDATE transfer_link SET state = 'rejected', updated_at = ? WHERE id = ?`,
      );
      for (const link of group) update.run(now, link.id);

      return this.get(group[0].id);
    })();
  }

  // ---------------------------------------------------------------- reading ---

  get(linkId: string): TransferLinkView | null {
    const group = this.groupFor(linkId);
    return group.length === 0 ? null : this.toView(group);
  }

  list(query: TransferLinkQuery = {}): TransferLinkView[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.states?.length) {
      where.push(`l.state IN (${query.states.map(() => '?').join(', ')})`);
      params.push(...query.states);
    }
    if (query.accountIds?.length) {
      const placeholders = query.accountIds.map(() => '?').join(', ');
      where.push(
        `(EXISTS (SELECT 1 FROM "transaction" AS d
                   WHERE d.id = l.debit_transaction_id AND d.account_id IN (${placeholders}))
          OR EXISTS (SELECT 1 FROM "transaction" AS c
                      WHERE c.id = l.credit_transaction_id AND c.account_id IN (${placeholders})))`,
      );
      params.push(...query.accountIds, ...query.accountIds);
    }

    const rows = this.db
      .prepare<unknown[], TransferLinkRow>(
        `${SELECT_LINK} AS l ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .all(...params)
      .map(toLink);

    return [...groupLinks(rows).values()]
      .map((group) => this.toView(group))
      .filter((view): view is TransferLinkView => view !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.spendReductionCents - a.spendReductionCents ||
          (a.id < b.id ? -1 : 1),
      );
  }

  /** Transactions inside a `confirmed` link — spoken for, and never re-matched. */
  listTakenTransactionIds(): string[] {
    return this.db
      .prepare<[], { id: string }>(
        `SELECT debit_transaction_id AS id FROM transfer_link WHERE state = 'confirmed'
         UNION
         SELECT credit_transaction_id AS id FROM transfer_link WHERE state = 'confirmed'
         ORDER BY id`,
      )
      .all()
      .map((row) => row.id);
  }

  /** `debitId|creditId` for every pair a human has said no to. */
  listRejectedPairKeys(): string[] {
    return this.db
      .prepare<[], { debit_transaction_id: string; credit_transaction_id: string }>(
        `SELECT debit_transaction_id, credit_transaction_id FROM transfer_link
          WHERE state = 'rejected' ORDER BY debit_transaction_id, credit_transaction_id`,
      )
      .all()
      .map((row) => pairKeyOf(row.debit_transaction_id, row.credit_transaction_id));
  }

  /** Groups, not rows: a three-part partial payment is one entry in §6.2's
   *  queue and should count as one. */
  countByState(): Record<TransferLinkState, number> {
    const counts: Record<TransferLinkState, number> = {
      auto: 0,
      proposed: 0,
      confirmed: 0,
      rejected: 0,
    };
    for (const row of this.db
      .prepare<[], { state: TransferLinkState; n: number }>(
        `SELECT state, COUNT(DISTINCT credit_transaction_id) AS n
           FROM transfer_link GROUP BY state`,
      )
      .all()) {
      counts[row.state] = row.n;
    }
    return counts;
  }

  // ------------------------------------------------------------------ rules ---

  /**
   * §2.6's learning, written when a proposal is confirmed.
   *
   * Idempotent on the triple, so confirming the same monthly payment twice
   * teaches one rule rather than two identical ones that both add +3.
   */
  upsertRule(input: {
    readonly descriptorPattern: string;
    readonly debitAccountId: string;
    readonly creditAccountId: string;
  }): TransferRuleRecord {
    const existing = this.db
      .prepare<[string, string, string], TransferRuleRow>(
        `${SELECT_RULE} WHERE descriptor_pattern = ?
            AND debit_account_id = ? AND credit_account_id = ?`,
      )
      .get(input.descriptorPattern, input.debitAccountId, input.creditAccountId);
    if (existing) return toRule(existing);

    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO transfer_rule
           (id, descriptor_pattern, debit_account_id, credit_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp.id,
        input.descriptorPattern,
        input.debitAccountId,
        input.creditAccountId,
        stamp.createdAt,
        stamp.updatedAt,
      );

    return toRule(
      this.db
        .prepare<[string], TransferRuleRow>(`${SELECT_RULE} WHERE id = ?`)
        .get(stamp.id) as TransferRuleRow,
    );
  }

  listRules(): TransferRuleRecord[] {
    return this.db
      .prepare<[], TransferRuleRow>(`${SELECT_RULE} ORDER BY created_at, id`)
      .all()
      .map(toRule);
  }

  // ------------------------------------------------------ the account merge ---

  /**
   * Re-point a merged account's rules and drop the ones that collapse.
   *
   * §2.6 requires A ≠ B, so a rule from an account to itself can never match
   * again and is deleted rather than left as a row nothing will ever read.
   */
  repointRules(fromAccountId: string, toAccountId: string): void {
    const now = this.clock.now();
    this.db
      .prepare(
        'UPDATE transfer_rule SET debit_account_id = ?, updated_at = ? WHERE debit_account_id = ?',
      )
      .run(toAccountId, now, fromAccountId);
    this.db
      .prepare(
        'UPDATE transfer_rule SET credit_account_id = ?, updated_at = ? WHERE credit_account_id = ?',
      )
      .run(toAccountId, now, fromAccountId);
    this.db.prepare('DELETE FROM transfer_rule WHERE debit_account_id = credit_account_id').run();
  }

  /**
   * Drop every link whose two sides now sit in one account.
   *
   * A merge is the user saying two accounts were always one; the "transfers"
   * between them were never transfers, and leaving them linked would keep real
   * spending — or real income — out of every total.
   */
  deleteSelfLinks(): number {
    return this.db.transaction((): number => {
      const now = this.clock.now();
      const doomed = this.db
        .prepare<[], TransferLinkRow>(
          `${SELECT_LINK} AS l
            WHERE (SELECT account_id FROM "transaction" WHERE id = l.debit_transaction_id)
                = (SELECT account_id FROM "transaction" WHERE id = l.credit_transaction_id)`,
        )
        .all()
        .map(toLink);

      const representativeOf = this.representatives(this.allLinks());
      const remove = this.db.prepare('DELETE FROM transfer_link WHERE id = ?');

      for (const link of doomed) {
        this.clearFlags(
          [link.debitTransactionId, link.creditTransactionId],
          representativeOf.get(link.id) ?? link.id,
          now,
        );
        remove.run(link.id);
      }
      return doomed.length;
    })();
  }

  // -------------------------------------------------------------- internals ---

  private allLinks(): TransferLinkRecord[] {
    return this.db.prepare<[], TransferLinkRow>(SELECT_LINK).all().map(toLink);
  }

  private machineLinks(): TransferLinkRecord[] {
    return this.db
      .prepare<[], TransferLinkRow>(`${SELECT_LINK} WHERE state IN ('auto', 'proposed')`)
      .all()
      .map(toLink);
  }

  /** Every link's group representative, by link id. */
  private representatives(links: readonly TransferLinkRecord[]): Map<string, string> {
    const byLink = new Map<string, string>();
    for (const group of groupLinks(links).values()) {
      for (const link of group) byLink.set(link.id, group[0].id);
    }
    return byLink;
  }

  /** The rows sharing this link's credit transaction *and* state — see the
   *  header on why the state is part of the key. */
  private groupFor(linkId: string): TransferLinkRecord[] {
    const link = this.db
      .prepare<[string], TransferLinkRow>(`${SELECT_LINK} WHERE id = ?`)
      .get(linkId);
    if (!link) return [];

    return this.db
      .prepare<[string, string], TransferLinkRow>(
        `${SELECT_LINK} WHERE credit_transaction_id = ? AND state = ?`,
      )
      .all(link.credit_transaction_id, link.state)
      .map(toLink)
      .sort(byCreatedThenId);
  }

  private toView(group: readonly TransferLinkRecord[]): TransferLinkView | null {
    const credit = this.transaction(group[0].creditTransactionId);
    if (!credit) return null;

    const debits = group
      .map((link) => this.transaction(link.debitTransactionId))
      .filter((row): row is TransactionRecord => row !== null)
      .sort((a, b) =>
        a.effectiveDate < b.effectiveDate
          ? -1
          : a.effectiveDate > b.effectiveDate
            ? 1
            : a.id < b.id
              ? -1
              : 1,
      );

    return {
      id: group[0].id,
      links: group,
      state: group[0].state,
      score: group[0].score,
      detailJson: group[0].detailJson,
      debits,
      credit,
      debitAccount: debits[0] ? this.account(debits[0].accountId) : null,
      creditAccount: this.account(credit.accountId),
      spendReductionCents: debits.reduce((total, row) => total + Math.abs(row.amountCents), 0),
    };
  }

  private transaction(id: string): TransactionRecord | null {
    const row = this.db
      .prepare<[string], TransactionRow>(`${SELECT_TRANSACTION} WHERE id = ?`)
      .get(id);
    return row ? toTransaction(row) : null;
  }

  private account(id: string): AccountRecord | null {
    const row = this.db.prepare<[string], AccountRow>(`${SELECT_ACCOUNT} WHERE id = ?`).get(id);
    return row ? toAccount(row) : null;
  }

  /** Turn the flag on and stamp the pair id. Returns how many rows moved. */
  private setFlags(transactionIds: readonly string[], pairId: string, now: string): number {
    const statement = this.db.prepare(
      `UPDATE "transaction"
          SET is_internal_transfer = 1, transfer_pair_id = ?, updated_at = ?
        WHERE id = ? AND (is_internal_transfer = 0 OR transfer_pair_id IS NOT ?)`,
    );
    let moved = 0;
    for (const id of new Set(transactionIds)) {
      moved += statement.run(pairId, now, id, pairId).changes;
    }
    return moved;
  }

  /**
   * Turn the flag off — but only on a row this link set.
   *
   * The `transfer_pair_id = ?` guard is the header's second note: §6.3's
   * hand-marked transfer carries a NULL pair id and must survive a run that
   * withdrew some unrelated link.
   */
  private clearFlags(transactionIds: readonly string[], pairId: string, now: string): number {
    const statement = this.db.prepare(
      `UPDATE "transaction"
          SET is_internal_transfer = 0, transfer_pair_id = NULL, updated_at = ?
        WHERE id = ? AND transfer_pair_id = ?`,
    );
    let moved = 0;
    for (const id of new Set(transactionIds)) {
      moved += statement.run(now, id, pairId).changes;
    }
    return moved;
  }
}

/** `(credit, state)` → its rows, oldest first. The group key of the header. */
function groupLinks(
  links: readonly TransferLinkRecord[],
): Map<string, TransferLinkRecord[]> {
  const groups = new Map<string, TransferLinkRecord[]>();
  for (const link of links) {
    const key = `${link.creditTransactionId}|${link.state}`;
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  for (const group of groups.values()) group.sort(byCreatedThenId);
  return groups;
}

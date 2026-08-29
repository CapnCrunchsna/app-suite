/**
 * §2.6's internal-transfer matcher — the "match" half of §2.5's `link` stage.
 *
 * §2.5 assigns that stage to "`analyzers` (match) + `data` (persist)", and this
 * file is the first half of that sentence: a pure function from a snapshot to a
 * set of proposals. It writes nothing, and `type:analyzers` cannot reach
 * `type:data-access` to try (§2.2). `apps/ledgerline-api` takes what comes out of
 * here and hands it to a repository.
 *
 * ## The asymmetry decides everything below
 *
 * §2.6: "A false link removes money from every total invisibly; a false negative
 * leaves a number that is visibly too big. The asymmetry decides the design:
 * **auto-link only the unambiguous case, propose everything else.**"
 *
 * That is why `disposition` is a three-way answer and not a boolean, why the
 * partial-payment pass never auto-links whatever it scores, and why every match
 * carries its `reasons` — a proposal a human has to confirm is a proposal that has
 * to say what it is made of. A queue of unexplained pairs gets confirmed by reflex,
 * and confirming by reflex is the false-link path with extra steps.
 *
 * ## Assignment is a matching problem, not a predicate
 *
 * The design session's rule was "same amount, within ±3 days", which says nothing
 * about *which* of four identical $500 transfers pairs with which. §2.6 replaces it
 * with a maximum-weight bipartite matching, greedy by descending score under a
 * one-to-one constraint, and that is the part a predicate structurally cannot do:
 * without it four identical transfers in a month produce sixteen "matches" and
 * sixteen chances to remove the same $500 four times over.
 *
 * ## Bucketing is a correctness condition on the whole design, not an optimization
 *
 * §2.2: "A naive all-pairs scan over 58,000 rows is 3.4 billion comparisons.
 * Bucket by `(abs(amount_cents), floor(date/86400))` first; only compare within a
 * bucket and its ±7-day neighbours." §3.2 puts an `INDEX (abs(amount_cents),
 * effective_date)` on `transaction` for exactly this. So candidates are generated
 * by index lookup into a `(magnitude, day)` map — nine day-lookups per debit — and
 * never by nested iteration over the transaction list.
 *
 * ## What the run owns and what the user owns
 *
 * A run re-derives the whole machine-owned set every time, so an auto-link whose
 * evidence has changed can be withdrawn. It never touches a pair the user has
 * settled: `takenTransactionIds` are already spoken for by a confirmed link, and
 * `rejectedPairKeys` are pairs a human has said no to. A rejection excludes the
 * *pair* rather than the two rows, because "that $500 is not this card payment"
 * says nothing about whether it is some other one.
 */

import {
  addDaysIso,
  daysBetweenIso,
  isSpendAtRealMerchant as spendAtRealMerchant,
} from '@metrum/ledgerline-domain';

import type { AnalyzerConfig, TransferConfig } from './config.js';
import type {
  Snapshot,
  SnapshotAccount,
  SnapshotCategory,
  SnapshotMerchant,
  SnapshotTransaction,
} from './snapshot.js';

export const TRANSFER_MATCHER_ID = 'transfer.v1';

/** §2.6's signals, as stable codes rather than prose. The sentence a user reads is
 *  built from these; the code is what a test asserts on. */
export type TransferSignal =
  | 'keyword_both_sides'
  | 'counterparty_last4'
  | 'credit_card_institution'
  | 'close_date_gap'
  | 'learned_rule'
  | 'recurring_spend_series'
  | 'spend_category';

export interface TransferReason {
  readonly signal: TransferSignal;
  readonly points: number;
  /** One sentence, already assembled — §6.2 shows "the score's reasons" and a page
   *  that had to turn a code into English would be a second place the scoring
   *  table is written down. */
  readonly detail: string;
}

/** §2.6's two *emitted* dispositions. Its third — "Score < 2 — no link" — has no
 *  representation because it produces nothing to represent; it is counted, in
 *  `TransferMatchResult.ignoredCount`. */
export type TransferDisposition = 'auto' | 'proposed';

/** One-to-one is §2.6's main pass; `partial` is the second pass, which "**always
 *  proposes, never auto-links**". */
export type TransferMatchKind = 'one_to_one' | 'partial';

export interface TransferMatch {
  readonly kind: TransferMatchKind;
  readonly disposition: TransferDisposition;
  /** Ordered by `(effectiveDate, id)`. One element unless `kind` is `partial`. */
  readonly debitTransactionIds: readonly string[];
  readonly creditTransactionId: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  /** A magnitude, always positive: the money that moved. §7.3's integer cents. */
  readonly amountCents: number;
  readonly score: number;
  readonly reasons: readonly TransferReason[];
  /** Largest `credit − debit` gap in the group, in days. Negative means the credit
   *  landed first, which §2.6 allows one day of. */
  readonly dayGapDays: number;
  /** The `transfer_rule` that contributed §2.6's learning bonus, if any. */
  readonly ruleId: string | null;
}

/** A persisted `recurring_series` (§3.1) as this matcher reads it. The table keys
 *  a series on `(merchant_id, account_id)`, and that pair is the whole of what
 *  §2.6's negative signal asks about. */
export interface SeriesKey {
  readonly merchantId: string;
  readonly accountId: string;
}

/** A learned `transfer_rule` (§3.1): "descriptor pattern + account pair". */
export interface TransferRule {
  readonly id: string;
  readonly descriptorPattern: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
}

export interface TransferMatchInput {
  readonly snapshot: Snapshot;
  /** From the *previous* run's `recurring_series`, not this one's. §2.5 puts
   *  `link` before `analyze`, so the series this run will compute do not exist
   *  yet — and using them would make linking and recurrence mutually recursive. */
  readonly seriesKeys?: readonly SeriesKey[];
  readonly rules?: readonly TransferRule[];
  /** Transactions inside a `confirmed` link. Spoken for; never re-matched. */
  readonly takenTransactionIds?: readonly string[];
  /** `debitId|creditId` for every `rejected` link. See `pairKey`. */
  readonly rejectedPairKeys?: readonly string[];
  readonly config: AnalyzerConfig;
}

export interface TransferMatchResult {
  /** Sorted for §2.4's T2 determinism: `(disposition, score desc, credit, debit)`. */
  readonly matches: readonly TransferMatch[];
  readonly autoLinkedCount: number;
  readonly proposedCount: number;
  /** Candidate pairs that scored below `proposeScore` — §2.6's third disposition.
   *  Counted rather than returned: they are the evidence that the thresholds are
   *  doing work, and there is nothing to show a user. */
  readonly ignoredCount: number;
  /** Accounts holding a transfer-shaped debit whose counterpart is not in the
   *  system, per §2.6's "What this cannot do". §6.2 says so where coverage is
   *  incomplete rather than leaving the user to wonder. */
  readonly unmatchedKeywordDebits: readonly UnmatchedTransferDebit[];
}

/** A debit that looks like a transfer and has no counterpart anywhere. §2.6:
 *  "there is no algorithmic fix, only importing the other side." */
export interface UnmatchedTransferDebit {
  readonly accountId: string;
  readonly transactionId: string;
  readonly effectiveDate: string;
  /** Magnitude. */
  readonly amountCents: number;
  readonly descriptionNormalized: string;
}

/** The `transfer_link` identity (§3.2's `UNIQUE (debit, credit)`), used here for
 *  the rejection set and by `data` for the row. */
export function pairKey(debitTransactionId: string, creditTransactionId: string): string {
  return `${debitTransactionId}|${creditTransactionId}`;
}

// --------------------------------------------------------------- the matcher ---

export function matchTransfers(input: TransferMatchInput): TransferMatchResult {
  const config = input.config.transfers;
  const context = buildContext(input);

  const debits = input.snapshot.transactions
    .filter((row) => row.amountCents < 0 && eligible(row, context.taken))
    .sort(byDateThenId);
  const credits = input.snapshot.transactions
    .filter((row) => row.amountCents > 0 && eligible(row, context.taken))
    .sort(byDateThenId);

  const creditIndex = indexByMagnitudeAndDate(credits);

  // ---------------------------------------------------- pass 1: one-to-one ---

  const candidates: ScoredPair[] = [];
  let ignoredCount = 0;

  for (const debit of debits) {
    for (const credit of creditsInWindow(creditIndex, debit, config)) {
      if (credit.accountId === debit.accountId) continue;
      if (context.rejected.has(pairKey(debit.id, credit.id))) continue;

      const scored = scorePair([debit], credit, context);
      if (scored.score < config.proposeScore) {
        ignoredCount += 1;
        continue;
      }
      candidates.push({ debit, credit, ...scored });
    }
  }

  const assigned = assignGreedily(candidates);

  const matches: TransferMatch[] = assigned.map((pair) => ({
    kind: 'one_to_one',
    // §2.6: "Score ≥ 5 — auto-link. In practice this means keyword-matched on both
    // sides plus one corroborator." Everything from `proposeScore` up to it is a
    // proposal, and a proposal is explicitly **not** excluded from spend.
    disposition: pair.score >= config.autoLinkScore ? 'auto' : 'proposed',
    debitTransactionIds: [pair.debit.id],
    creditTransactionId: pair.credit.id,
    debitAccountId: pair.debit.accountId,
    creditAccountId: pair.credit.accountId,
    amountCents: Math.abs(pair.debit.amountCents),
    score: pair.score,
    reasons: pair.reasons,
    dayGapDays: daysBetweenIso(pair.debit.effectiveDate, pair.credit.effectiveDate),
    ruleId: pair.ruleId,
  }));

  // ------------------------------------------------ pass 2: partial payments ---

  const usedDebits = new Set(assigned.map((pair) => pair.debit.id));
  const usedCredits = new Set(assigned.map((pair) => pair.credit.id));

  const partial = matchPartialPayments({
    debits: debits.filter((row) => !usedDebits.has(row.id)),
    credits: credits.filter((row) => !usedCredits.has(row.id)),
    context,
  });

  matches.push(...partial.matches);
  ignoredCount += partial.ignoredCount;

  for (const match of partial.matches) {
    for (const id of match.debitTransactionIds) usedDebits.add(id);
    usedCredits.add(match.creditTransactionId);
  }

  const ordered = matches.sort(byDispositionThenScore);

  return {
    matches: ordered,
    autoLinkedCount: ordered.filter((match) => match.disposition === 'auto').length,
    proposedCount: ordered.filter((match) => match.disposition === 'proposed').length,
    ignoredCount,
    unmatchedKeywordDebits: debits
      .filter((row) => !usedDebits.has(row.id) && hasKeyword(row, config))
      .map((row) => ({
        accountId: row.accountId,
        transactionId: row.id,
        effectiveDate: row.effectiveDate,
        amountCents: Math.abs(row.amountCents),
        descriptionNormalized: row.descriptionNormalized,
      })),
  };
}

/**
 * §2.6's `transfer_rule` pattern, derived from the debit a user just confirmed.
 *
 * Trailing tokens containing a digit are dropped, so `ONLINE PMT CARDINAL CARD
 * XXXX9012` learns as `ONLINE PMT CARDINAL CARD` and still matches next month's
 * statement when the reference number moves. Only *trailing* ones: a digit in the
 * middle is usually part of the name (`7-ELEVEN`, `1800 FLOWERS`), and eating it
 * would leave a pattern short enough to match half the account.
 *
 * Exported because the API writes the rule and the matcher reads it, and one
 * derivation used by both is the only way they can agree.
 */
export function transferRulePattern(descriptionNormalized: string): string {
  const tokens = descriptionNormalized.trim().split(/\s+/).filter(Boolean);

  let end = tokens.length;
  while (end > 1 && /\d/.test(tokens[end - 1])) end -= 1;

  const pattern = tokens.slice(0, end).join(' ');
  // A descriptor that is *entirely* digits has nothing stable to learn, so the
  // whole string is kept rather than a prefix that would match everything.
  return pattern.length >= 4 ? pattern : descriptionNormalized.trim();
}

// ------------------------------------------------------------------ internals ---

interface MatchContext {
  readonly config: TransferConfig;
  readonly accounts: ReadonlyMap<string, SnapshotAccount>;
  readonly merchants: ReadonlyMap<string, SnapshotMerchant>;
  readonly categories: ReadonlyMap<string, SnapshotCategory>;
  /** `merchantId|accountId` for every persisted series. */
  readonly seriesKeys: ReadonlySet<string>;
  readonly rules: readonly TransferRule[];
  readonly taken: ReadonlySet<string>;
  readonly rejected: ReadonlySet<string>;
}

interface PairScore {
  readonly score: number;
  readonly reasons: readonly TransferReason[];
  readonly ruleId: string | null;
}

interface ScoredPair extends PairScore {
  readonly debit: SnapshotTransaction;
  readonly credit: SnapshotTransaction;
}

function buildContext(input: TransferMatchInput): MatchContext {
  return {
    config: input.config.transfers,
    accounts: new Map(input.snapshot.accounts.map((account) => [account.id, account])),
    merchants: new Map(input.snapshot.merchants.map((merchant) => [merchant.id, merchant])),
    categories: new Map(input.snapshot.categories.map((category) => [category.id, category])),
    seriesKeys: new Set(
      (input.seriesKeys ?? []).map((key) => `${key.merchantId}|${key.accountId}`),
    ),
    rules: [...(input.rules ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    taken: new Set(input.takenTransactionIds ?? []),
    rejected: new Set(input.rejectedPairKeys ?? []),
  };
}

/**
 * Who may be a candidate at all.
 *
 * Pending rows are out because §2.5 puts them out of "every analyzer and every
 * total" — an authorization that has not settled has no amount to match on yet.
 * A refunded row is out because §3.3 already paired it inside one account, and a
 * row that is both a reversal and a transfer is one of them mis-parsed. A row the
 * user excluded is out by their own instruction. And `transfer_pair_id` is *not*
 * a disqualifier: an auto-link from a previous run is the run's to re-derive, and
 * skipping those rows is how a withdrawn link would become permanent.
 */
function eligible(row: SnapshotTransaction, taken: ReadonlySet<string>): boolean {
  return (
    !row.isPending &&
    !row.isExcluded &&
    row.refundPairId === null &&
    row.amountCents !== 0 &&
    !taken.has(row.id)
  );
}

/** §3.2's `INDEX (abs(amount_cents), effective_date)`, in memory: magnitude →
 *  date → rows. Built once per run, read nine times per debit. */
function indexByMagnitudeAndDate(
  rows: readonly SnapshotTransaction[],
): ReadonlyMap<number, ReadonlyMap<string, readonly SnapshotTransaction[]>> {
  const index = new Map<number, Map<string, SnapshotTransaction[]>>();

  for (const row of rows) {
    const magnitude = Math.abs(row.amountCents);
    let byDate = index.get(magnitude);
    if (!byDate) {
      byDate = new Map();
      index.set(magnitude, byDate);
    }
    const bucket = byDate.get(row.effectiveDate);
    if (bucket) bucket.push(row);
    else byDate.set(row.effectiveDate, [row]);
  }

  return index;
}

/** The bucket and its ±window neighbours, per §2.2 — never a scan. */
function creditsInWindow(
  index: ReadonlyMap<number, ReadonlyMap<string, readonly SnapshotTransaction[]>>,
  debit: SnapshotTransaction,
  config: TransferConfig,
): readonly SnapshotTransaction[] {
  const byDate = index.get(Math.abs(debit.amountCents));
  if (!byDate) return [];

  const found: SnapshotTransaction[] = [];
  for (let offset = config.windowMinDays; offset <= config.windowMaxDays; offset += 1) {
    const bucket = byDate.get(addDaysIso(debit.effectiveDate, offset));
    if (bucket) found.push(...bucket);
  }
  return found;
}

/**
 * §2.6's scoring table, taken verbatim.
 *
 * Written over a *set* of debits rather than one so the partial pass shares it.
 * The quantifiers are the honest reading of each signal for a group: a keyword
 * match has to hold on every part (one transfer-labelled leg out of three proves
 * nothing about the other two), while every corroborator and both penalties are
 * satisfied by any part.
 */
function scorePair(
  debits: readonly SnapshotTransaction[],
  credit: SnapshotTransaction,
  context: MatchContext,
): PairScore {
  const { config } = context;

  const debitAccount = context.accounts.get(debits[0].accountId);
  const creditAccount = context.accounts.get(credit.accountId);

  const reasons: TransferReason[] = [];
  let ruleId: string | null = null;

  // +3 — both descriptors match the transfer keyword list.
  if (debits.every((row) => hasKeyword(row, config)) && hasKeyword(credit, config)) {
    reasons.push({
      signal: 'keyword_both_sides',
      points: config.pointsKeywordBothSides,
      detail: 'Both descriptors read as a transfer or a card payment.',
    });
  }

  // +2 — either descriptor contains the other account's last4.
  const last4 = matchedLast4(debits, credit, debitAccount, creditAccount);
  if (last4 !== null) {
    reasons.push({
      signal: 'counterparty_last4',
      points: config.pointsCounterpartyLast4,
      detail: `One descriptor names the other account's last four digits (${last4}).`,
    });
  }

  // +2 — B is a credit card and the debit's descriptor names B's institution.
  const institution = matchedInstitution(debits, creditAccount, config);
  if (institution !== null) {
    reasons.push({
      signal: 'credit_card_institution',
      points: config.pointsCreditCardInstitution,
      detail: `The payment names ${institution}, which is the card being paid.`,
    });
  }

  // +1 — date gap ≤ 3 days. The design session wanted this as the *predicate*;
  // §2.6 widened the window to seven and kept three as a corroborator, because a
  // holiday-weekend ACH is a real transfer and a same-day match is better evidence.
  const gaps = debits.map((row) => daysBetweenIso(row.effectiveDate, credit.effectiveDate));
  const widestGap = gaps.reduce((widest, gap) => (Math.abs(gap) > Math.abs(widest) ? gap : widest), 0);
  if (Math.abs(widestGap) <= config.closeGapDays) {
    reasons.push({
      signal: 'close_date_gap',
      points: config.pointsCloseGap,
      detail:
        widestGap === 0
          ? 'Both legs landed on the same day.'
          : `${Math.abs(widestGap)} day${Math.abs(widestGap) === 1 ? '' : 's'} apart.`,
    });
  }

  // +3 — §2.6's learning. A pair the user has confirmed once auto-links after.
  const rule = matchedRule(debits, credit, context);
  if (rule) {
    ruleId = rule.id;
    reasons.push({
      signal: 'learned_rule',
      points: config.pointsLearnedRule,
      detail: `You have confirmed this pairing before (${rule.descriptorPattern}).`,
    });
  }

  // −2 — either side already belongs to a recurring series at a merchant that is
  // not transfer-kind. A subscription is not a transfer, however round the number.
  const series = [...debits, credit].find((row) => inSpendSeries(row, context));
  if (series) {
    reasons.push({
      signal: 'recurring_spend_series',
      points: config.pointsRecurringSpendSeries,
      detail: 'One side is already a charge in a recurring subscription.',
    });
  }

  // −2 — either side's category kind is `spend` at a non-transfer merchant.
  const spend = [...debits, credit].find((row) => isSpendAtRealMerchant(row, context));
  if (spend) {
    reasons.push({
      signal: 'spend_category',
      points: config.pointsSpendCategory,
      detail: 'One side is categorized as spending at a real merchant.',
    });
  }

  return {
    score: reasons.reduce((total, reason) => total + reason.points, 0),
    reasons,
    ruleId,
  };
}

/**
 * The descriptor as printed, for the two signals that ask what it *says*.
 *
 * §4.1's stage 3 strips masked account numbers on the way to a merchant key, so
 * `ONLINE PMT CARDINAL CARD XXXX9012` reaches `description_normalized` as
 * `ONLINE PMT CARDINAL CARD` — with the four digits §2.6 scores +2 for already
 * gone. Both forms are searched rather than the raw one alone, because
 * normalization also *repairs* descriptors (unicode dashes folded, whitespace
 * collapsed) and a keyword can survive in one form and not the other.
 */
function descriptorText(row: SnapshotTransaction): string {
  return `${row.descriptionNormalized}\n${row.descriptionRaw.toUpperCase()}`;
}

function hasKeyword(row: SnapshotTransaction, config: TransferConfig): boolean {
  const text = descriptorText(row);
  return config.keywords.some((keyword) => text.includes(keyword));
}

function matchedLast4(
  debits: readonly SnapshotTransaction[],
  credit: SnapshotTransaction,
  debitAccount: SnapshotAccount | undefined,
  creditAccount: SnapshotAccount | undefined,
): string | null {
  const creditLast4 = creditAccount?.last4;
  if (creditLast4 && debits.some((row) => descriptorText(row).includes(creditLast4))) {
    return creditLast4;
  }
  const debitLast4 = debitAccount?.last4;
  if (debitLast4 && descriptorText(credit).includes(debitLast4)) {
    return debitLast4;
  }
  return null;
}

/**
 * "B is a credit card and the debit's descriptor names B's institution."
 *
 * Token-wise, because the printed form almost never equals the stored one: a bank
 * stored as "Cardinal Bank" prints `ONLINE PMT CARDINAL CARD XXXX9012`. Generic
 * tokens are dropped first — without that, `CARD` alone would make every
 * institution match every card payment and turn a +2 corroborator into a constant.
 */
function matchedInstitution(
  debits: readonly SnapshotTransaction[],
  creditAccount: SnapshotAccount | undefined,
  config: TransferConfig,
): string | null {
  if (!creditAccount || creditAccount.accountType !== 'credit_card') return null;
  if (!creditAccount.institution) return null;

  const upper = creditAccount.institution.toUpperCase();
  if (debits.some((row) => descriptorText(row).includes(upper))) return creditAccount.institution;

  const stopWords = new Set(config.institutionStopWords);
  const tokens = upper
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length >= config.institutionTokenMinLength && !stopWords.has(token));

  for (const token of tokens) {
    const word = new RegExp(`(^|[^A-Z0-9])${token}([^A-Z0-9]|$)`);
    if (debits.some((row) => word.test(descriptorText(row)))) return creditAccount.institution;
  }
  return null;
}

function matchedRule(
  debits: readonly SnapshotTransaction[],
  credit: SnapshotTransaction,
  context: MatchContext,
): TransferRule | null {
  for (const rule of context.rules) {
    if (rule.creditAccountId !== credit.accountId) continue;
    if (!debits.every((row) => row.accountId === rule.debitAccountId)) continue;
    if (debits.every((row) => row.descriptionNormalized.startsWith(rule.descriptorPattern))) {
      return rule;
    }
  }
  return null;
}

function inSpendSeries(row: SnapshotTransaction, context: MatchContext): boolean {
  if (row.merchantId === null) return false;
  if (!context.seriesKeys.has(`${row.merchantId}|${row.accountId}`)) return false;
  return context.merchants.get(row.merchantId)?.isTransferKind !== true;
}

/**
 * §2.6's second penalty. The rule itself is `domain`'s `isSpendAtRealMerchant`;
 * this resolves a snapshot row against the run's category and merchant tables and
 * hands it over.
 *
 * Split that way because §6.3's manual transfer toggle needs the same judgement
 * about a single row and cannot import this lib (§2.2). One rule, two callers —
 * see `transfer-signals.ts` for why a copy in the UI was the wrong answer.
 */
function isSpendAtRealMerchant(row: SnapshotTransaction, context: MatchContext): boolean {
  const merchant = row.merchantId === null ? undefined : context.merchants.get(row.merchantId);
  return spendAtRealMerchant({
    categoryKind: (row.categoryId === null ? null : context.categories.get(row.categoryId)?.kind) ?? null,
    merchantIsTransferKind: merchant === undefined ? null : merchant.isTransferKind,
  });
}

/**
 * §2.6's assignment: "a **maximum-weight bipartite matching** (greedy by
 * descending score with a one-to-one constraint is sufficient at this scale)".
 *
 * Greedy is not optimal in general — a high-scoring pair can block two slightly
 * lower ones worth more together — and §2.6 accepts that explicitly. The tie-break
 * chain after `score` is not cosmetic: it is what makes a run reproducible (§2.4's
 * T2), and without it `Map` iteration order would decide which of four identical
 * $500 transfers pairs with which.
 */
function assignGreedily(candidates: readonly ScoredPair[]): ScoredPair[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(daysBetweenIso(a.debit.effectiveDate, a.credit.effectiveDate)) -
        Math.abs(daysBetweenIso(b.debit.effectiveDate, b.credit.effectiveDate)) ||
      compare(a.debit.effectiveDate, b.debit.effectiveDate) ||
      compare(a.debit.id, b.debit.id) ||
      compare(a.credit.id, b.credit.id),
  );

  const usedDebits = new Set<string>();
  const usedCredits = new Set<string>();
  const assigned: ScoredPair[] = [];

  for (const pair of ordered) {
    if (usedDebits.has(pair.debit.id) || usedCredits.has(pair.credit.id)) continue;
    usedDebits.add(pair.debit.id);
    usedCredits.add(pair.credit.id);
    assigned.push(pair);
  }

  return assigned;
}

/**
 * §2.6's second pass: "a single credit in B against a set of ≤3 debits in A inside
 * the window summing exactly to it — and **always proposes, never auto-links**.
 * Combinatorics over more than three parts is not worth the false-positive risk."
 *
 * The `disposition` is therefore a constant here and not a comparison against
 * `autoLinkScore`. A three-part split that scores 8 is still three separate rows a
 * human has to agree describe one payment, and the score's job on this path is to
 * *explain* the proposal rather than to authorize it.
 *
 * The propose floor still applies. Arithmetic alone is much weaker evidence here
 * than in pass 1 — any three debits in a week that happen to total a credit
 * qualify — so a group with no corroborating signal at all is exactly the noise
 * §2.6's asymmetry says to leave out. See §9f.
 */
function matchPartialPayments(input: {
  readonly debits: readonly SnapshotTransaction[];
  readonly credits: readonly SnapshotTransaction[];
  readonly context: MatchContext;
}): { matches: TransferMatch[]; ignoredCount: number } {
  const { context } = input;
  const { config } = context;

  const usedDebits = new Set<string>();
  const matches: TransferMatch[] = [];
  let ignoredCount = 0;

  // Largest credits first: a $900 card payment split three ways should claim its
  // parts before a $300 one that could use two of the same rows.
  const credits = [...input.credits].sort(
    (a, b) => b.amountCents - a.amountCents || compare(a.id, b.id),
  );

  for (const credit of credits) {
    const earliest = addDaysIso(credit.effectiveDate, -config.windowMaxDays);
    const latest = addDaysIso(credit.effectiveDate, -config.windowMinDays);

    const pool = input.debits
      .filter(
        (row) =>
          !usedDebits.has(row.id) &&
          row.accountId !== credit.accountId &&
          row.effectiveDate >= earliest &&
          row.effectiveDate <= latest &&
          Math.abs(row.amountCents) < credit.amountCents,
      )
      // Nearest first, so the cap keeps the most plausible parts rather than an
      // arbitrary slice of the window.
      .sort(
        (a, b) =>
          Math.abs(daysBetweenIso(a.effectiveDate, credit.effectiveDate)) -
            Math.abs(daysBetweenIso(b.effectiveDate, credit.effectiveDate)) ||
          compare(a.id, b.id),
      )
      .slice(0, config.maxPartialCandidates);

    const group = findExactSubset(pool, credit.amountCents, config.maxPartialParts);
    if (!group) continue;

    // §2.6 is about one payment from one account, so a "split" assembled out of
    // two different accounts is not the thing this pass exists to find.
    const accountId = group[0].accountId;
    if (!group.every((row) => row.accountId === accountId)) continue;

    const scored = scorePair(group, credit, context);
    if (scored.score < config.proposeScore) {
      ignoredCount += 1;
      continue;
    }

    const ordered = [...group].sort(byDateThenId);
    for (const row of ordered) usedDebits.add(row.id);

    matches.push({
      kind: 'partial',
      disposition: 'proposed',
      debitTransactionIds: ordered.map((row) => row.id),
      creditTransactionId: credit.id,
      debitAccountId: accountId,
      creditAccountId: credit.accountId,
      amountCents: credit.amountCents,
      score: scored.score,
      reasons: scored.reasons,
      dayGapDays: ordered
        .map((row) => daysBetweenIso(row.effectiveDate, credit.effectiveDate))
        .reduce((widest, gap) => (Math.abs(gap) > Math.abs(widest) ? gap : widest), 0),
      ruleId: scored.ruleId,
    });
  }

  return { matches, ignoredCount };
}

/**
 * The smallest set of at most `maxParts` rows whose magnitudes sum exactly to
 * `targetCents`, or null.
 *
 * Enumerated rather than solved: the pool is capped and `maxParts` is three, so
 * this is at worst `C(24,2) + C(24,3)` = 2,300 integer additions per credit. Two
 * parts are tried before three, because a two-way split is both more common and
 * more believable than a three-way one.
 *
 * Sets of one are deliberately never tried. A single debit equal to the credit is
 * pass 1's candidate by definition, so anything a size-1 search found here would
 * be a pair the one-to-one pass had already scored below the floor or spent — and
 * re-offering it as a "partial payment" would be laundering a rejected match
 * through a weaker rule.
 */
function findExactSubset(
  pool: readonly SnapshotTransaction[],
  targetCents: number,
  maxParts: number,
): SnapshotTransaction[] | null {
  const magnitude = (row: SnapshotTransaction): number => Math.abs(row.amountCents);

  for (let size = 2; size <= maxParts; size += 1) {
    const found = subsetOfSize(pool, targetCents, size, 0, [], magnitude);
    if (found) return found;
  }
  return null;
}

function subsetOfSize(
  pool: readonly SnapshotTransaction[],
  remaining: number,
  size: number,
  start: number,
  chosen: SnapshotTransaction[],
  magnitude: (row: SnapshotTransaction) => number,
): SnapshotTransaction[] | null {
  if (size === 0) return remaining === 0 ? [...chosen] : null;

  for (let index = start; index <= pool.length - size; index += 1) {
    const value = magnitude(pool[index]);
    if (value > remaining) continue;
    chosen.push(pool[index]);
    const found = subsetOfSize(pool, remaining - value, size - 1, index + 1, chosen, magnitude);
    chosen.pop();
    if (found) return found;
  }
  return null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byDateThenId = (a: SnapshotTransaction, b: SnapshotTransaction): number =>
  compare(a.effectiveDate, b.effectiveDate) || compare(a.id, b.id);

/** Auto-links first, then the queue's own order: biggest score, then biggest
 *  money, then ids. Total and deterministic (§2.4's T2). */
const byDispositionThenScore = (a: TransferMatch, b: TransferMatch): number =>
  (a.disposition === b.disposition ? 0 : a.disposition === 'auto' ? -1 : 1) ||
  b.score - a.score ||
  b.amountCents - a.amountCents ||
  compare(a.creditTransactionId, b.creditTransactionId) ||
  compare(a.debitTransactionIds[0], b.debitTransactionIds[0]);

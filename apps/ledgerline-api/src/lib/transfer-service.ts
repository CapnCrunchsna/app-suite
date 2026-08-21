/**
 * §2.5's `link` stage, wired: match in `analyzers`, persist in `data`.
 *
 * The same shape as `analysis-service.ts` and for the same reason — §2.1 reserves
 * exactly this job for the composition root. `matchTransfers` is a pure function
 * of a snapshot and cannot reach a table; `TransferRepository` holds the tables
 * and cannot reach the matcher. They meet here.
 *
 * ## The three inputs only this file can assemble
 *
 * **Last run's series.** §2.6's first negative signal asks whether a side "already
 * belongs to a `recurring_series`". That is the persisted table, and it has to be:
 * §2.5 puts `link` *before* `analyze`, so the series this run is about to compute
 * do not exist yet, and consulting them would make linking and recurrence mutually
 * recursive. Reading the previous run's is both what §2.6 says and the only
 * ordering that terminates.
 *
 * **The learned rules.** §2.6's "Learning": confirming a proposal writes a
 * `transfer_rule` that scores +3 next run, so a monthly card payment is confirmed
 * once and auto-links thereafter. `confirmTransfer` below is where that is
 * written, and `transferRulePattern` — which lives in `analyzers` beside the
 * matcher that reads it — is what keeps the two halves agreeing on what a pattern
 * is.
 *
 * **What the user has settled.** A confirmed link's rows are spoken for; a
 * rejected pair is one a human has already answered. Neither is the matcher's to
 * revisit, and neither is knowable from a snapshot.
 *
 * ## Why running this costs a second snapshot
 *
 * §2.2's "one snapshot per run, not one per analyzer" is a rule about the nine
 * rules sharing one load — "nine independent loads would be nine times the query
 * cost". This stage is not one of the nine: it *writes* `is_internal_transfer`,
 * which is a column every one of them reads, so a snapshot taken before it is
 * stale by construction and reusing it would analyze the state of the world one
 * step behind. Two loads, not nine, and the second is what makes the first
 * correct. See §9f.
 */

import { matchTransfers, transferRulePattern } from '@metrum/ledgerline-analyzers';
import type { TransferMatch } from '@metrum/ledgerline-analyzers';
import type { TransferLinkInput, TransferLinkView } from '@metrum/ledgerline-data';

import { resolveAnalyzerConfig } from './analysis-service.js';
import type { LedgerlineContext } from './context.js';

export interface TransferLinkSummary {
  /** Pairs that scored `≥ autoLinkScore` and left the totals without being asked
   *  (§2.6). */
  readonly autoLinked: number;
  /** Pairs in §6.2's queue. **Still counted as spend** until confirmed. */
  readonly proposed: number;
  /** Candidates that scored below the propose floor. Reported because a matcher
   *  that ignored everything and a matcher that saw nothing look identical
   *  otherwise. */
  readonly ignored: number;
  readonly inserted: number;
  readonly updated: number;
  readonly withdrawn: number;
  readonly flagged: number;
  readonly unflagged: number;
  /** §2.6's "What this cannot do": transfer-shaped debits with no counterpart in
   *  the system. §6.2 says so rather than leaving the user to wonder. */
  readonly unmatchedByAccount: Readonly<Record<string, number>>;
}

/**
 * Run §2.6 over everything and persist the answer.
 *
 * Called from three places, all of which want the same thing: after a commit
 * (§2.5's pipeline order), at the head of an analysis run (so the numbers §6.4
 * shows are computed after linking), and from `POST /api/transfers/propose` when
 * the user asks (§2.3).
 */
export function runTransferLinking(context: LedgerlineContext): TransferLinkSummary {
  const config = resolveAnalyzerConfig(context);
  const store = context.store;

  const result = matchTransfers({
    snapshot: store.buildSnapshot(),
    seriesKeys: store.analysis
      .listSeries()
      .map((series) => ({ merchantId: series.merchantId, accountId: series.accountId })),
    rules: store.transfers.listRules().map((rule) => ({
      id: rule.id,
      descriptorPattern: rule.descriptorPattern,
      debitAccountId: rule.debitAccountId,
      creditAccountId: rule.creditAccountId,
    })),
    takenTransactionIds: store.transfers.listTakenTransactionIds(),
    rejectedPairKeys: store.transfers.listRejectedPairKeys(),
    config,
  });

  const applied = store.transfers.replaceMachineLinks(result.matches.flatMap(toLinkRows));

  const unmatchedByAccount: Record<string, number> = {};
  for (const debit of result.unmatchedKeywordDebits) {
    unmatchedByAccount[debit.accountId] = (unmatchedByAccount[debit.accountId] ?? 0) + 1;
  }

  return {
    autoLinked: result.autoLinkedCount,
    proposed: result.proposedCount,
    ignored: result.ignoredCount,
    inserted: applied.inserted,
    updated: applied.updated,
    withdrawn: applied.removed,
    flagged: applied.flagged,
    unflagged: applied.unflagged,
    unmatchedByAccount,
  };
}

/**
 * §2.6's confirm, plus the learning that makes it worth doing once.
 *
 * The rule is written from the *debit* descriptor because that is the side whose
 * wording is stable: a checking account prints `ONLINE PMT CARDINAL CARD XXXX9012`
 * every month, while the card's own `PAYMENT THANK YOU - WEB` says nothing about
 * which account paid it. A rule keyed on the credit would fire for every payment
 * to that card from anywhere.
 *
 * A partial group writes no rule. §2.6's learning is about a repeating pairing,
 * and "these three debits totalled that credit" is an arithmetic coincidence of
 * one month rather than a pattern to expect again.
 */
export function confirmTransfer(
  context: LedgerlineContext,
  linkId: string,
): TransferLinkView | null {
  const view = context.store.transfers.confirm(linkId);
  if (!view) return null;

  if (view.debits.length === 1 && view.debitAccount && view.creditAccount) {
    context.store.transfers.upsertRule({
      descriptorPattern: transferRulePattern(view.debits[0].descriptionNormalized),
      debitAccountId: view.debitAccount.id,
      creditAccountId: view.creditAccount.id,
    });
  }

  return view;
}

/**
 * One `transfer_link` row per debit.
 *
 * §3.1 models a link as one debit and one credit, so §2.6's partial payment is
 * two or three rows sharing a credit — which `ix_transfer_link_credit` is the
 * index for, and which `TransferRepository` reads back as one group. The reasons
 * ride on every row rather than only the first, so a row read on its own still
 * explains itself.
 */
function toLinkRows(match: TransferMatch): TransferLinkInput[] {
  const detailJson = JSON.stringify({
    kind: match.kind,
    disposition: match.disposition,
    reasons: match.reasons,
    dayGapDays: match.dayGapDays,
    amountCents: match.amountCents,
    debitTransactionIds: match.debitTransactionIds,
  });

  return match.debitTransactionIds.map((debitTransactionId) => ({
    debitTransactionId,
    creditTransactionId: match.creditTransactionId,
    score: match.score,
    state: match.disposition,
    ruleId: match.ruleId,
    detailJson,
  }));
}

/** The shape `detail_json` holds, for the route that parses it back. Declared
 *  here because this file is the only one that writes it. */
export interface TransferLinkDetail {
  readonly kind: TransferMatch['kind'];
  readonly disposition: TransferMatch['disposition'];
  readonly reasons: TransferMatch['reasons'];
  readonly dayGapDays: number;
  readonly amountCents: number;
  readonly debitTransactionIds: readonly string[];
}

export function parseTransferDetail(detailJson: string | null): TransferLinkDetail | null {
  if (!detailJson) return null;
  try {
    return JSON.parse(detailJson) as TransferLinkDetail;
  } catch {
    // A payload written by an older matcher, or by hand. The score is still on
    // the row, so the queue degrades to "no reasons recorded" rather than to an
    // error — §6.2 needs the pair on screen more than it needs the explanation.
    return null;
  }
}

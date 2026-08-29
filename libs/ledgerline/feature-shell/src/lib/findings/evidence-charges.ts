/**
 * Which of a finding's cited transactions a card asks for, and which it shows.
 *
 * Pure and separate from both components, the same way `virtual-window.ts` is
 * separate from the transactions table: the two caps below are the whole of the
 * design and a spec should be able to assert on them without a DOM or a fetch.
 *
 * §6.4 wants the charges behind a card on the card. §5.1 hands over an unbounded
 * list of ids to get them with — it caps a *rule* at 25 findings and says nothing
 * about how many transactions one finding may cite, and two rules cite a great
 * many by design. So the page cannot simply ask for all of them, and this file is
 * where it decides what to ask for instead.
 */

import type { Finding, Transaction } from '@metrum/api-client';

/**
 * How many charges one card may show.
 *
 * §6.4 asks for "a compact charge history or mini-table", and compact is the
 * operative word: a `recurrence.v1` card over this workspace's own statement
 * cites 32 charges and a `micro.v1` group can cite more. Six is the largest
 * number that still reads as a sample beside the rule's `detail` rows rather than
 * as the transactions page relocated onto a card, and it covers every charge of a
 * typical price-creep or lapsed finding outright.
 */
export const EVIDENCE_PER_CARD = 6;

/**
 * How many ids the page will put in one URL.
 *
 * `GET /api/transactions` bounds its `ids` parameter at 8 KB, because Node caps a
 * request's whole header block — request line included — and an over-long URL
 * fails as a socket error with no route entered and nothing in the log. 160
 * UUIDs is about 5.9 KB: under that with room to spare, and above what a
 * realistic page needs. This workspace's own statement produces thirteen findings
 * citing 72 transactions in total.
 *
 * The budget bites only on a page more than 27 cards deep, and it bites at the
 * bottom — see `evidenceIdsForPage`.
 */
export const EVIDENCE_ID_BUDGET = 160;

/**
 * The ids one card would like: its **most recent** `EVIDENCE_PER_CARD` charges.
 *
 * The tail rather than the head, and that is only meaningful because
 * `FindingRepository.listEvidence` was changed to order by the transaction's
 * `effective_date`. It used to order by `transaction_id`, and ids are
 * `randomUUID`, so "the first six" was six arbitrary charges presented as though
 * they were a sample of something. Recency is the property that makes six of
 * thirty-two worth showing: those are the charges the reader can still recognise
 * against a statement they have seen.
 */
export function evidenceIdsFor(finding: Finding): readonly string[] {
  return finding.evidenceTransactionIds.slice(-EVIDENCE_PER_CARD);
}

/**
 * The union of ids for one page load, in the reader's own order and under budget.
 *
 * `findings` arrives in display order — §6.4's groups sorted by impact, cards
 * sorted by impact within them — and is consumed in that order, so the budget
 * runs out at the bottom of the page rather than somewhere arbitrary. A card
 * past it renders exactly as every card did before this existed: its `detail`
 * rows and its charge count.
 *
 * Deduplicated because two findings can cite the same transaction — an outlier
 * charge inside a series a price-creep finding also cites — and asking for it
 * twice would spend budget on a row already in hand.
 */
export function evidenceIdsForPage(findings: readonly Finding[]): readonly string[] {
  const union = new Set<string>();

  for (const finding of findings) {
    for (const id of evidenceIdsFor(finding)) {
      if (union.size >= EVIDENCE_ID_BUDGET) return [...union];
      union.add(id);
    }
  }

  return [...union];
}

/**
 * What one card actually renders, newest charge first.
 *
 * Sorted here rather than trusted from the response: the page asks for the union
 * in one request, so the rows come back in *that* request's order and a card is
 * reading a slice of it. `effective_date` is §7.1's one date; the id breaks a tie
 * so two charges on the same day cannot swap places between renders.
 *
 * An id with no row is skipped rather than rendered as a gap. The page's budget
 * is one way that happens and it is not the interesting one — a transaction
 * deleted with its import (§3.3) leaves a finding citing it until the next
 * analysis run resolves the finding, and a blank line in a table of charges is a
 * worse answer than a shorter table.
 */
export function chargesFor(
  finding: Finding,
  byId: ReadonlyMap<string, Transaction>,
): readonly Transaction[] {
  return evidenceIdsFor(finding)
    .map((id) => byId.get(id))
    .filter((row): row is Transaction => row !== undefined)
    .sort(
      (a, b) =>
        b.effectiveDate.localeCompare(a.effectiveDate) || b.id.localeCompare(a.id),
    );
}

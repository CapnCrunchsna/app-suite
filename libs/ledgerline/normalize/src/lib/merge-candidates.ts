/**
 * Merge candidates — §4.1 step 7's review queue, given something to review.
 *
 * ## Why this exists at all
 *
 * §4.1's chain is deterministic, and §4.1 stage 4 is explicit about why it stays
 * that way: "over-stripping silently merges two merchants and every §5 rule groups
 * by merchant, while under-stripping leaves `STARBUCKS SEATTLE`, which is *stable*
 * and therefore still groups correctly, only less prettily." The chain is built to
 * fail toward two merchants rather than toward one wrong one.
 *
 * That is the right default and it leaves a residue: `SAMSCLUB` and `SAMS CLUB`
 * differ by a space the bank chose, both run the chain cleanly, and **neither is
 * wrong**. No amount of rule-writing settles it, because the question is not about
 * the descriptors — it is about what the user's world contains. So the chain does
 * not answer it. It asks.
 *
 * Detection is cheap even though resolution is not, which is the whole asymmetry
 * this module trades on. `trigramSimilarity` is already here for §4.1 step 6's
 * fuzzy alias lookup; the only new idea is running it *between merchants* instead
 * of between a descriptor and an alias.
 *
 * ## Why the floor here sits below `FUZZY_SIMILARITY_FLOOR`
 *
 * That floor is 0.72 because a fuzzy alias **auto-applies** — it resolves a
 * descriptor with nobody watching, and its own note explains that a wrong merge is
 * "close to invisible". Nothing here auto-applies. A candidate becomes a card with
 * two merchant names, two transaction counts and a button, and the cost of a wrong
 * proposal is that a person reads it and says no.
 *
 * The floors are answering different questions, so they are different numbers: one
 * bounds what the machine may do silently, this one bounds what is worth showing a
 * person.
 */

import { trigramSimilarity } from './alias.js';

/**
 * The floor a pair must clear to be proposed.
 *
 * **Uncalibrated in the §7.6 sense**, and honestly so: it is one number from one
 * statement. Measured there, the two real splits scored 0.769 (a merchant printed
 * with and without its processor prefix) and 0.583 (a spacing variant), and the
 * highest-scoring pair that was *not* a duplicate sat far below both. Half is a
 * round number in that gap rather than a derived one.
 */
export const MERGE_PROPOSAL_FLOOR = 0.5;

/**
 * Both sides must have at least this many transactions.
 *
 * This guard is doing more work than the floor is. A statement's long tail is
 * one-off descriptors that survived stage 5 with a reference number attached, and
 * they are similar to *each other* in exactly the way trigrams measure — so
 * without a count guard the queue fills with pairs of single purchases at the same
 * merchant, which is noise wearing the costume of a finding. Requiring both sides
 * to recur asks for evidence that each name is a thing the user deals with, not a
 * string that happened once.
 *
 * On the first real statement this took the candidate list from 48 pairs to one,
 * and the one was correct.
 */
export const MERGE_PROPOSAL_MIN_TRANSACTIONS = 2;

/** A ceiling on the list, for the same reason §5.1 caps findings per rule: an
 *  unbounded queue is one bad threshold away from being unreadable, and a review
 *  queue nobody reads resolves nothing. */
export const MERGE_PROPOSAL_MAX = 25;

/** What the queue needs to know about a merchant to reason about it. `source` is
 *  §3.1's provenance — `seed` merchants are shipped canonicals. */
export interface MergeSubject {
  readonly merchantId: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly transactionCount: number;
  readonly source: string;
}

export interface MergeCandidate {
  /** The merchant proposed to survive: the one with more transactions, so the
   *  default direction moves the smaller history onto the larger. Ties break on
   *  name, so the proposal is stable across runs. */
  readonly keep: MergeSubject;
  readonly merge: MergeSubject;
  readonly similarity: number;
}

export interface MergeProposalOptions {
  readonly floor?: number;
  readonly minTransactions?: number;
  readonly max?: number;
}

/**
 * Every pair of merchants similar enough to be worth asking about.
 *
 * Pairwise and quadratic, deliberately. A statement resolves to tens of merchant
 * identities, not thousands — the first real one produced 21 — so this is a few
 * hundred string comparisons on a set that only changes when an import commits.
 * Blocking or indexing the comparison would be a real optimisation against a load
 * that does not exist, and would put a second similarity notion in the codebase
 * for §4.1 step 6's to disagree with.
 */
export function proposeMerchantMerges(
  merchants: readonly MergeSubject[],
  options: MergeProposalOptions = {},
): MergeCandidate[] {
  const floor = options.floor ?? MERGE_PROPOSAL_FLOOR;
  const minTransactions = options.minTransactions ?? MERGE_PROPOSAL_MIN_TRANSACTIONS;
  const max = options.max ?? MERGE_PROPOSAL_MAX;

  const eligible = merchants.filter((merchant) => merchant.transactionCount >= minTransactions);
  const candidates: MergeCandidate[] = [];

  for (let left = 0; left < eligible.length; left += 1) {
    for (let right = left + 1; right < eligible.length; right += 1) {
      const a = eligible[left];
      const b = eligible[right];

      // Two shipped canonicals are two merchants somebody already decided about.
      // `AMAZON` and `AMAZON PRIME` are the shape this protects: similar names,
      // deliberately separate, and §5.4's overlap groups are where that
      // relationship belongs rather than here.
      if (a.source === 'seed' && b.source === 'seed') continue;

      const similarity = trigramSimilarity(a.canonicalName, b.canonicalName);
      if (similarity < floor) continue;

      candidates.push({ ...directionFor(a, b), similarity });
    }
  }

  return candidates
    .sort((x, y) => y.similarity - x.similarity || compareNames(x, y))
    .slice(0, max);
}

/**
 * Which merchant survives by default.
 *
 * The larger history, because a merge writes `user` aliases for the losing
 * merchant's descriptors (§4.3) and the cheaper direction is the one that writes
 * fewer of them. A seeded merchant always wins over a provisional one regardless
 * of count — merging `AMAZON` into a provisional `AMAZON MKTPL` would discard a
 * shipped canonical along with its default category and its subscription flag.
 *
 * The user can flip it; this only decides which way the card points.
 */
function directionFor(a: MergeSubject, b: MergeSubject): { keep: MergeSubject; merge: MergeSubject } {
  if (a.source === 'seed' && b.source !== 'seed') return { keep: a, merge: b };
  if (b.source === 'seed' && a.source !== 'seed') return { keep: b, merge: a };

  if (a.transactionCount !== b.transactionCount) {
    return a.transactionCount > b.transactionCount ? { keep: a, merge: b } : { keep: b, merge: a };
  }

  return a.canonicalName <= b.canonicalName ? { keep: a, merge: b } : { keep: b, merge: a };
}

function compareNames(x: MergeCandidate, y: MergeCandidate): number {
  return x.keep.canonicalName < y.keep.canonicalName ? -1 : 1;
}

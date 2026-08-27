/**
 * §4.1 step 7's review queue, over literal merchant sets.
 *
 * The two cases that matter are the two real splits the first statement produced —
 * a spacing variant and a merchant printed with and without its processor prefix —
 * and the negative case that keeps this from being a merge-everything button.
 */

import { describe, expect, it } from 'vitest';

import type { MergeSubject } from './merge-candidates.js';
import { MERGE_PROPOSAL_FLOOR, proposeMerchantMerges } from './merge-candidates.js';

function merchant(
  canonicalName: string,
  transactionCount: number,
  overrides: Partial<MergeSubject> = {},
): MergeSubject {
  return {
    merchantId: canonicalName.toLowerCase().replace(/\s+/g, '-'),
    canonicalName,
    displayName: canonicalName,
    transactionCount,
    source: 'rule',
    ...overrides,
  };
}

describe('proposeMerchantMerges', () => {
  it('proposes a spacing variant the chain cannot decide about', () => {
    // The case §4.3's user correction exists for: both names run the chain
    // cleanly, neither is wrong, and only the user knows they are one vendor.
    const candidates = proposeMerchantMerges([
      merchant('SAMSCLUB', 24),
      merchant('SAMS CLUB', 14),
      merchant('CEDAR COUNSELING', 8),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].keep.canonicalName).toBe('SAMSCLUB');
    expect(candidates[0].merge.canonicalName).toBe('SAMS CLUB');
  });

  it('proposes a merchant printed with and without its processor prefix', () => {
    // What the swim school looked like before its prefix joined the stage-2 table.
    // Worth keeping as a case even though the chain now handles this one: the next
    // unknown prefix produces exactly this shape, and the queue is the thing that
    // catches it without a code change.
    const candidates = proposeMerchantMerges([
      merchant('ICP GOLDFISH SWIM SCHOOL', 8),
      merchant('GOLDFISH SWIM SCHOOL', 2),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].similarity).toBeGreaterThan(0.7);
  });

  it('says nothing about merchants that merely share a prefix', () => {
    const candidates = proposeMerchantMerges([
      merchant('SHELL OIL 57442100 PORTLAND', 9),
      merchant('SHELLFISH MARKET', 4),
      merchant('TARGET', 12),
      merchant('TARGET OPTICAL', 3),
    ]);

    expect(candidates).toEqual([]);
  });

  it('needs both sides to recur before it will ask', () => {
    // Same names either way, so the count is the only thing under test.
    expect(proposeMerchantMerges([merchant('SAMSCLUB', 1), merchant('SAMS CLUB', 1)])).toEqual([]);
    expect(
      proposeMerchantMerges([merchant('SAMSCLUB', 2), merchant('SAMS CLUB', 2)]),
    ).toHaveLength(1);
  });

  it('puts the floor in front of the order-reference tail, not just the count guard', () => {
    // Measured on the first real statement: two order references at one merchant
    // score ~0.41 against each other, which is under the floor — so the long tail
    // is excluded on its own merits and the count guard is a second line of
    // defence rather than the only one. Worth pinning, because it is the reason
    // the floor can sit as low as it does.
    expect(
      proposeMerchantMerges([merchant('AMAZON B15TI0K83', 9), merchant('AMAZON B94QQ8GC2', 9)]),
    ).toEqual([]);
  });

  it('leaves two shipped canonicals alone', () => {
    // `AMAZON` and `AMAZON PRIME` are deliberately separate merchants with
    // different default categories and different subscription flags. §5.4's
    // overlap groups are where that relationship belongs.
    const seeded = { source: 'seed' };
    const candidates = proposeMerchantMerges([
      merchant('AMAZON', 119, seeded),
      merchant('AMAZON PRIME', 4, seeded),
    ]);

    expect(candidates).toEqual([]);
  });

  it('keeps the shipped canonical when the other side is provisional', () => {
    // Merging a seeded merchant away would discard its default category and its
    // `is_known_subscription` flag along with it, however few charges it has.
    const candidates = proposeMerchantMerges([
      merchant('NETFLIX COM', 30),
      merchant('NETFLIX', 3, { source: 'seed' }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].keep.canonicalName).toBe('NETFLIX');
    expect(candidates[0].merge.canonicalName).toBe('NETFLIX COM');
  });

  it('points the merge at the larger history by default', () => {
    const candidates = proposeMerchantMerges([
      merchant('SAMS CLUB', 14),
      merchant('SAMSCLUB', 24),
    ]);

    expect(candidates[0].keep.transactionCount).toBe(24);
  });

  it('orders by similarity and caps the list', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      merchant(`REPEATED MERCHANT NAME ${index}`, 3),
    );
    const candidates = proposeMerchantMerges(many);

    expect(candidates.length).toBeLessThanOrEqual(25);
    for (let index = 1; index < candidates.length; index += 1) {
      expect(candidates[index - 1].similarity).toBeGreaterThanOrEqual(candidates[index].similarity);
    }
  });

  it('takes its thresholds as options, so the queue is tunable without a rebuild', () => {
    const pair = [merchant('SAMSCLUB', 24), merchant('SAMS CLUB', 14)];

    expect(proposeMerchantMerges(pair, { floor: 0.95 })).toEqual([]);
    expect(proposeMerchantMerges(pair, { minTransactions: 20 })).toEqual([]);
    expect(MERGE_PROPOSAL_FLOOR).toBeLessThan(0.72);
  });
});

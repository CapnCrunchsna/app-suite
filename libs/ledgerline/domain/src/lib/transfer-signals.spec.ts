/**
 * §2.6's spend-category signal, on its own.
 *
 * It has two callers that cannot see each other — the transfer matcher scoring a
 * pair, and §6.3's per-row transfer chip, which lives on the far side of §2.2's
 * boundary — so the rule is asserted here rather than twice through them.
 */

import { describe, expect, it } from 'vitest';

import { isSpendAtRealMerchant } from './transfer-signals.js';

describe('isSpendAtRealMerchant', () => {
  it('fires on a purchase at a real merchant in a spend category', () => {
    // The user's own example: "An amazon purchase was clearly not a transfer."
    expect(
      isSpendAtRealMerchant({ categoryKind: 'spend', merchantIsTransferKind: false }),
    ).toBe(true);
  });

  it('does not fire on a transfer-kind merchant', () => {
    expect(isSpendAtRealMerchant({ categoryKind: 'spend', merchantIsTransferKind: true })).toBe(
      false,
    );
  });

  it('needs both halves, so an unresolved descriptor is not evidence', () => {
    // §2.6 read literally: there is no canonical merchant here to vouch that the
    // money went to a real payee.
    expect(isSpendAtRealMerchant({ categoryKind: 'spend', merchantIsTransferKind: null })).toBe(
      false,
    );
    expect(isSpendAtRealMerchant({ categoryKind: null, merchantIsTransferKind: false })).toBe(
      false,
    );
  });

  it('says nothing about the three category kinds that are not spending', () => {
    for (const categoryKind of ['fee', 'transfer', 'income'] as const) {
      expect(isSpendAtRealMerchant({ categoryKind, merchantIsTransferKind: false })).toBe(false);
    }
  });
});

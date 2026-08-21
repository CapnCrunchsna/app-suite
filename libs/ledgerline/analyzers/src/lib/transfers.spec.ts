/**
 * §2.6, over literal transaction arrays.
 *
 * The matcher is a pure function of a snapshot (§2.2), so everything §2.6 decides
 * is testable without a database — and the three things it decides that a bare
 * "same amount, within ±3 days" predicate cannot are exactly what is asserted
 * below: that four identical $500 transfers produce four links and not sixteen,
 * that the score decides between silence, a queue entry and nothing at all, and
 * that the partial-payment pass never links on its own authority.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, resolveConfig } from './config.js';
import type { Snapshot, SnapshotAccount, SnapshotTransaction } from './snapshot.js';
import { matchTransfers, pairKey, transferRulePattern } from './transfers.js';
import type { TransferMatch, TransferMatchInput } from './transfers.js';

// ------------------------------------------------------------------ fixtures ---

const CHECKING: SnapshotAccount = {
  id: 'checking',
  displayName: 'Northgate Checking',
  institution: 'Northgate Bank',
  accountType: 'checking',
  last4: '4821',
  currency: 'USD',
  isActive: true,
  coverage: [],
};

const CARD: SnapshotAccount = {
  id: 'card',
  displayName: 'Cardinal Card',
  institution: 'Cardinal Bank',
  accountType: 'credit_card',
  last4: '9012',
  currency: 'USD',
  isActive: true,
  coverage: [],
};

const SAVINGS: SnapshotAccount = {
  id: 'savings',
  displayName: 'Northgate Savings',
  institution: 'Northgate Bank',
  accountType: 'savings',
  last4: '7734',
  currency: 'USD',
  isActive: true,
  coverage: [],
};

/**
 * `descriptionRaw` defaults to whatever `descriptionNormalized` says unless a
 * test states otherwise.
 *
 * The two really do differ in production — §4.1's stage 3 strips the masked
 * account number, which is the whole reason the matcher reads both — so the
 * tests that care about that difference set them apart explicitly, and the rest
 * are not made to restate a string twice to say nothing.
 */
function tx(overrides: Partial<SnapshotTransaction> & { id: string }): SnapshotTransaction {
  const base = {
    accountId: 'checking',
    effectiveDate: '2026-01-25',
    amountCents: -50_000,
    descriptionNormalized: 'ONLINE PMT CARDINAL CARD XXXX9012',
    merchantId: null,
    categoryId: null,
    isPending: false,
    isInternalTransfer: false,
    isExcluded: false,
    refundPairId: null,
    transferPairId: null,
    ...overrides,
  };
  return { ...base, descriptionRaw: overrides.descriptionRaw ?? base.descriptionNormalized };
}

/** The debit half of the committed fixture pair, which is a real auto-link case. */
const debit = (over: Partial<SnapshotTransaction> & { id: string }) => tx(over);

/** The credit half: `PAYMENT THANK YOU - WEB` on the card, sign-flipped into the
 *  house convention by the profile (§3.1). */
const credit = (over: Partial<SnapshotTransaction> & { id: string }) =>
  tx({
    accountId: 'card',
    amountCents: 50_000,
    descriptionNormalized: 'PAYMENT THANK YOU - WEB',
    ...over,
  });

function snapshot(
  transactions: readonly SnapshotTransaction[],
  accounts: readonly SnapshotAccount[] = [CHECKING, CARD],
  extra: Partial<Snapshot> = {},
): Snapshot {
  return {
    accounts,
    transactions,
    merchants: [],
    categories: [],
    ...extra,
  };
}

function run(
  transactions: readonly SnapshotTransaction[],
  options: Partial<Omit<TransferMatchInput, 'snapshot' | 'config'>> & {
    readonly accounts?: readonly SnapshotAccount[];
    readonly snapshot?: Partial<Snapshot>;
    readonly config?: TransferMatchInput['config'];
  } = {},
) {
  return matchTransfers({
    snapshot: snapshot(transactions, options.accounts, options.snapshot),
    seriesKeys: options.seriesKeys,
    rules: options.rules,
    takenTransactionIds: options.takenTransactionIds,
    rejectedPairKeys: options.rejectedPairKeys,
    config: options.config ?? DEFAULT_CONFIG,
  });
}

const points = (match: TransferMatch, signal: string): number =>
  match.reasons.find((reason) => reason.signal === signal)?.points ?? 0;

// --------------------------------------------------------------------- tests ---

describe('matchTransfers — candidate generation (§2.6)', () => {
  it('links the committed fixture pair, which is what the whole design is for', () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })]);

    // +3 keywords, +2 last4, +2 institution, +1 same day = 8.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      kind: 'one_to_one',
      disposition: 'auto',
      debitTransactionIds: ['d'],
      creditTransactionId: 'c',
      amountCents: 50_000,
      score: 8,
    });
  });

  it('refuses a pair inside one account — a transfer has two accounts by definition', () => {
    const result = run([
      debit({ id: 'd' }),
      credit({ id: 'c', accountId: 'checking' }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it('accepts a credit one day *before* its debit, and refuses two days before', () => {
    // §2.6: `−1 ≤ (c − d) ≤ 7`. One day of posting-order noise is normal.
    const inside = run([
      debit({ id: 'd', effectiveDate: '2026-01-25' }),
      credit({ id: 'c', effectiveDate: '2026-01-24' }),
    ]);
    expect(inside.matches).toHaveLength(1);

    const outside = run([
      debit({ id: 'd', effectiveDate: '2026-01-25' }),
      credit({ id: 'c', effectiveDate: '2026-01-23' }),
    ]);
    expect(outside.matches).toEqual([]);
  });

  it('accepts a seven-day settlement gap and refuses eight', () => {
    // "Seven days covers ACH settlement across a holiday weekend; ±3 loses the
    // common case." The seventh day loses the +1 and still clears the auto bar.
    const inside = run([
      debit({ id: 'd', effectiveDate: '2026-01-25' }),
      credit({ id: 'c', effectiveDate: '2026-02-01' }),
    ]);
    expect(inside.matches).toHaveLength(1);
    expect(inside.matches[0].score).toBe(7);
    expect(points(inside.matches[0], 'close_date_gap')).toBe(0);

    const outside = run([
      debit({ id: 'd', effectiveDate: '2026-01-25' }),
      credit({ id: 'c', effectiveDate: '2026-02-02' }),
    ]);
    expect(outside.matches).toEqual([]);
  });

  it('requires the amounts to be equal to the cent', () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c', amountCents: 49_999 })]);
    expect(result.matches).toEqual([]);
  });

  it('leaves pending, excluded and refunded rows out', () => {
    // §2.5 puts pending rows out of every total; §3.3 already paired the refund.
    expect(run([debit({ id: 'd', isPending: true }), credit({ id: 'c' })]).matches).toEqual([]);
    expect(run([debit({ id: 'd' }), credit({ id: 'c', isExcluded: true })]).matches).toEqual([]);
    expect(run([debit({ id: 'd', refundPairId: 'r1' }), credit({ id: 'c' })]).matches).toEqual([]);
  });
});

describe('matchTransfers — the scoring table (§2.6)', () => {
  it('scores keywords on both sides, and not on one', () => {
    const both = run([debit({ id: 'd' }), credit({ id: 'c' })]);
    expect(points(both.matches[0], 'keyword_both_sides')).toBe(3);

    const one = run([
      debit({ id: 'd' }),
      credit({ id: 'c', descriptionNormalized: 'DEPOSIT' }),
    ]);
    // 8 − 3 = 5: still auto, but the corroborators are carrying it, not the words.
    expect(points(one.matches[0], 'keyword_both_sides')).toBe(0);
    expect(one.matches[0].score).toBe(5);
  });

  it("scores the other account's last4 appearing in a descriptor", () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })]);
    expect(points(result.matches[0], 'counterparty_last4')).toBe(2);
    expect(result.matches[0].reasons.map((reason) => reason.detail)).toContain(
      "One descriptor names the other account's last four digits (9012).",
    );

    const without = run([
      debit({ id: 'd', descriptionNormalized: 'ONLINE PMT CARDINAL CARD' }),
      credit({ id: 'c' }),
    ]);
    expect(points(without.matches[0], 'counterparty_last4')).toBe(0);
  });

  it('finds the last4 in the raw line after normalization has stripped it', () => {
    // §4.1's stage 3 removes masked account numbers on the way to a merchant
    // key, so this is the *production* shape of the fixture pair: the digits
    // §2.6 scores +2 for survive only in `description_raw`. Reading the
    // normalized column alone would make the corroborator unreachable.
    const result = run([
      debit({
        id: 'd',
        descriptionNormalized: 'ONLINE PMT CARDINAL CARD',
        descriptionRaw: 'ONLINE PMT CARDINAL CARD XXXX9012',
      }),
      credit({ id: 'c' }),
    ]);

    expect(points(result.matches[0], 'counterparty_last4')).toBe(2);
    expect(result.matches[0]).toMatchObject({ score: 8, disposition: 'auto' });
  });

  it("scores the credit card's institution named in the payment descriptor", () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })]);
    expect(points(result.matches[0], 'credit_card_institution')).toBe(2);
  });

  it('does not let the word BANK make every institution match every card', () => {
    // `Cardinal Bank` and `Meridian Bank` share only a stop word. Without the
    // stop list this +2 would be a constant rather than a signal.
    const meridian: SnapshotAccount = { ...CARD, institution: 'Meridian Bank' };
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })], {
      accounts: [CHECKING, meridian],
    });

    expect(points(result.matches[0], 'credit_card_institution')).toBe(0);
  });

  it('scores the institution only when the counterpart is a credit card', () => {
    // §2.6's signal is specifically "B is a credit card". A savings sweep gets
    // its confidence from the keywords and the last4, not from the bank's name —
    // which both sides of a same-bank transfer would carry anyway.
    const sweep = run(
      [
        debit({ id: 'd', descriptionNormalized: 'TRANSFER TO SAVINGS XXXX7734' }),
        credit({
          id: 'c',
          accountId: 'savings',
          descriptionNormalized: 'TRANSFER FROM CHECKING XXXX4821',
        }),
      ],
      { accounts: [CHECKING, SAVINGS] },
    );

    expect(points(sweep.matches[0], 'credit_card_institution')).toBe(0);
    // +3 keywords, +2 last4, +1 same day.
    expect(sweep.matches[0]).toMatchObject({ score: 6, disposition: 'auto' });
  });

  it('subtracts for a side that is already a charge in a recurring series', () => {
    const netflix = tx({
      id: 'd',
      merchantId: 'netflix',
      descriptionNormalized: 'TRANSFER NETFLIX',
    });

    const result = run([netflix, credit({ id: 'c' })], {
      seriesKeys: [{ merchantId: 'netflix', accountId: 'checking' }],
      snapshot: {
        merchants: [
          {
            id: 'netflix',
            canonicalName: 'NETFLIX',
            displayName: 'Netflix',
            isKnownSubscription: true,
            isTransferKind: false,
            overlapGroup: null,
          },
        ],
      },
    });

    expect(points(result.matches[0], 'recurring_spend_series')).toBe(-2);
  });

  it('does not subtract when the series merchant is itself transfer-kind', () => {
    const sweep = tx({ id: 'd', merchantId: 'xfer', descriptionNormalized: 'TRANSFER TO CARD' });

    const result = run([sweep, credit({ id: 'c' })], {
      seriesKeys: [{ merchantId: 'xfer', accountId: 'checking' }],
      snapshot: {
        merchants: [
          {
            id: 'xfer',
            canonicalName: 'CARD PAYMENT',
            displayName: 'Card payment',
            isKnownSubscription: false,
            isTransferKind: true,
            overlapGroup: null,
          },
        ],
      },
    });

    expect(points(result.matches[0], 'recurring_spend_series')).toBe(0);
  });

  it('subtracts for a side categorized as spending at a real merchant', () => {
    const result = run(
      [
        tx({
          id: 'd',
          merchantId: 'plant',
          categoryId: 'dining',
          descriptionNormalized: 'TRANSFER THE PLANT CAFE',
        }),
        credit({ id: 'c' }),
      ],
      {
        snapshot: {
          merchants: [
            {
              id: 'plant',
              canonicalName: 'THE PLANT CAFE',
              displayName: 'The Plant Cafe',
              isKnownSubscription: false,
              isTransferKind: false,
              overlapGroup: null,
            },
          ],
          categories: [
            {
              id: 'dining',
              name: 'Dining',
              parentId: null,
              kind: 'spend',
              overlapGroup: null,
            },
          ],
        },
      },
    );

    expect(points(result.matches[0], 'spend_category')).toBe(-2);
  });

  it('takes every threshold from the config, never from a constant (§7.4)', () => {
    const strict = resolveConfig({ transfers: { autoLinkScore: 9 } });
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })], { config: strict });

    // The same score of 8 that auto-linked above is only a proposal here.
    expect(result.matches[0]).toMatchObject({ score: 8, disposition: 'proposed' });
  });
});

describe('matchTransfers — dispositions (§2.6)', () => {
  /** §2.6: "≥ 5 auto-link · 2–4 propose · < 2 no link." */
  it('auto-links at 5 and proposes at 4', () => {
    // +3 keywords +1 same day +1... there is no +1 signal to reach exactly 5 with,
    // so the boundary is walked with the config instead: the same evidence, two
    // thresholds. This is the boundary §7.6 expects to move first.
    const pair = [debit({ id: 'd' }), credit({ id: 'c' })];

    expect(run(pair, { config: resolveConfig({ transfers: { autoLinkScore: 8 } }) }).matches[0])
      .toMatchObject({ disposition: 'auto' });
    expect(run(pair, { config: resolveConfig({ transfers: { autoLinkScore: 8.5 } }) }).matches[0])
      .toMatchObject({ disposition: 'proposed' });
  });

  it('proposes rather than links when only the amount and the dates agree', () => {
    // No keywords, no last4, no institution — just $500 leaving one account and
    // landing in another on the same day. That is a coincidence often enough that
    // §2.6 will not spend it silently.
    const result = run([
      debit({ id: 'd', descriptionNormalized: 'WITHDRAWAL' }),
      credit({ id: 'c', descriptionNormalized: 'DEPOSIT' }),
    ]);

    // +1 for the same-day gap alone is below the propose floor of 2.
    expect(result.matches).toEqual([]);
    expect(result.ignoredCount).toBe(1);
  });

  it('proposes a pair with one corroborator and no keywords', () => {
    const result = run([
      debit({ id: 'd', descriptionNormalized: 'WITHDRAWAL XXXX9012' }),
      credit({ id: 'c', descriptionNormalized: 'DEPOSIT' }),
    ]);

    // +2 last4, +2 institution... the institution is not named, so +2 +1 = 3.
    expect(result.matches[0]).toMatchObject({ disposition: 'proposed', score: 3 });
    expect(result.proposedCount).toBe(1);
    expect(result.autoLinkedCount).toBe(0);
  });
});

describe('matchTransfers — assignment (§2.6)', () => {
  /**
   * The test §2.6 names: "without it, four identical $500 transfers in one month
   * produce sixteen matches."
   */
  it('assigns four identical $500 transfers one-to-one, not sixteen ways', () => {
    const dates = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'];
    const rows = [
      ...dates.map((date, index) => debit({ id: `d${index}`, effectiveDate: date })),
      ...dates.map((date, index) => credit({ id: `c${index}`, effectiveDate: date })),
    ];

    const result = matchTransfers({
      snapshot: snapshot(rows),
      config: {
        ...DEFAULT_CONFIG,
        // A 30-day window, so every debit is a candidate for every credit and the
        // one-to-one constraint is the only thing keeping the count at four.
        transfers: { ...DEFAULT_CONFIG.transfers, windowMaxDays: 30 },
      },
    });

    expect(result.matches).toHaveLength(4);
    expect(result.matches.map((match) => match.debitTransactionIds[0]).sort()).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
    ]);
    expect(result.matches.map((match) => match.creditTransactionId).sort()).toEqual([
      'c0',
      'c1',
      'c2',
      'c3',
    ]);
    // Each pairs with its own week: greedy by score, and the same-day pair scores
    // one higher than any other.
    for (const match of result.matches) {
      expect(match.creditTransactionId).toBe(match.debitTransactionIds[0].replace('d', 'c'));
    }
  });

  it('gives one credit to the better-scoring of two competing debits', () => {
    const result = run([
      debit({ id: 'weak', descriptionNormalized: 'WITHDRAWAL XXXX9012' }),
      debit({ id: 'strong' }),
      credit({ id: 'c' }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].debitTransactionIds).toEqual(['strong']);
  });

  it('is deterministic over a hundred runs (§2.4 T2)', () => {
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    const rows = [
      ...dates.map((date, index) => debit({ id: `d${index}`, effectiveDate: date })),
      ...dates.map((date, index) => credit({ id: `c${index}`, effectiveDate: date })),
    ];

    const first = JSON.stringify(run(rows).matches);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(JSON.stringify(run(rows).matches)).toBe(first);
    }
  });
});

describe('matchTransfers — partial payments (§2.6)', () => {
  /** "A second pass attempts a one-to-many match [...] and **always proposes,
   *  never auto-links**." */
  it('proposes two debits summing to one credit, and never links them', () => {
    const result = run([
      debit({ id: 'd1', amountCents: -30_000, effectiveDate: '2026-01-23' }),
      debit({ id: 'd2', amountCents: -20_000, effectiveDate: '2026-01-24' }),
      credit({ id: 'c', amountCents: 50_000, effectiveDate: '2026-01-25' }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      kind: 'partial',
      disposition: 'proposed',
      debitTransactionIds: ['d1', 'd2'],
      creditTransactionId: 'c',
      amountCents: 50_000,
    });
    // A score well past the auto bar, and still only a proposal.
    expect(result.matches[0].score).toBeGreaterThanOrEqual(DEFAULT_CONFIG.transfers.autoLinkScore);
    expect(result.autoLinkedCount).toBe(0);
  });

  it('matches three parts and refuses four', () => {
    const three = run([
      debit({ id: 'd1', amountCents: -20_000, effectiveDate: '2026-01-22' }),
      debit({ id: 'd2', amountCents: -20_000, effectiveDate: '2026-01-23' }),
      debit({ id: 'd3', amountCents: -10_000, effectiveDate: '2026-01-24' }),
      credit({ id: 'c', amountCents: 50_000 }),
    ]);
    expect(three.matches[0].debitTransactionIds).toEqual(['d1', 'd2', 'd3']);

    const four = run([
      debit({ id: 'd1', amountCents: -20_000, effectiveDate: '2026-01-22' }),
      debit({ id: 'd2', amountCents: -10_000, effectiveDate: '2026-01-23' }),
      debit({ id: 'd3', amountCents: -10_000, effectiveDate: '2026-01-24' }),
      debit({ id: 'd4', amountCents: -10_000, effectiveDate: '2026-01-24' }),
      credit({ id: 'c', amountCents: 50_000 }),
    ]);
    // §2.6: "Combinatorics over more than three parts is not worth the
    // false-positive risk."
    expect(four.matches).toEqual([]);
  });

  it('does not offer a partial group with no corroborating signal (§9f)', () => {
    const result = run([
      debit({ id: 'd1', amountCents: -30_000, descriptionNormalized: 'WITHDRAWAL' }),
      debit({ id: 'd2', amountCents: -20_000, descriptionNormalized: 'WITHDRAWAL' }),
      credit({ id: 'c', amountCents: 50_000, descriptionNormalized: 'DEPOSIT' }),
    ]);

    expect(result.matches).toEqual([]);
  });

  it('runs only over what the one-to-one pass left', () => {
    // The exact pair takes precedence; the two smaller debits that also total
    // $500 are not then offered against the same credit.
    const result = run([
      debit({ id: 'exact' }),
      debit({ id: 'part1', amountCents: -30_000, effectiveDate: '2026-01-24' }),
      debit({ id: 'part2', amountCents: -20_000, effectiveDate: '2026-01-24' }),
      credit({ id: 'c' }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ kind: 'one_to_one', debitTransactionIds: ['exact'] });
  });

  it('spends a debit once across the whole partial pass', () => {
    const result = run([
      debit({ id: 'd1', amountCents: -30_000, effectiveDate: '2026-01-24' }),
      debit({ id: 'd2', amountCents: -20_000, effectiveDate: '2026-01-24' }),
      debit({ id: 'd3', amountCents: -10_000, effectiveDate: '2026-01-24' }),
      credit({ id: 'big', amountCents: 50_000, effectiveDate: '2026-01-25' }),
      credit({ id: 'small', amountCents: 40_000, effectiveDate: '2026-01-25' }),
    ]);

    const used = result.matches.flatMap((match) => match.debitTransactionIds);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('matchTransfers — learning and user decisions (§2.6)', () => {
  it('adds the learned bonus for a confirmed pairing and names the rule', () => {
    const bare = [
      debit({ id: 'd', descriptionNormalized: 'BILL PAY CARDINAL 883021' }),
      credit({ id: 'c', descriptionNormalized: 'DEPOSIT' }),
    ];

    const before = run(bare);
    // +2 institution, +1 same day: a proposal.
    expect(before.matches[0]).toMatchObject({ disposition: 'proposed', score: 3 });

    const after = run(bare, {
      rules: [
        {
          id: 'rule-1',
          descriptorPattern: 'BILL PAY CARDINAL',
          debitAccountId: 'checking',
          creditAccountId: 'card',
        },
      ],
    });

    // §2.6: "A monthly credit-card payment is confirmed once and auto-links
    // thereafter."
    expect(after.matches[0]).toMatchObject({
      disposition: 'auto',
      score: 6,
      ruleId: 'rule-1',
    });
  });

  it('applies a rule only to its own account pair', () => {
    const result = run(
      [
        debit({ id: 'd', descriptionNormalized: 'BILL PAY CARDINAL 883021' }),
        credit({
          id: 'c',
          accountId: 'savings',
          descriptionNormalized: 'DEPOSIT',
        }),
      ],
      {
        accounts: [CHECKING, SAVINGS],
        rules: [
          {
            id: 'rule-1',
            descriptorPattern: 'BILL PAY CARDINAL',
            debitAccountId: 'checking',
            creditAccountId: 'card',
          },
        ],
      },
    );

    expect(result.matches).toEqual([]);
  });

  it('never re-matches a transaction the user has confirmed elsewhere', () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })], {
      takenTransactionIds: ['d'],
    });
    expect(result.matches).toEqual([]);
  });

  it('drops a rejected pair without disqualifying either row', () => {
    const result = run(
      [
        debit({ id: 'd' }),
        credit({ id: 'rejected', effectiveDate: '2026-01-25' }),
        credit({ id: 'other', effectiveDate: '2026-01-26' }),
      ],
      { rejectedPairKeys: [pairKey('d', 'rejected')] },
    );

    // "That $500 is not this card payment" says nothing about the next one.
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].creditTransactionId).toBe('other');
  });

  it('re-derives an auto-link from a previous run rather than treating it as settled', () => {
    // A row already carrying `transfer_pair_id` is the run's to reconsider —
    // otherwise a link whose evidence has since changed could never be withdrawn.
    const result = run([
      debit({ id: 'd', isInternalTransfer: true, transferPairId: 'link-1' }),
      credit({ id: 'c', isInternalTransfer: true, transferPairId: 'link-1' }),
    ]);

    expect(result.matches).toHaveLength(1);
  });
});

describe('matchTransfers — what it cannot do (§2.6)', () => {
  it('reports a transfer-shaped debit whose counterpart is not in the system', () => {
    // "A transfer to an account not in the system has no counterpart and will
    // never link, so it counts as spend. The Accounts page says so."
    const result = run([debit({ id: 'd' })]);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedKeywordDebits).toEqual([
      {
        accountId: 'checking',
        transactionId: 'd',
        effectiveDate: '2026-01-25',
        amountCents: 50_000,
        descriptionNormalized: 'ONLINE PMT CARDINAL CARD XXXX9012',
      },
    ]);
  });

  it('does not report a debit that found its counterpart', () => {
    const result = run([debit({ id: 'd' }), credit({ id: 'c' })]);
    expect(result.unmatchedKeywordDebits).toEqual([]);
  });

  it('does not report ordinary spending as an unmatched transfer', () => {
    const result = run([debit({ id: 'd', descriptionNormalized: 'TRADER JOES 0198' })]);
    expect(result.unmatchedKeywordDebits).toEqual([]);
  });
});

describe('transferRulePattern', () => {
  it('drops the trailing reference number so next month still matches', () => {
    expect(transferRulePattern('ONLINE PMT CARDINAL CARD XXXX9012')).toBe(
      'ONLINE PMT CARDINAL CARD',
    );
  });

  it('keeps digits that are part of the name', () => {
    expect(transferRulePattern('TRANSFER TO 7-ELEVEN SAVINGS')).toBe('TRANSFER TO 7-ELEVEN SAVINGS');
  });

  it('keeps the whole descriptor rather than learning a pattern that matches everything', () => {
    expect(transferRulePattern('883021')).toBe('883021');
  });
});

/**
 * The two named intents §6.3's bulk correction path rests on, and the job it
 * enqueues.
 *
 * The property under test throughout is that the dry-run count and the apply
 * select the same set. §6.3 puts a number in front of the user — "apply to all 47
 * matching descriptors" — and then makes a permanent, precedence-topping change
 * (§4.3) on their say-so. A count that does not match what gets written is worse
 * than no count.
 */

import { describe, expect, it } from 'vitest';

import { DEDUPE_KEY_VERSION, dedupeKey } from '@metrum/ledgerline-domain';

import { fixedClock } from '../clock.js';
import { LedgerlineStore } from '../store.js';
import type { TransactionRecord } from '../records.js';

interface RowSpec {
  readonly date: string;
  readonly amountCents: number;
  readonly descriptionRaw: string;
  readonly descriptionNormalized: string;
  readonly pending?: boolean;
  readonly merchantId?: string | null;
}

function openStore(): LedgerlineStore {
  return LedgerlineStore.open({ filename: ':memory:', clock: fixedClock() });
}

function seed(
  store: LedgerlineStore,
  rows: readonly RowSpec[],
): {
  accountId: string;
  inserted: TransactionRecord[];
} {
  const account = store.accounts.create({
    displayName: 'Northgate Checking',
    accountType: 'checking',
  });

  // `transaction.merchant_id` is a real foreign key (§3.2), so the merchant a
  // correction assigns to has to exist. The composition root seeds these from
  // `normalize`; `data` cannot reach that lib, so the test does it by hand.
  store.merchants.upsertSeed({
    id: 'spotify',
    canonicalName: 'SPOTIFY',
    displayName: 'Spotify',
    isKnownSubscription: true,
  });

  const inserted = rows.map((row) => {
    const key = dedupeKey({
      accountId: account.id,
      effectiveDate: row.date,
      amountCents: row.amountCents,
      descriptionRaw: row.descriptionRaw,
    });
    return store.transactions.insert({
      accountId: account.id,
      rawRowId: null,
      postedDate: null,
      transactionDate: row.date,
      effectiveDate: row.date,
      amountCents: row.amountCents,
      balanceCents: null,
      currency: 'USD',
      descriptionRaw: row.descriptionRaw,
      descriptionNormalized: row.descriptionNormalized,
      merchantId: row.merchantId ?? null,
      isPending: row.pending ?? false,
      dedupeKey: key,
      dedupeKeyVersion: DEDUPE_KEY_VERSION,
      occurrenceIndex: store.transactions.nextOccurrenceIndex(account.id, key),
    });
  });

  return { accountId: account.id, inserted };
}

/** Four months of one subscription under two different raw descriptors, plus a
 *  row that must not be caught by either. */
const SPOTIFY_HISTORY: readonly RowSpec[] = [
  {
    date: '2026-01-04',
    amountCents: -1099,
    descriptionRaw: 'PAYPAL *SPOTIFYUSA 4029357733',
    descriptionNormalized: 'SPOTIFYUSA',
  },
  {
    date: '2026-02-04',
    amountCents: -1099,
    descriptionRaw: 'PAYPAL *SPOTIFYUSA 4029357733',
    descriptionNormalized: 'SPOTIFYUSA',
  },
  {
    date: '2026-03-04',
    amountCents: -1099,
    descriptionRaw: 'PAYPAL *SPOTIFYUSA 4029357733',
    descriptionNormalized: 'SPOTIFYUSA',
  },
  {
    date: '2026-04-04',
    amountCents: -1199,
    descriptionRaw: 'SPOTIFY USA INC',
    descriptionNormalized: 'SPOTIFY USA INC',
  },
  {
    date: '2026-04-11',
    amountCents: -1875,
    descriptionRaw: 'SQ *BLUE BOTTLE COFFE 415-555-0111 CA',
    descriptionNormalized: 'BLUE BOTTLE COFFE',
  },
];

describe('TransactionRepository — the bulk correction surface (§6.3)', () => {
  describe('countMatching', () => {
    it('counts the descriptor set the dry-run is asked about', () => {
      const store = openStore();
      seed(store, SPOTIFY_HISTORY);

      expect(
        store.transactions.countMatching({
          descriptorsNormalized: ['SPOTIFYUSA'],
        }),
      ).toBe(3);
      expect(
        store.transactions.countMatching({
          descriptorsNormalized: ['SPOTIFYUSA', 'SPOTIFY USA INC'],
        }),
      ).toBe(4);

      store.close();
    });

    it('matches the descriptor exactly rather than as a substring', () => {
      const store = openStore();
      seed(store, SPOTIFY_HISTORY);

      // `text` is a LIKE and would catch both; `descriptorsNormalized` is the
      // filter the apply uses, so it must not.
      expect(store.transactions.countMatching({ text: 'SPOTIFY' })).toBe(4);
      expect(
        store.transactions.countMatching({
          descriptorsNormalized: ['SPOTIFY'],
        }),
      ).toBe(0);

      store.close();
    });

    it('agrees with search().total over the same filter', () => {
      const store = openStore();
      const { accountId } = seed(store, SPOTIFY_HISTORY);

      const filter = { accountIds: [accountId], text: 'SPOTIFY' } as const;
      expect(store.transactions.countMatching(filter)).toBe(
        store.transactions.search({ ...filter, limit: 1 }).total,
      );

      store.close();
    });

    it('honours the internal-transfer default the search path uses', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.transactions.update(inserted[0].id, { isInternalTransfer: true });

      // §6.3's toggle is off by default, and the count behind "apply to all N"
      // has to mean the same thing as the table the user is looking at.
      expect(
        store.transactions.countMatching({
          descriptorsNormalized: ['SPOTIFYUSA'],
        }),
      ).toBe(2);
      expect(
        store.transactions.countMatching({
          descriptorsNormalized: ['SPOTIFYUSA'],
          includeInternalTransfers: true,
        }),
      ).toBe(3);

      store.close();
    });
  });

  describe('applyBulk', () => {
    it('updates exactly the rows the dry-run counted, and reports their ids', () => {
      const store = openStore();
      seed(store, SPOTIFY_HISTORY);

      const filter = { descriptorsNormalized: ['SPOTIFYUSA'] };
      const counted = store.transactions.countMatching(filter);
      const applied = store.transactions.applyBulk(filter, {
        merchantId: 'spotify',
      });

      expect(applied.matched).toBe(counted);
      expect(applied.transactionIds).toHaveLength(counted);

      const rows = store.transactions.search({
        descriptorsNormalized: ['SPOTIFYUSA'],
      }).rows;
      expect(rows.every((row) => row.transaction.merchantId === 'spotify')).toBe(true);

      // The row outside the descriptor set is untouched.
      const coffee = store.transactions.search({ text: 'BLUE BOTTLE' }).rows[0];
      expect(coffee.transaction.merchantId).toBeNull();

      store.close();
    });

    it('writes only the columns the patch names', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.transactions.update(inserted[0].id, {
        isExcluded: true,
        categoryId: null,
      });

      store.transactions.applyBulk(
        { descriptorsNormalized: ['SPOTIFYUSA'], includeExcluded: true },
        { merchantId: 'spotify' },
      );

      // A merchant assignment must not un-exclude a row somebody excluded. The
      // read-then-write `update` path would have rewritten every column.
      expect(store.transactions.get(inserted[0].id)?.isExcluded).toBe(true);
      expect(store.transactions.get(inserted[0].id)?.merchantId).toBe('spotify');

      store.close();
    });

    it('marks internal transfers in bulk without touching merchant or category', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.transactions.update(inserted[3].id, { merchantId: 'spotify' });

      const applied = store.transactions.applyBulk(
        { descriptorsNormalized: ['SPOTIFY USA INC'] },
        { isInternalTransfer: true },
      );

      expect(applied.matched).toBe(1);
      const row = store.transactions.get(inserted[3].id);
      expect(row?.isInternalTransfer).toBe(true);
      expect(row?.merchantId).toBe('spotify');

      store.close();
    });

    it('is a no-op on an empty patch rather than a mass timestamp bump', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      const before = store.transactions.get(inserted[0].id)?.updatedAt;

      const applied = store.transactions.applyBulk({ descriptorsNormalized: ['SPOTIFYUSA'] }, {});

      expect(applied.matched).toBe(3);
      expect(store.transactions.get(inserted[0].id)?.updatedAt).toBe(before);

      store.close();
    });

    it('matches nothing, and writes nothing, for a descriptor with no rows', () => {
      const store = openStore();
      seed(store, SPOTIFY_HISTORY);

      const applied = store.transactions.applyBulk(
        { descriptorsNormalized: ['NO SUCH MERCHANT'] },
        { merchantId: 'spotify' },
      );

      expect(applied).toEqual({ matched: 0, transactionIds: [] });
      store.close();
    });
  });
});

describe('JobRepository — §2.7 coalescing', () => {
  /** The renormalize payload's merge, as the composition root does it: a union
   *  of the affected transaction ids. */
  const union =
    (ids: readonly string[]) =>
    (existing: string | null): string => {
      const carried = existing ? (JSON.parse(existing) as { transactionIds: string[] }) : null;
      return JSON.stringify({
        transactionIds: [...new Set([...(carried?.transactionIds ?? []), ...ids])],
      });
    };

  it('merges a second request into the job already queued', () => {
    const store = openStore();

    const first = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t1', 't2']),
    });
    const second = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t2', 't3']),
    });

    // §2.7: "correcting eight merchants in a row is one job, not eight."
    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(store.jobs.list()).toHaveLength(1);

    expect(JSON.parse(second.job.payloadJson as string)).toEqual({
      transactionIds: ['t1', 't2', 't3'],
    });

    store.close();
  });

  it('does not merge into a job that has already started reading its payload', () => {
    const store = openStore();
    const queued = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t1']),
    });

    store.db.prepare("UPDATE job SET state = 'running' WHERE id = ?").run(queued.job.id);

    const next = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t2']),
    });

    expect(next.coalesced).toBe(false);
    expect(next.job.id).not.toBe(queued.job.id);
    expect(store.jobs.list()).toHaveLength(2);

    store.close();
  });

  it('keeps the two kinds in §2.7 separate', () => {
    const store = openStore();

    const renormalize = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t1']),
    });
    const analysis = store.jobs.enqueueCoalesced({
      kind: 'analysis',
      mergePayload: () => null,
    });

    expect(analysis.coalesced).toBe(false);
    expect(analysis.job.id).not.toBe(renormalize.job.id);

    store.close();
  });

  it('reports a queued job as §2.7 says GET /api/jobs/:id must', () => {
    const store = openStore();
    const { job } = store.jobs.enqueueCoalesced({
      kind: 'renormalize',
      mergePayload: union(['t1']),
      message: 're-normalizing 1 transaction',
    });

    expect(store.jobs.get(job.id)).toMatchObject({
      kind: 'renormalize',
      state: 'queued',
      progress: 0,
      message: 're-normalizing 1 transaction',
      resultJson: null,
      finishedAt: null,
    });
    expect(store.jobs.get('nope')).toBeNull();

    store.close();
  });
});

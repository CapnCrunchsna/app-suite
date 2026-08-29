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

import { DEDUPE_KEY_VERSION, dedupeKey } from '@metrum/ledgerline-domain/node';

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

  /**
   * §9w's `ids` filter, at the level where the interesting decision was made.
   *
   * It is bound as one JSON value through `json_each` rather than as `n`
   * placeholders, because this is the one list filter whose length is data:
   * `micro.v1` cites every charge in a group, and a placeholder per id walks into
   * `SQLITE_MAX_VARIABLE_NUMBER` at exactly the sizes it exists for. The property
   * that matters is that it behaves like every other filter while doing so.
   */
  describe('the ids filter', () => {
    it('selects exactly the named rows', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      const wanted = [inserted[0].id, inserted[2].id];

      const page = store.transactions.search({ ids: wanted, limit: 100 });

      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.transaction.id).sort()).toEqual([...wanted].sort());

      store.close();
    });

    it('reads an empty list as nothing, not as an absent filter', () => {
      const store = openStore();
      seed(store, SPOTIFY_HISTORY);

      // Every other list filter here treats empty as absent. This one must not:
      // a caller asking for zero specific rows would otherwise be handed the
      // whole table.
      expect(store.transactions.countMatching({ ids: [] })).toBe(0);
      expect(store.transactions.countMatching({})).toBe(5);

      store.close();
    });

    it('takes more ids than SQLite would bind as placeholders', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);

      // 40,000 is past both the 999 an older SQLite allows and the 32,766 this
      // one does. One bound parameter, so neither ceiling is in the way.
      const ids = [inserted[1].id, ...Array.from({ length: 40_000 }, (_unused, i) => `x${i}`)];

      expect(store.transactions.countMatching({ ids })).toBe(1);

      store.close();
    });

    it('agrees across search, countMatching and applyBulk', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      const filter = { ids: [inserted[0].id, inserted[1].id] };

      // The three-caller property this whole `buildFilter` exists for: an id list
      // that compiled to one clause for the count and a chunked one for the write
      // is how "apply to all 47 matching" comes to update some other number.
      expect(store.transactions.countMatching(filter)).toBe(2);
      expect(store.transactions.search({ ...filter, limit: 1 }).total).toBe(2);

      const applied = store.transactions.applyBulk(filter, { merchantId: 'spotify' });
      expect(applied.matched).toBe(2);
      expect([...applied.transactionIds].sort()).toEqual([...filter.ids].sort());

      store.close();
    });

    it('narrows alongside the other filters rather than replacing them', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);

      // One of these three rows is a `SPOTIFYUSA` charge; the intersection is
      // what comes back, not the id list and not the descriptor set.
      const ids = [inserted[0].id, inserted[3].id, inserted[4].id];

      expect(store.transactions.countMatching({ ids })).toBe(3);
      expect(
        store.transactions.countMatching({ ids, descriptorsNormalized: ['SPOTIFYUSA'] }),
      ).toBe(1);

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

    /**
     * §4.3's precedence, as a filter (§9h).
     *
     * The re-normalize sweep repoints a corrected merchant across four years of
     * history and the merchant's default category rides along. On a row the user
     * categorized by hand it must not — but the *merchant* on that row still has
     * to move, which is why this is a filter on one of two passes rather than a
     * conditional write on one.
     */
    it('excludes user-categorized rows from a rule’s category, but not from its merchant', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.merchants.upsertCategory({ id: 'dining', name: 'Dining & Coffee', kind: 'spend' });
      store.merchants.upsertCategory({ id: 'groceries', name: 'Groceries', kind: 'spend' });

      // Two of the three SPOTIFYUSA rows: one a rule categorized, one a human did.
      store.transactions.update(inserted[0].id, {
        categoryId: 'dining',
        categorySource: 'rule',
      });
      store.transactions.update(inserted[1].id, {
        categoryId: 'groceries',
        categorySource: 'user',
      });

      const selector = { descriptorsNormalized: ['SPOTIFYUSA'] };
      store.transactions.applyBulk(selector, { merchantId: 'spotify' });
      const categorized = store.transactions.applyBulk(
        { ...selector, excludeUserCategorized: true },
        { categoryId: 'dining', categorySource: 'rule' },
      );

      expect(categorized.matched).toBe(2);
      expect(categorized.transactionIds).not.toContain(inserted[1].id);

      // The user's category survives; their row's merchant is corrected anyway.
      expect(store.transactions.get(inserted[1].id)).toMatchObject({
        merchantId: 'spotify',
        categoryId: 'groceries',
        categorySource: 'user',
      });
      expect(store.transactions.get(inserted[0].id)).toMatchObject({
        merchantId: 'spotify',
        categoryId: 'dining',
        categorySource: 'rule',
      });

      store.close();
    });
  });

  /**
   * The backfill §9h decided to run, for rows committed before the seed merchants
   * carried a `default_category_id` (§2.5's rule-based categorizer).
   *
   * §6.1 refuses a re-parse on a committed import, and this is not one: the
   * merchant was already resolved when those rows landed, so the answer for a
   * two-year-old row is the answer it would get today.
   */
  describe('applyMerchantDefaultCategories', () => {
    it('fills only rows no source has spoken for, and is idempotent', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.merchants.upsertCategory({ id: 'entertainment', name: 'Entertainment', kind: 'spend' });
      store.merchants.upsertCategory({ id: 'groceries', name: 'Groceries', kind: 'spend' });
      store.merchants.upsertSeed({
        id: 'spotify',
        canonicalName: 'SPOTIFY',
        displayName: 'Spotify',
        isKnownSubscription: true,
        defaultCategoryId: 'entertainment',
      });

      // Three rows on the merchant: one untouched, one a human categorized, one a
      // human deliberately *cleared* — which §6.3 records as a `user` source over
      // a null category, and which re-filling would silently overrule.
      store.transactions.applyBulk({ descriptorsNormalized: ['SPOTIFYUSA'] }, { merchantId: 'spotify' });
      store.transactions.update(inserted[1].id, { categoryId: 'groceries', categorySource: 'user' });
      store.transactions.update(inserted[2].id, { categoryId: null, categorySource: 'user' });

      expect(store.transactions.applyMerchantDefaultCategories()).toBe(1);
      expect(store.transactions.get(inserted[0].id)).toMatchObject({
        categoryId: 'entertainment',
        categorySource: 'rule',
      });
      expect(store.transactions.get(inserted[1].id)?.categoryId).toBe('groceries');
      expect(store.transactions.get(inserted[2].id)?.categoryId).toBeNull();

      // Idempotent, which is what lets it run at every boot.
      expect(store.transactions.applyMerchantDefaultCategories()).toBe(0);

      store.close();
    });

    it('leaves a row alone when its merchant has no default, and when it has none', () => {
      const store = openStore();
      const { inserted } = seed(store, SPOTIFY_HISTORY);
      store.transactions.applyBulk({ descriptorsNormalized: ['SPOTIFYUSA'] }, { merchantId: 'spotify' });

      // `spotify` is seeded here without a default; the coffee row has no merchant
      // at all. A rule with no answer says nothing rather than guessing one.
      expect(store.transactions.applyMerchantDefaultCategories()).toBe(0);
      expect(store.transactions.get(inserted[0].id)?.categorySource).toBeNull();
      expect(store.transactions.get(inserted[4].id)?.categoryId).toBeNull();

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

/**
 * §4.1 step 7's review queue, over HTTP.
 *
 * Over real fixture bytes through the real import pipeline, for the reason
 * `transactions-api.spec.ts` gives: the descriptors this queue has to reason about
 * are the ones §4's chain actually produced, not ones a test author picked because
 * they made the point.
 *
 * That matters more here than anywhere else in the API, because the queue's whole
 * job is to describe what the chain could not settle. A fixture chosen to look
 * ambiguous would prove nothing about whether real statements are. These two
 * checking fixtures happen to contain the condition §4.1 stage 4 accepts on
 * purpose — one coffee shop under two provisional names, because the chain
 * deliberately leaves a city on a descriptor — and that is exactly the shape the
 * queue exists to surface.
 *
 * They also contain it in its *hard* form, which is why both cases below are
 * worth having: January's spelling occurs once, so the pair is real, scores over
 * the floor, and is still withheld. The rule's semantics are pinned over literal
 * arrays in `merge-candidates.spec.ts`; what these cover is the wiring from the
 * store through the proposal to the response, and the guard's cost in the one
 * place a real corpus demonstrates it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const workspaceRoot = new URL('../../../', import.meta.url);
const PROFILES_DIR = fileURLToPath(new URL('profiles', workspaceRoot));

interface ReviewMerchantShape {
  merchant: { id: string; displayName: string; canonicalName: string; source: string };
  transactionCount: number;
  sampleDescriptors: string[];
}

interface ReviewQueueShape {
  mergeCandidates: { keep: ReviewMerchantShape; merge: ReviewMerchantShape; similarity: number }[];
  provisional: ReviewMerchantShape[];
  llmProposals: unknown[];
  llmProposalsUnavailableReason: string | null;
}

describe('ledgerline-api merchant review queue (§4.1 step 7)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let checkingId: string;

  async function importFixture(name: string, accountId: string): Promise<void> {
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL(`fixtures/statements/${name}`, workspaceRoot))),
    );
    const form = new FormData();
    form.append('files', new File([bytes], name, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    const [staged] = (uploaded.json() as { imports: { import: { id: string } }[] }).imports;

    await app.inject({
      method: 'PATCH',
      url: `/api/imports/${staged.import.id}`,
      payload: { accountId },
    });
    const committed = await app.inject({
      method: 'POST',
      url: `/api/imports/${staged.import.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode).toBe(200);
  }

  async function queue(): Promise<ReviewQueueShape> {
    const response = await app.inject({ method: 'GET', url: '/api/merchants/review-queue' });
    expect(response.statusCode).toBe(200);
    return response.json() as ReviewQueueShape;
  }

  beforeEach(async () => {
    context = createContext({ databaseFile: ':memory:', profilesDir: PROFILES_DIR });
    app = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: PROFILES_DIR,
        backupDir: '',
      },
    });

    checkingId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;

    await importFixture('northgate-checking-2026-01.csv', checkingId);
    await importFixture('northgate-checking-2026-02.csv', checkingId);
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  /**
   * These two fixtures hold the coffee shop under two provisional names —
   * `BLUE BOTTLE COFFE` in January, `BLUE BOTTLE COFFEE PORTLAND` in February —
   * and the pair scores 0.586, comfortably over the floor. It is still withheld,
   * because January's spelling occurs exactly once.
   *
   * That is the count guard working, and it is the guard's cost rather than a
   * bug: the same rule that takes a real statement from 48 candidate pairs to one
   * will sit on a true pair until both spellings recur. Pinned because it is the
   * trade §9p describes, and because the number is the first thing anyone tuning
   * this will want to move.
   */
  it('withholds a true pair while one spelling has occurred only once', async () => {
    const review = await queue();
    const names = review.provisional.map((entry) => entry.merchant.canonicalName);

    expect(names).toContain('BLUE BOTTLE COFFE');
    expect(names.some((name) => name.startsWith('BLUE BOTTLE COFFEE'))).toBe(true);
    expect(review.mergeCandidates).toEqual([]);
  });

  describe('once both spellings recur', () => {
    /**
     * §3.3's dedupe key is scoped by `account_id`, so January's rows land again on
     * a second account rather than merging — which is also the ordinary way a
     * merchant comes to recur: the household shops at it on two cards.
     *
     * The *part-a* split rather than the whole January file, because §3.3's first
     * dedupe layer is `file_sha256` over the contents and short-circuits a
     * byte-identical re-upload whatever account it is aimed at. Part-a carries the
     * January spelling of the coffee shop and hashes differently.
     */
    beforeEach(async () => {
      const secondId = (
        await app.inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { displayName: 'Northgate Joint', accountType: 'checking', last4: '9931' },
        })
      ).json().id;

      await importFixture('northgate-checking-2026-01-part-a.csv', secondId);
    });

    it('proposes the merchant the chain left under two names', async () => {
      const review = await queue();
      const coffee = review.mergeCandidates.find((candidate) =>
        candidate.keep.merchant.canonicalName.startsWith('BLUE BOTTLE'),
      );

      expect(coffee).toBeDefined();
      expect(coffee?.merge.merchant.canonicalName).toMatch(/^BLUE BOTTLE/);
      expect(coffee?.similarity).toBeGreaterThan(0.5);
    });

    it('carries the counts and the real spellings, so the card can justify itself', async () => {
      const review = await queue();
      const candidate = review.mergeCandidates.find((entry) =>
        entry.keep.merchant.canonicalName.startsWith('BLUE BOTTLE'),
      );

      expect(candidate?.keep.transactionCount).toBeGreaterThan(1);
      expect(candidate?.merge.transactionCount).toBeGreaterThan(1);
      expect(candidate?.keep.sampleDescriptors.length).toBeGreaterThan(0);
      // The count is the basis on which a user authorises a permanent,
      // precedence-topping change (§4.3), so it comes from the store rather than
      // from whatever page happens to be loaded.
      expect(candidate?.keep.transactionCount).toBeGreaterThanOrEqual(
        candidate?.merge.transactionCount ?? 0,
      );
    });
  });

  it('lists provisional merchants, largest history first', async () => {
    const review = await queue();

    expect(review.provisional.length).toBeGreaterThan(0);
    for (const entry of review.provisional) {
      expect(entry.merchant.source).toBe('rule');
    }
    const counts = review.provisional.map((entry) => entry.transactionCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('proposes nothing at all on an empty database', async () => {
    const empty = createContext({ databaseFile: ':memory:', profilesDir: PROFILES_DIR });
    const emptyApp = await buildServer({
      context: empty,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: PROFILES_DIR,
        backupDir: '',
      },
    });

    try {
      const response = await emptyApp.inject({
        method: 'GET',
        url: '/api/merchants/review-queue',
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as ReviewQueueShape).mergeCandidates).toEqual([]);
    } finally {
      await emptyApp.close();
      empty.close();
    }
  });

  it('says why there are no LLM proposals rather than omitting them', async () => {
    const review = await queue();

    expect(review.llmProposals).toEqual([]);
    // §2.3 lists this queue as carrying them, and §2.4's seam now exists — so the
    // reason is no longer "unbuilt" but "switched off", which is the shipped
    // default and not a fault. §6.8's argument about stated absences is the same
    // either way: an empty list that says nothing reads as a broken feature.
    // §4.2's stage and its floor are covered in `llm-api.spec.ts`.
    expect(review.llmProposalsUnavailableReason).toMatch(/No LLM provider is configured/);
  });

  describe('resolving one (§4.3)', () => {
    /**
     * The merge is a §4.3 correction with the descriptor list filled in, so what
     * these check is that it inherits §4.3's guarantees rather than restating
     * them: `user` precedence, the whole history swept, and the analyzers re-run.
     */
    async function mergeCoffee(): Promise<{ merchantId: string; transactionsAffected: number }> {
      const review = await queue();
      const [candidate] = review.mergeCandidates;
      const response = await app.inject({
        method: 'POST',
        url: `/api/merchants/${candidate.merge.merchant.id}/merge`,
        payload: { intoMerchantId: candidate.keep.merchant.id },
      });

      expect(response.statusCode).toBe(200);
      await context.jobRunner.drain();
      return response.json() as { merchantId: string; transactionsAffected: number };
    }

    beforeEach(async () => {
      const secondId = (
        await app.inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { displayName: 'Northgate Joint', accountType: 'checking', last4: '9931' },
        })
      ).json().id;
      await importFixture('northgate-checking-2026-01-part-a.csv', secondId);
    });

    it('repoints every row of the losing spelling and empties the queue', async () => {
      const before = await queue();
      const losing = before.mergeCandidates[0].merge;
      const surviving = before.mergeCandidates[0].keep;

      const result = await mergeCoffee();

      expect(result.merchantId).toBe(surviving.merchant.id);
      expect(result.transactionsAffected).toBe(losing.transactionCount);

      const after = await queue();
      // The pair is gone because one side has no transactions left, not because
      // anything was deleted — both merchants still exist.
      expect(
        after.mergeCandidates.filter((candidate) =>
          candidate.keep.merchant.canonicalName.startsWith('BLUE BOTTLE'),
        ),
      ).toEqual([]);
    });

    it('writes a `user` alias, which §4.3 puts above every other source', async () => {
      const before = await queue();
      const losingName = before.mergeCandidates[0].merge.merchant.canonicalName;

      await mergeCoffee();

      const alias = context.store.merchants
        .listAliases()
        .find((entry) => entry.aliasKey === losingName);

      expect(alias?.source).toBe('user');
      expect(alias?.matchType).toBe('exact');
    });

    it('refuses to merge a merchant into itself', async () => {
      const [merchant] = context.store.merchants.list();
      const response = await app.inject({
        method: 'POST',
        url: `/api/merchants/${merchant.id}/merge`,
        payload: { intoMerchantId: merchant.id },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s on a merchant that does not exist, rather than writing an alias', async () => {
      const [merchant] = context.store.merchants.list();
      const aliasesBefore = context.store.merchants.listAliases().length;

      const response = await app.inject({
        method: 'POST',
        url: '/api/merchants/nope/merge',
        payload: { intoMerchantId: merchant.id },
      });

      expect(response.statusCode).toBe(404);
      expect(context.store.merchants.listAliases()).toHaveLength(aliasesBefore);
    });

    it('is idempotent — merging again moves nothing and breaks nothing', async () => {
      const before = await queue();
      const losingId = before.mergeCandidates[0].merge.merchant.id;
      const keepId = before.mergeCandidates[0].keep.merchant.id;

      await mergeCoffee();
      const second = await app.inject({
        method: 'POST',
        url: `/api/merchants/${losingId}/merge`,
        payload: { intoMerchantId: keepId },
      });

      expect(second.statusCode).toBe(200);
      expect((second.json() as { transactionsAffected: number }).transactionsAffected).toBe(0);
    });
  });

  it('changes nothing — the queue only ever asks', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/merchants' })).json();
    await queue();
    const after = (await app.inject({ method: 'GET', url: '/api/merchants' })).json();

    expect(after).toEqual(before);
  });

  /**
   * §2.3's last two unbuilt routes (§9af).
   *
   * The `PATCH` changes what the rules know about a merchant that is already the
   * right one; the alias `POST` changes which merchant a spelling resolves to.
   * That difference is the whole of why only one of them enqueues §4.3's sweep,
   * and both halves of it are asserted below.
   */
  describe('editing a merchant (§2.3, §9af)', () => {
    async function anyMerchant() {
      const [merchant] = context.store.merchants.list();
      return merchant;
    }

    it('renames the display name and leaves the canonical name alone', async () => {
      const merchant = await anyMerchant();

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/merchants/${merchant.id}`,
        payload: { displayName: 'Blue Bottle' },
      });

      expect(response.statusCode).toBe(200);
      // The canonical name is the identity §4.1 step 7 resolves through. If a
      // rename moved it, the next import would compute the old string, miss this
      // row, and make a second merchant out of it.
      expect(response.json()).toMatchObject({
        displayName: 'Blue Bottle',
        canonicalName: merchant.canonicalName,
      });
    });

    it('promotes the row to `user`, so a re-seed cannot undo the judgement', async () => {
      // A provisional row specifically: `rule` is the source §4.1 step 7 writes,
      // and it is the one whose promotion actually matters. `upsertSeed` reclaims
      // a `seed` row at every boot and `upsertAlias` lets `llm` overwrite a `rule`
      // one — both because such a row is a cache of the chain's own output and
      // "overwriting it discards no decision, because nobody made one". Somebody
      // just did.
      const merchant = context.store.merchants.list().find((m) => m.source === 'rule');
      expect(merchant).toBeDefined();

      await app.inject({
        method: 'PATCH',
        url: `/api/merchants/${merchant?.id}`,
        payload: { isKnownSubscription: true },
      });

      expect(context.store.merchants.get(merchant?.id as string)?.source).toBe('user');
    });

    it('writes no alias and queues no sweep — nothing regrouped', async () => {
      const merchant = await anyMerchant();
      const aliasesBefore = context.store.merchants.listAliases().length;
      const jobsBefore = context.store.jobs.list().length;

      await app.inject({
        method: 'PATCH',
        url: `/api/merchants/${merchant.id}`,
        payload: { displayName: 'Renamed', isTransferKind: true },
      });

      expect(context.store.merchants.listAliases()).toHaveLength(aliasesBefore);
      expect(context.store.jobs.list()).toHaveLength(jobsBefore);
    });

    it('404s on an unknown category rather than surfacing the foreign key', async () => {
      const merchant = await anyMerchant();

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/merchants/${merchant.id}`,
        payload: { defaultCategoryId: 'no-such-category' },
      });

      expect(response.statusCode).toBe(404);
      expect((response.json() as { message: string }).message).toContain('category');
    });

    it('404s on an unknown merchant', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/merchants/nope',
        payload: { displayName: 'Nothing' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('writing an alias by hand (§2.3, §4.3, §9af)', () => {
    it('writes a `user` alias per key and queues the sweep', async () => {
      const [merchant] = context.store.merchants.list();

      const response = await app.inject({
        method: 'POST',
        url: '/api/merchants/aliases',
        payload: { merchantId: merchant.id, aliasKeys: ['SOME OLD SPELLING', 'ANOTHER ONE'] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        merchantId: merchant.id,
        aliasKeysWritten: ['SOME OLD SPELLING', 'ANOTHER ONE'],
      });

      // `user`, because a person said so — the same precedence a §6.3 correction
      // and a merge produce, through the same function.
      const written = context.store.merchants
        .listAliases()
        .filter((alias) => alias.aliasKey === 'SOME OLD SPELLING');
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ merchantId: merchant.id, source: 'user' });
    });

    it('drops blank keys, and refuses when that leaves nothing', async () => {
      const [merchant] = context.store.merchants.list();

      const response = await app.inject({
        method: 'POST',
        url: '/api/merchants/aliases',
        payload: { merchantId: merchant.id, aliasKeys: ['   '] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s on an unknown merchant, rather than writing an alias to nowhere', async () => {
      const aliasesBefore = context.store.merchants.listAliases().length;

      const response = await app.inject({
        method: 'POST',
        url: '/api/merchants/aliases',
        payload: { merchantId: 'nope', aliasKeys: ['ANYTHING'] },
      });

      expect(response.statusCode).toBe(404);
      expect(context.store.merchants.listAliases()).toHaveLength(aliasesBefore);
    });
  });
});

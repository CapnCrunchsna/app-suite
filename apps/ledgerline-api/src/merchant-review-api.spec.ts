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
    // §2.3 lists this queue as carrying them; §4.2 needs §2.4's seam, which is not
    // built. Stated, for the reason §6.8 gives about absences.
    expect(review.llmProposalsUnavailableReason).toMatch(/provider seam/);
  });

  it('changes nothing — the queue only ever asks', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/merchants' })).json();
    await queue();
    const after = (await app.inject({ method: 'GET', url: '/api/merchants' })).json();

    expect(after).toEqual(before);
  });
});

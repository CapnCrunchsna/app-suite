/**
 * §2.7's full sweep — "a full sweep is available explicitly from Settings" — and the
 * two things §9q said had to exist before it could be built.
 *
 * ## The condition this exists for cannot be reached by importing
 *
 * A sweep matters when §4.1's chain has *changed* since a row was stored (§9o):
 * every row imported before the amendment still carries the old chain's output, and
 * §4.3's incremental job will not rewrite it because it was designed on the premise
 * that it never needs to. There is no way to make that happen in a test by importing
 * — the chain is whatever it is today, and anything imported through it agrees with
 * it by construction.
 *
 * So these write the stale state directly and then assert the sweep repairs it. That
 * is the one place in this suite where raw SQL against `context.store.db` is the
 * honest tool rather than a shortcut: the thing under test is "a row that disagrees
 * with the chain", and the only way to produce one is to put it there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { enqueueRenormalize } from './lib/merchant-corrections.js';
import { buildServer } from './lib/server.js';

const PROFILES_DIR = new URL('../../../profiles', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);

interface StatementRow {
  readonly date: string;
  readonly description: string;
  readonly amountCents: number;
}

const usDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money = (cents: number): string => (cents / 100).toFixed(2);

function statementCsv(rows: readonly StatementRow[], openingCents = 500_000): string {
  let balance = openingCents;
  const lines = rows.map((row) => {
    balance += row.amountCents;
    return [usDate(row.date), row.description, money(row.amountCents), money(balance), 'Posted'].join(
      ',',
    );
  });

  return [
    'Northgate Bank',
    'Account: *****4821',
    `Statement Period: ${usDate(rows[0].date)} - ${usDate(rows[rows.length - 1].date)}`,
    '',
    'Date,Description,Amount,Running Balance,Status',
    ...lines,
  ].join('\n');
}

interface StoredRow {
  id: string;
  description_raw: string;
  description_normalized: string;
  merchant_id: string | null;
  category_id: string | null;
  category_source: string | null;
  dedupe_key: string;
  updated_at: string;
}

describe('ledgerline-api full re-normalize (§2.7, §6.8)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;

  const rows = (): StoredRow[] =>
    context.store.db
      .prepare(
        `SELECT id, description_raw, description_normalized, merchant_id, category_id,
                category_source, dedupe_key, updated_at
           FROM "transaction" ORDER BY id`,
      )
      .all() as StoredRow[];

  const rowFor = (fragment: string): StoredRow => {
    const found = rows().find((row) => row.description_raw.includes(fragment));
    if (!found) throw new Error(`no row matching ${fragment}`);
    return found;
  };

  /** §2.7's round trip, driven rather than awaited — same argument
   *  `analysis-api.spec.ts` makes: the assertion needs no timer to be true. */
  async function sweep(): Promise<Record<string, unknown>> {
    const response = await app.inject({ method: 'POST', url: '/api/jobs/renormalize' });
    expect(response.statusCode).toBe(202);
    await context.jobRunner.drain();

    const job = context.store.jobs.get((response.json() as { id: string }).id);
    expect(job?.state).toBe('succeeded');
    return JSON.parse(job?.resultJson ?? '{}') as Record<string, unknown>;
  }

  const renormalized = (result: Record<string, unknown>) =>
    result['renormalized'] as {
      descriptorsConsidered: number;
      transactionsRepointed: number;
      descriptorsRewritten: number;
      merchantsCreated: number;
    };

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

    accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;

    // One descriptor a seed alias resolves, two the chain can only clean. §9q
    // measured the second kind at 17 merchants of 21 on the first real statement,
    // which is why "the sweep skips them" was the blocker rather than a detail.
    const statement = [
      { date: '2026-01-04', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
      { date: '2026-01-09', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
      { date: '2026-01-14', description: 'TST* THE PLANT CAFE #0042', amountCents: -2210 },
      { date: '2026-01-19', description: 'SQ *BLUE BOTTLE 1234 PORTLAND', amountCents: -640 },
    ];

    const form = new FormData();
    form.append('files', new File([statementCsv(statement)], 'jan.csv', { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    const [staged] = (uploaded.json() as { imports: { import: { id: string } }[] }).imports;
    await app.inject({ method: 'PATCH', url: `/api/imports/${staged.import.id}`, payload: { accountId } });
    const committed = await app.inject({
      method: 'POST',
      url: `/api/imports/${staged.import.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode).toBe(200);
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------------ the route ---

  it('returns a job id and what the sweep will walk (§2.7)', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/jobs/renormalize' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ coalesced: false, transactions: 4 });
    expect((response.json() as { id: string }).id).toBeTruthy();
  });

  it('re-runs the analysis afterwards, like every other re-normalize (§2.7)', async () => {
    const result = await sweep();

    // §2.7: "re-runs the chain over every historical transaction **and then re-runs
    // the full analysis**." One job, so "done" is the first moment both are true.
    expect(result['analysis']).toBeDefined();
    expect(renormalized(result).descriptorsConsidered).toBe(4);
  });

  // -------------------------------------------------- §9q's second blocker ---

  describe('descriptors the chain resolves provisionally', () => {
    /**
     * The blocker §9q named: `runRenormalize` returns early for any descriptor whose
     * resolution is not an alias.
     *
     * **When that actually bites is narrower than it sounds, and worth pinning.** An
     * import leaves a `rule` alias behind for every provisional merchant it creates
     * (§4.1 step 7), so re-running the chain over a freshly imported ledger resolves
     * through those aliases and the skip never fires. The condition that reaches it
     * is §9o's: the chain **changed**, so it now produces a cleaned name that no
     * alias covers — and that is precisely the case a sweep exists for. Removing the
     * alias is how a test says "the chain's output is a name nothing has an alias
     * for" without needing two versions of the chain.
     */
    it('re-points a descriptor no alias covers, which the incremental path skips', async () => {
      const before = rowFor('PLANT CAFE');
      expect(before.merchant_id).not.toBeNull();

      context.store.db
        .prepare('DELETE FROM merchant_alias WHERE alias_key = ?')
        .run(before.description_normalized);
      context.store.db
        .prepare('UPDATE "transaction" SET merchant_id = NULL WHERE description_raw LIKE ?')
        .run('%PLANT CAFE%');

      // The incremental path, run over exactly this descriptor, does nothing.
      const { id } = enqueueRenormalize(context, {
        transactionIds: [],
        aliasKeys: [before.description_normalized],
      });
      await context.jobRunner.drain();
      expect(context.store.jobs.get(id)?.state).toBe('succeeded');
      expect(rowFor('PLANT CAFE').merchant_id).toBeNull();

      // The sweep does not — it runs §4.1 step 7 itself.
      await sweep();
      expect(rowFor('PLANT CAFE').merchant_id).toBe(before.merchant_id);
    });

    it('creates the provisional merchant when the chain names one nothing has seen', async () => {
      const merchant = rowFor('BLUE BOTTLE').merchant_id;
      expect(merchant).not.toBeNull();

      // Detach the rows, then remove the merchant and the `rule` alias that would
      // otherwise resolve the descriptor without step 7 ever running.
      context.store.db.prepare('UPDATE "transaction" SET merchant_id = NULL').run();
      context.store.db.prepare('DELETE FROM merchant_alias WHERE merchant_id = ?').run(merchant);
      context.store.db.prepare('DELETE FROM merchant_canonical WHERE id = ?').run(merchant);

      const result = renormalized(await sweep());

      expect(result.merchantsCreated).toBeGreaterThan(0);
      expect(rowFor('BLUE BOTTLE').merchant_id).not.toBeNull();
    });
  });

  // --------------------------------------------------- §9q's first blocker ---

  describe('description_normalized, which §4.3’s job will not rewrite', () => {
    it('puts back what the current chain produces', async () => {
      const before = rowFor('PLANT CAFE');
      context.store.db
        .prepare('UPDATE "transaction" SET description_normalized = ? WHERE id = ?')
        .run('WHAT THE OLD CHAIN SAID', before.id);

      const result = renormalized(await sweep());

      expect(rowFor('PLANT CAFE').description_normalized).toBe(before.description_normalized);
      expect(result.descriptorsRewritten).toBeGreaterThan(0);
    });

    /**
     * §3.3's dedupe key is computed from the raw descriptor through the frozen
     * `collapse_v1`, and §4 opens by separating the two precisely so a sweep is safe
     * to run. A sweep that moved it would re-key rows the merge rule has already
     * reasoned about — which is the one failure here that would corrupt rather than
     * merely mislabel.
     */
    it('never moves `dedupe_key`', async () => {
      const before = rows().map((row) => [row.id, row.dedupe_key] as const);

      context.store.db
        .prepare('UPDATE "transaction" SET description_normalized = ?')
        .run('WHAT THE OLD CHAIN SAID');
      await sweep();

      const after = new Map(rows().map((row) => [row.id, row.dedupe_key]));
      for (const [id, key] of before) expect(after.get(id)).toBe(key);
    });

    it('leaves a `user` category alone and moves the merchant anyway (§4.3)', async () => {
      const target = rowFor('PLANT CAFE');
      const [category] = context.store.merchants.listCategories();

      context.store.db
        .prepare(
          `UPDATE "transaction"
              SET category_id = ?, category_source = 'user',
                  description_normalized = ?, merchant_id = NULL
            WHERE id = ?`,
        )
        .run(category.id, 'WHAT THE OLD CHAIN SAID', target.id);

      await sweep();

      const after = rows().find((row) => row.id === target.id) as StoredRow;
      // §4.3 calls a correction permanent; `category_source` is what records which
      // is which. The merchant still moves — a hand-picked category is not a reason
      // to leave a merchant wrong.
      expect(after.category_source).toBe('user');
      expect(after.category_id).toBe(category.id);
      expect(after.merchant_id).not.toBeNull();
      expect(after.description_normalized).toBe(target.description_normalized);
    });
  });

  // ------------------------------------------------------------- no-op-ness ---

  it('writes nothing when the chain already agrees, rather than stamping every row', async () => {
    const before = new Map(rows().map((row) => [row.id, row.updated_at]));

    const result = renormalized(await sweep());

    // §3.4's watermark re-index reads `updated_at`. A sweep that touched every row
    // would hand it the whole table to re-index for nothing.
    expect(result.transactionsRepointed).toBe(0);
    expect(result.descriptorsRewritten).toBe(0);
    for (const row of rows()) expect(row.updated_at).toBe(before.get(row.id));
  });

  it('is idempotent — a second sweep finds nothing left to do', async () => {
    context.store.db.prepare('UPDATE "transaction" SET description_normalized = ?').run('STALE');

    expect(renormalized(await sweep()).descriptorsRewritten).toBe(4);
    expect(renormalized(await sweep()).descriptorsRewritten).toBe(0);
  });

  // ------------------------------------------------------------ coalescing ---

  /**
   * §2.7 coalesces within a kind, so the sweep and the incremental path share one.
   * That is only safe because a sweep **subsumes** incremental work: it re-resolves
   * every row rather than a key-space, so merging the two loses nothing.
   */
  it('a sweep queued beside a correction merges into one job, and the sweep wins', async () => {
    const first = enqueueRenormalize(context, { transactionIds: [], aliasKeys: ['SOMETHING'] });
    const second = await app.inject({ method: 'POST', url: '/api/jobs/renormalize' });

    expect(second.json()).toMatchObject({ id: first.id, coalesced: true });

    const payload = JSON.parse(context.store.jobs.get(first.id)?.payloadJson ?? '{}') as {
      full?: boolean;
      aliasKeys: string[];
    };
    expect(payload.full).toBe(true);
    // The incremental work is still carried rather than discarded, which is what
    // makes the merge lossless rather than merely convenient.
    expect(payload.aliasKeys).toContain('SOMETHING');
  });

  // --------------------------------------------------------- keyset paging ---

  /**
   * The sweep writes to the rows it is paging through, so the walk has to be stable
   * under its own writes. Asserted at the repository rather than through a
   * 501-row import: what is being checked is that two pages neither overlap nor
   * leave a gap, and that is a property of the query.
   */
  it('pages by keyset, covering every row exactly once', () => {
    const all = rows().map((row) => row.id);

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = context.store.transactions.listForRenormalize(2, after);
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      after = page[page.length - 1].id;
    }

    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

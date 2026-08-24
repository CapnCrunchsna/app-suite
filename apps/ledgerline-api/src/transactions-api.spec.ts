/**
 * §6.3's page contract, exercised over HTTP.
 *
 * Every filter the section names, the full-text search, pagination, the row
 * expander's two halves, the four inline edits, and the bulk correction path that
 * §6.3 calls "what makes normalization converge in minutes instead of row by row."
 *
 * Over real fixture bytes, through the real import pipeline, for the same reason
 * `import-pipeline.spec.ts` does it that way: the descriptors this page has to
 * group are the ones §4's chain actually produced, not ones a test author picked
 * because they were convenient. Two of the assertions below only hold because the
 * chain deliberately leaves a city on a descriptor (§4.1 stage 4) — the January
 * statement's `BLUE BOTTLE COFFE` and February's `BLUE BOTTLE COFFEE PORTLAND` are
 * one merchant under two provisional names, which is the exact condition §4.1
 * accepts and §6.3's bulk path exists to resolve.
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

interface TransactionShape {
  id: string;
  accountId: string;
  effectiveDate: string;
  postedDate: string | null;
  amountCents: number;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchantId: string | null;
  categoryId: string | null;
  categorySource: string | null;
  isPending: boolean;
  isInternalTransfer: boolean;
  /** Null on a row a user marked by hand; set on one a `transfer_link` claims
   *  (§2.6). The difference is what stops a run clearing somebody's edit. */
  transferPairId: string | null;
  isExcluded: boolean;
  dedupeKeyVersion: string;
}

interface PageShape {
  rows: { transaction: TransactionShape; hasFinding: boolean }[];
  total: number;
  limit: number;
  offset: number;
}

interface BulkResultShape {
  dryRun: boolean;
  matchCount: number;
  updated: number;
  aliasKeysWritten: string[];
  renormalizeJobId: string | null;
  renormalizeJobCoalesced: boolean;
}

describe('ledgerline-api transactions surface (§6.3)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let checkingId: string;
  let cardId: string;

  function fixture(name: string): Uint8Array {
    return new Uint8Array(
      readFileSync(fileURLToPath(new URL(`fixtures/statements/${name}`, workspaceRoot))),
    );
  }

  /** Upload, confirm the guessed account, commit — §6.1's sequence in one call. */
  async function importFixture(
    name: string,
    accountId: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    const form = new FormData();
    form.append('files', new File([fixture(name)], name, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', {
      method: 'POST',
      body: form,
    });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: {
        'content-type': encoded.headers.get('content-type') as string,
      },
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
      payload: body,
    });
    expect(committed.statusCode).toBe(200);
  }

  async function search(query: string): Promise<PageShape> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/transactions?${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as PageShape;
  }

  async function bulk(
    filter: Record<string, unknown>,
    change: Record<string, unknown> = {},
    options: { dryRun?: boolean } = {},
  ): Promise<{ statusCode: number; body: BulkResultShape }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/transactions/bulk${options.dryRun ? '?dryRun=true' : ''}`,
      payload: { filter, change },
    });
    return {
      statusCode: response.statusCode,
      body: response.json() as BulkResultShape,
    };
  }

  /** The one row a descriptor matches, for the tests that need an id. */
  async function oneRow(query: string): Promise<TransactionShape> {
    const page = await search(query);
    expect(page.rows).toHaveLength(1);
    return page.rows[0].transaction;
  }

  beforeEach(async () => {
    context = createContext({
      databaseFile: ':memory:',
      profilesDir: PROFILES_DIR,
    });
    app = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: PROFILES_DIR,
        backupDir: '',
      },
    });

    const checking = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        displayName: 'Northgate Checking',
        institution: 'Northgate Bank',
        accountType: 'checking',
        last4: '4821',
      },
    });
    checkingId = (checking.json() as { id: string }).id;

    const card = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        displayName: 'Cardinal Card',
        institution: 'Cardinal Card',
        accountType: 'credit_card',
        last4: '9012',
      },
    });
    cardId = (card.json() as { id: string }).id;

    // 12 + 4 checking rows, 8 card rows. The card's $0.00 trial authorization
    // needs §3.2's explicit reviewer opt-in.
    await importFixture('northgate-checking-2026-01.csv', checkingId);
    await importFixture('northgate-checking-2026-02.csv', checkingId);
    await importFixture('cardinal-card-2026-01.csv', cardId, {
      allowZeroAmountRows: true,
    });
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------------- filters ---

  describe('filters', () => {
    it('returns every committed row by default, less the pair §2.6 linked', async () => {
      // 24 rows are committed. Two of them are the $500 card payment — the
      // checking debit and the card's own credit — which §2.6's matcher links
      // automatically at commit, and §6.3 keeps off the screen unless asked for.
      // That gap between 22 and 24 is the whole of what this feature does to
      // this page, so it is stated here once and assumed below.
      expect((await search('limit=1000')).total).toBe(22);
      expect((await search('includeInternalTransfers=true&limit=1000')).total).toBe(24);
    });

    it('filters by account', async () => {
      expect((await search(`accountIds=${checkingId}&limit=1000`)).total).toBe(15);
      expect((await search(`accountIds=${cardId}&limit=1000`)).total).toBe(7);
      expect((await search(`accountIds=${checkingId},${cardId}&limit=1000`)).total).toBe(22);

      // One linked row on each side, which is what a transfer *is* — the same
      // money leaving one account and arriving in another.
      expect(
        (await search(`accountIds=${checkingId}&includeInternalTransfers=true&limit=1000`)).total,
      ).toBe(16);
      expect(
        (await search(`accountIds=${cardId}&includeInternalTransfers=true&limit=1000`)).total,
      ).toBe(8);
    });

    it('filters by date range on effective_date, not posted_date', async () => {
      // The card statement posts a day or two after each transaction date, so a
      // range that ends on 01/31 must include a row that *posted* in February and
      // must be chosen by its transaction date (§7.1).
      const january = await search('from=2026-01-01&to=2026-01-31&limit=1000');
      expect(january.total).toBe(18);

      const february = await search('from=2026-02-01&to=2026-02-28&limit=1000');
      expect(february.total).toBe(4);
      expect(
        february.rows.every((row) => row.transaction.effectiveDate.startsWith('2026-02')),
      ).toBe(true);
    });

    it('filters by amount range in integer cents', async () => {
      // Money is never a formatted string on the wire (§7.3), so the filter is
      // cents in and cents out.
      const overFifty = await search('minAmountCents=5000&limit=1000');
      expect(overFifty.rows.every((row) => row.transaction.amountCents >= 5000)).toBe(true);
      expect(overFifty.rows.map((row) => row.transaction.amountCents)).toContain(320000);

      const smallDebits = await search('minAmountCents=-2000&maxAmountCents=-1000&limit=1000');
      expect(
        smallDebits.rows.every(
          (row) => row.transaction.amountCents >= -2000 && row.transaction.amountCents <= -1000,
        ),
      ).toBe(true);
    });

    it('filters by merchant', async () => {
      // NETFLIX resolves through a seed alias on both statements (§4.1 step 6).
      const netflix = await search('merchantIds=netflix&limit=1000');
      expect(netflix.total).toBe(3);
      expect(netflix.rows.every((row) => row.transaction.merchantId === 'netflix')).toBe(true);
    });

    it('filters by category', async () => {
      const row = await oneRow(`q=SHELL OIL&accountIds=${checkingId}`);
      // Not zero: §2.5's rule already categorized the Uber and Lyft rows from
      // their merchants' defaults (§9h). The filter is what is under test, so the
      // assertion is relative to what the rule left rather than to a fixed count.
      const before = await search('categoryIds=transport&limit=1000');

      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { categoryId: 'transport' },
      });

      const transport = await search('categoryIds=transport&limit=1000');
      expect(transport.total).toBe(before.total + 1);
      expect(transport.rows.some((r) => r.transaction.id === row.id)).toBe(true);
      expect(transport.rows.every((r) => r.transaction.categoryId === 'transport')).toBe(true);
    });

    /**
     * §2.5's `normalize` stage, second half: "Category assigned by rule."
     *
     * The rule is one line — a resolved merchant's `default_category_id` becomes
     * the row's category, stamped `rule` — and until §9h nothing implemented it,
     * so `transaction.category_id` was null on every row ever imported and §5.10's
     * `trend.v1` had nothing to trend (§9g).
     */
    it('assigns a category from the resolved merchant at import (§2.5, §9h)', async () => {
      const netflix = await search('merchantIds=netflix&limit=1000');
      expect(netflix.total).toBeGreaterThan(0);
      expect(
        netflix.rows.every(
          (row) =>
            row.transaction.categoryId === 'entertainment' &&
            row.transaction.categorySource === 'rule'
        )
      ).toBe(true);

      // A provisional merchant has no default, and a rule with no answer says
      // nothing rather than guessing one.
      const provisional = await search(`q=BLUE BOTTLE&accountIds=${checkingId}&limit=1000`);
      expect(provisional.total).toBeGreaterThan(0);
      expect(
        provisional.rows.every(
          (row) => row.transaction.categoryId === null && row.transaction.categorySource === null
        )
      ).toBe(true);
    });

    it('filters by pending', async () => {
      // §2.5: pending rows are stored and shown, and excluded from every total.
      const pending = await search('isPending=true&limit=1000');
      expect(pending.total).toBe(1);
      expect(pending.rows[0].transaction.descriptionRaw).toContain('UBER TRIP');

      expect((await search('isPending=false&limit=1000')).total).toBe(21);
    });

    it('filters by has-finding through finding_evidence', async () => {
      // No analyzer has run, so every row is finding-free — which is the honest
      // answer and still the assertion worth making: the filter reads
      // `finding_evidence` rather than a column on the row (§2.3).
      expect((await search('hasFinding=true&limit=1000')).total).toBe(0);
      expect((await search('hasFinding=false&limit=1000')).total).toBe(22);
    });

    it('hides the transfer §2.6 linked, and the one marked by hand', async () => {
      // §6.3's toggle is off by default: a credit-card payment is not spending,
      // and showing it by default double-counts on screen what §2.6 keeps out of
      // the totals. Nothing was clicked to get this — the pair was linked when
      // the second statement was committed.
      const payment = await oneRow(
        `q=ONLINE PMT CARDINAL&includeInternalTransfers=true&accountIds=${checkingId}`,
      );
      expect(payment.isInternalTransfer).toBe(true);
      expect(payment.transferPairId).not.toBeNull();

      // A hand-marked row is the same filter and a different provenance: §6.3's
      // inline edit still works, and carries no pair id because no link claims it.
      const zelle = await oneRow(`q=ZELLE&accountIds=${checkingId}`);
      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${zelle.id}`,
        payload: { isInternalTransfer: true },
      });

      expect((await search('limit=1000')).total).toBe(21);
      expect((await search('includeInternalTransfers=true&limit=1000')).total).toBe(24);
    });

    it('hides excluded rows unless asked', async () => {
      const row = await oneRow(`q=ZELLE&accountIds=${checkingId}`);
      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { isExcluded: true },
      });

      expect((await search('limit=1000')).total).toBe(21);
      expect((await search('includeExcluded=true&limit=1000')).total).toBe(22);
    });
  });

  // -------------------------------------------------------------- search ---

  describe('full-text search across raw and normalized descriptors', () => {
    it('matches the raw statement descriptor', async () => {
      // `SQ *` survives only in the raw column — the chain strips the processor
      // prefix on its way to `description_normalized` (§4.1 stage 2).
      const page = await search('q=SQ *BLUE BOTTLE&limit=1000');
      expect(page.total).toBe(1);
      expect(page.rows[0].transaction.descriptionRaw).toContain('SQ *BLUE BOTTLE');
    });

    it('matches the normalized descriptor', async () => {
      // `NETFLIX` exists only after the chain has taken `.COM` and the phone
      // number off `NETFLIX.COM 866-579-7172 CA` (§4.1 stage 4).
      const page = await search('q=NETFLIX&limit=1000');
      expect(page.total).toBe(3);
      expect(page.rows.every((row) => row.transaction.descriptionNormalized === 'NETFLIX')).toBe(
        true,
      );
    });

    it('spans both spellings the chain produced for one merchant', async () => {
      const page = await search('q=BLUE BOTTLE&limit=1000');
      expect(page.total).toBe(3);
      expect(new Set(page.rows.map((row) => row.transaction.descriptionNormalized))).toEqual(
        new Set(['BLUE BOTTLE COFFE', 'BLUE BOTTLE COFFEE PORTLAND']),
      );
    });

    it('treats a LIKE wildcard in the search term as a literal', async () => {
      expect((await search('q=%&limit=1000')).total).toBe(0);
      expect((await search('q=_&limit=1000')).total).toBe(0);
    });
  });

  // ---------------------------------------------------------- pagination ---

  describe('pagination and sort', () => {
    it('pages without dropping or repeating a row', async () => {
      const first = await search('limit=10&offset=0&sort=date_asc');
      const second = await search('limit=10&offset=10&sort=date_asc');
      const third = await search('limit=10&offset=20&sort=date_asc');

      expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([10, 10, 2]);
      expect(first.total).toBe(22);

      const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.transaction.id);
      expect(new Set(ids).size).toBe(22);
    });

    it('orders by effective_date, and never by posted_date (§7.1)', async () => {
      const ascending = (await search('limit=1000&sort=date_asc')).rows.map(
        (row) => row.transaction.effectiveDate,
      );
      expect([...ascending].sort()).toEqual(ascending);

      const descending = (await search('limit=1000&sort=date_desc')).rows.map(
        (row) => row.transaction.effectiveDate,
      );
      expect([...descending].sort().reverse()).toEqual(descending);
    });

    it('sorts by amount in signed cents', async () => {
      const amounts = (await search('limit=1000&sort=amount_desc')).rows.map(
        (row) => row.transaction.amountCents,
      );
      expect(amounts[0]).toBe(320000);
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    });

    it('refuses a page size beyond the cap rather than serving it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/transactions?limit=5000',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ------------------------------------------------------- row expander ---

  describe('the row expander', () => {
    it('returns the verbatim statement line and the imports that cover the row', async () => {
      const row = await oneRow(`q=SQ *BLUE BOTTLE&accountIds=${checkingId}`);

      const response = await app.inject({
        method: 'GET',
        url: `/api/transactions/${row.id}`,
      });
      const detail = response.json() as {
        transaction: TransactionShape;
        coveringImports: { id: string; sourceFilename: string }[];
        rawText: string | null;
        sources: {
          importId: string;
          sourceFilename: string;
          rawText: string | null;
        }[];
      };

      // Verbatim means verbatim: the whole CSV line, with the amount as the bank
      // printed it, not the parsed row (§2.5).
      expect(detail.rawText).toBe(
        '01/03/2026,POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA,-18.75,2481.25,Posted',
      );
      expect(detail.coveringImports.map((i) => i.sourceFilename)).toEqual([
        'northgate-checking-2026-01.csv',
      ]);
      expect(detail.sources).toHaveLength(1);
      expect(detail.sources[0].rawText).toBe(detail.rawText);
    });

    it('404s an unknown id rather than returning an empty row', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/transactions/nope',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: 'not_found' });
    });
  });

  // ------------------------------------------------------- inline edits ---

  describe('inline edits', () => {
    it('assigns a merchant, and records it as a user decision (§4.3)', async () => {
      const row = await oneRow(`q=TRIAL PERIOD HULU&accountIds=${cardId}`);
      expect(row.merchantId).not.toBe('hulu');

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { merchantId: 'hulu' },
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as TransactionShape).merchantId).toBe('hulu');

      // §4.3: the correction writes a `user` alias, which is what makes the *next*
      // statement carrying this descriptor resolve correctly without being asked.
      const alias = context.store.merchants
        .listAliases()
        .find((entry) => entry.aliasKey === 'TRIAL PERIOD HULU');
      expect(alias).toMatchObject({
        merchantId: 'hulu',
        source: 'user',
        matchType: 'exact',
      });
    });

    it('enqueues a coalesced re-normalize job for a merchant correction', async () => {
      const first = await oneRow(`q=TRIAL PERIOD HULU&accountIds=${cardId}`);
      const second = await oneRow(`q=SHELL OIL&accountIds=${checkingId}`);

      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${first.id}`,
        payload: { merchantId: 'hulu' },
      });
      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${second.id}`,
        payload: { merchantId: 'shell' },
      });

      // §2.7: "a run of eight corrections is one re-normalization, not eight full
      // sweeps." Two corrections, one queued job.
      const jobs = await app.inject({ method: 'GET', url: '/api/jobs' });
      const queued = (jobs.json() as { id: string; kind: string; state: string }[]).filter(
        (job) => job.kind === 'renormalize',
      );
      expect(queued).toHaveLength(1);
      expect(queued[0].state).toBe('queued');

      const job = await app.inject({
        method: 'GET',
        url: `/api/jobs/${queued[0].id}`,
      });
      expect(job.json()).toMatchObject({ state: 'queued', progress: 0 });
    });

    it('assigns a category and stamps category_source as user', async () => {
      const row = await oneRow(`q=TRADER JOES&accountIds=${checkingId}`);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { categoryId: 'groceries' },
      });

      expect(response.json()).toMatchObject({
        categoryId: 'groceries',
        categorySource: 'user',
      });
    });

    it('marks an internal transfer and excludes from analysis independently', async () => {
      // Already linked by §2.6, so reaching it needs the toggle. The point of the
      // test is unchanged: the two flags are separate columns and a write to one
      // does not disturb the other.
      const row = await oneRow(
        `q=PAYMENT THANK YOU&includeInternalTransfers=true&accountIds=${cardId}`,
      );

      const transfer = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { isInternalTransfer: true },
      });
      expect(transfer.json()).toMatchObject({
        isInternalTransfer: true,
        isExcluded: false,
      });

      const excluded = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { isExcluded: true },
      });
      expect(excluded.json()).toMatchObject({
        isInternalTransfer: true,
        isExcluded: true,
      });
    });

    it('leaves money as integer cents through an edit', async () => {
      const row = await oneRow(`q=TRADER JOES&accountIds=${checkingId}`);
      expect(row.amountCents).toBe(-8734);

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${row.id}`,
        payload: { categoryId: 'groceries' },
      });
      expect((response.json() as TransactionShape).amountCents).toBe(-8734);
    });

    it('404s an edit to an unknown row', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/transactions/nope',
        payload: { merchantId: 'hulu' },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------- the bulk path ---

  describe('POST /api/transactions/bulk — §6.3’s "apply to all N matching"', () => {
    it('counts the matched set and writes nothing on a dry run', async () => {
      const before = await search('q=BLUE BOTTLE&limit=1000');

      const dry = await bulk(
        {
          descriptorsNormalized: ['BLUE BOTTLE COFFE', 'BLUE BOTTLE COFFEE PORTLAND'],
        },
        { merchantId: 'starbucks' },
        { dryRun: true },
      );

      expect(dry.body).toMatchObject({
        dryRun: true,
        matchCount: 3,
        updated: 0,
        aliasKeysWritten: [],
        renormalizeJobId: null,
      });

      // §2.3: "returns the match count only". Nothing moved — not the merchants,
      // not the alias table, not the queue.
      const after = await search('q=BLUE BOTTLE&limit=1000');
      expect(after.rows.map((row) => row.transaction.merchantId)).toEqual(
        before.rows.map((row) => row.transaction.merchantId),
      );
      expect(context.store.merchants.listAliases().some((a) => a.source === 'user')).toBe(false);
      expect(context.store.jobs.list()).toHaveLength(0);
    });

    it('applies to exactly the set the dry run counted', async () => {
      const filter = {
        descriptorsNormalized: ['BLUE BOTTLE COFFE', 'BLUE BOTTLE COFFEE PORTLAND'],
      };

      const dry = await bulk(filter, { merchantId: 'starbucks' }, { dryRun: true });
      const applied = await bulk(filter, { merchantId: 'starbucks' });

      expect(applied.body.matchCount).toBe(dry.body.matchCount);
      expect(applied.body.updated).toBe(3);

      const rows = await search('q=BLUE BOTTLE&limit=1000');
      expect(rows.rows.every((row) => row.transaction.merchantId === 'starbucks')).toBe(true);
    });

    it('writes one user alias per corrected descriptor (§4.3)', async () => {
      const applied = await bulk(
        {
          descriptorsNormalized: ['BLUE BOTTLE COFFE', 'BLUE BOTTLE COFFEE PORTLAND'],
        },
        { merchantId: 'starbucks' },
      );

      // Two provisional spellings of one merchant is §4.1 stage 4's stated known
      // cost; joining them is step 6's job, and this is the UI doing it.
      expect(applied.body.aliasKeysWritten.sort()).toEqual([
        'BLUE BOTTLE COFFE',
        'BLUE BOTTLE COFFEE PORTLAND',
      ]);

      const user = context.store.merchants.listAliases().filter((a) => a.source === 'user');
      expect(user.map((a) => a.aliasKey).sort()).toEqual([
        'BLUE BOTTLE COFFE',
        'BLUE BOTTLE COFFEE PORTLAND',
      ]);
      expect(user.every((a) => a.merchantId === 'starbucks')).toBe(true);
    });

    it('enqueues one coalesced re-normalize job for the whole correction', async () => {
      const applied = await bulk(
        { descriptorsNormalized: ['BLUE BOTTLE COFFE'] },
        { merchantId: 'starbucks' },
      );

      expect(applied.body.renormalizeJobId).not.toBeNull();
      expect(applied.body.renormalizeJobCoalesced).toBe(false);

      const second = await bulk(
        { descriptorsNormalized: ['BLUE BOTTLE COFFEE PORTLAND'] },
        { merchantId: 'starbucks' },
      );
      expect(second.body.renormalizeJobId).toBe(applied.body.renormalizeJobId);
      expect(second.body.renormalizeJobCoalesced).toBe(true);
      expect(context.store.jobs.list()).toHaveLength(1);
    });

    it('counts through the same filter set the table uses', async () => {
      const byAccount = await bulk(
        { accountIds: [checkingId], q: 'NETFLIX' },
        {},
        { dryRun: true },
      );
      expect(byAccount.body.matchCount).toBe(2);

      const everywhere = await bulk({ q: 'NETFLIX' }, {}, { dryRun: true });
      expect(everywhere.body.matchCount).toBe(3);

      const dated = await bulk(
        { q: 'NETFLIX', from: '2026-02-01', to: '2026-02-28' },
        {},
        { dryRun: true },
      );
      expect(dated.body.matchCount).toBe(1);
    });

    it('honours the internal-transfer default so the count matches the table', async () => {
      // The card payment is linked, so it is out of the table and must be out of
      // the count too — "apply to all N matching" is a promise about the rows the
      // user can see.
      const hidden = await bulk({ q: 'ONLINE PMT CARDINAL' }, {}, { dryRun: true });
      expect(hidden.body.matchCount).toBe(0);

      const shown = await bulk(
        { q: 'ONLINE PMT CARDINAL', includeInternalTransfers: true },
        {},
        { dryRun: true },
      );
      expect(shown.body.matchCount).toBe(1);
    });

    it('assigns a category in bulk and stamps the source', async () => {
      const applied = await bulk({ merchantIds: ['netflix'] }, { categoryId: 'entertainment' });
      expect(applied.body.updated).toBe(3);

      const rows = await search('merchantIds=netflix&limit=1000');
      expect(
        rows.rows.every(
          (row) =>
            row.transaction.categoryId === 'entertainment' &&
            row.transaction.categorySource === 'user',
        ),
      ).toBe(true);

      // A category assignment is not a merchant correction: no alias, no job.
      expect(applied.body.aliasKeysWritten).toEqual([]);
      expect(applied.body.renormalizeJobId).toBeNull();
    });

    it('marks internal transfers in bulk', async () => {
      // Two rows §2.6 did not link — the Zelle payment out and the payroll
      // deposit in — because the bulk path has to reach rows the matcher never
      // claimed. This is §6.3's escape hatch for a transfer whose counterpart is
      // not in the system, which §2.6 says the algorithm cannot ever find.
      const applied = await bulk(
        {
          descriptorsNormalized: ['ZELLE TO JORDAN P REF', 'PAYROLL DIRECT DEP MERIDIAN LLC'],
        },
        { isInternalTransfer: true },
      );

      expect(applied.body.updated).toBe(2);
      // 22 visible less these two: the pair §2.6 linked was already out.
      expect((await search('limit=1000')).total).toBe(20);
      expect((await search('includeInternalTransfers=true&limit=1000')).total).toBe(24);
    });

    it('refuses a merchant that does not exist rather than nulling the column', async () => {
      const applied = await bulk({ descriptorsNormalized: ['NETFLIX'] }, { merchantId: 'nope' });

      expect(applied.statusCode).toBe(404);
      expect(
        (await search('q=NETFLIX&limit=1000')).rows.every(
          (row) => row.transaction.merchantId === 'netflix',
        ),
      ).toBe(true);
    });

    it('refuses a category that does not exist', async () => {
      const applied = await bulk({ descriptorsNormalized: ['NETFLIX'] }, { categoryId: 'nope' });
      expect(applied.statusCode).toBe(404);
    });

    it('reports zero, and does nothing, for a filter that matches nothing', async () => {
      const applied = await bulk(
        { descriptorsNormalized: ['NO SUCH DESCRIPTOR'] },
        { merchantId: 'starbucks' },
      );

      expect(applied.body).toMatchObject({
        matchCount: 0,
        updated: 0,
        aliasKeysWritten: [],
        renormalizeJobId: null,
      });
      expect(context.store.jobs.list()).toHaveLength(0);
    });

    it('requires a filter — an unbounded bulk edit is not a default', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/transactions/bulk',
        payload: { change: { merchantId: 'starbucks' } },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ------------------------------------------------- the filter lookups ---

  describe('the lists the filters are populated from', () => {
    it('lists merchants, seeded and provisional, with their source', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/merchants',
      });
      const merchants = response.json() as {
        id: string;
        source: string;
        displayName: string;
      }[];

      expect(merchants.find((m) => m.id === 'netflix')).toMatchObject({
        source: 'seed',
      });
      // §4.1 step 7's provisional merchants are in the list too — they are what
      // the user is correcting, so hiding them would hide the work.
      expect(merchants.some((m) => m.source === 'rule')).toBe(true);
    });

    it('lists categories', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/categories',
      });
      const categories = response.json() as { id: string; kind: string }[];

      expect(categories.length).toBeGreaterThan(0);
      expect(categories.find((c) => c.id === 'groceries')).toMatchObject({
        kind: 'spend',
      });
      expect(new Set(categories.map((c) => c.kind))).toEqual(
        new Set(['spend', 'fee', 'transfer', 'income']),
      );
    });
  });
});

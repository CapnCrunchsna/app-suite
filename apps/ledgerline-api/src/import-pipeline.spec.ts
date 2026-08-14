/**
 * End to end, over the committed fixtures and the shipped profiles.
 *
 * This is the composition root's own test: real CSV bytes go in through
 * `POST /api/imports`, the whole of §2.5's `ingest → detect → parse → normalize
 * → dedupe → store` runs, and the assertions are made against the HTTP surface
 * — no repository is called directly, because §2.1's "libs compute, the app
 * persists" is only true if the app is what is being exercised.
 *
 * The three properties §3.3 exists to guarantee each have a test with that
 * section's own words on them. Everything else here is what had to be true for
 * those three to mean anything.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { MIGRATIONS } from '@metrum/ledgerline-data';

import { API_HOST, DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const workspaceRoot = new URL('../../../', import.meta.url);

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`fixtures/statements/${name}`, workspaceRoot))));
}

const PROFILES_DIR = fileURLToPath(new URL('profiles', workspaceRoot));

interface UploadedImport {
  import: { id: string; status: string; rowsParsed: number; formatProfileId: string | null };
  created: boolean;
  accountSuggestion: { accountId: string; reason: string } | null;
}

describe('ledgerline-api import pipeline', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let checkingId: string;
  let cardId: string;

  /**
   * The same statement, re-issued: identical data rows, different bytes.
   *
   * This is what §3.3's layer two exists for — "a re-issued statement, or a
   * date-ranged export you pull twice with different endpoints, contains rows
   * you already have in a file with a different hash." Renaming a file does not
   * produce it, because `file_sha256` is over the contents; only a real change
   * to the bytes gets past layer one, and a re-issue changes the preamble.
   */
  function reissue(name: string): Uint8Array {
    const text = new TextDecoder().decode(fixture(name));
    return new TextEncoder().encode(
      text.replace('Statement Period:', 'Statement Period (reissued 03/01/2026):')
    );
  }

  /** Upload real bytes as a browser would — multipart, one or more files. */
  async function upload(name: string, asFilename = name): Promise<UploadedImport[]> {
    return uploadBytes(fixture(name), asFilename);
  }

  async function uploadBytes(bytes: Uint8Array, filename: string): Promise<UploadedImport[]> {
    const form = new FormData();
    form.append('files', new File([bytes], filename, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const response = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });

    expect(response.statusCode).toBe(200);
    return (response.json() as { imports: UploadedImport[] }).imports;
  }

  /** §6.1: the guessed account "must be confirmed". PATCH is that confirmation. */
  async function confirmAccount(importId: string, accountId: string): Promise<void> {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/imports/${importId}`,
      payload: { accountId },
    });
    expect(response.statusCode).toBe(200);
  }

  async function commit(
    importId: string,
    body: Record<string, unknown> = {}
  ): Promise<{ statusCode: number; body: Record<string, number> }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/imports/${importId}/commit`,
      payload: body,
    });
    return { statusCode: response.statusCode, body: response.json() };
  }

  /** Upload, confirm the account, commit — the happy path in one call. */
  async function importFixture(
    name: string,
    accountId: string,
    options: { bytes?: Uint8Array; asFilename?: string; body?: Record<string, unknown> } = {}
  ) {
    const [staged] = options.bytes
      ? await uploadBytes(options.bytes, options.asFilename ?? name)
      : await upload(name, options.asFilename ?? name);
    if (!staged.created) return { staged, commit: null };
    await confirmAccount(staged.import.id, accountId);
    return { staged, commit: await commit(staged.import.id, options.body ?? {}) };
  }

  async function transactionCount(): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/transactions?includeInternalTransfers=true&includeExcluded=true&limit=1',
    });
    return (response.json() as { total: number }).total;
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
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  describe('boot', () => {
    it('loads every shipped profile without complaint', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      // The version is asserted rather than ignored: `/api/health` reports it so
      // a boot against a database the migrations did not reach is visible, and a
      // test that accepted any number would not notice one that never ran.
      expect(response.json()).toMatchObject({
        ok: true,
        schemaVersion: MIGRATIONS[MIGRATIONS.length - 1].version,
        profileLoadErrors: [],
      });
    });

    it('binds 127.0.0.1, not 0.0.0.0', () => {
      // Not a preference. This process holds every statement its owner has
      // imported and has no authentication of any kind (§2.1, apps/CLAUDE.md).
      expect(API_HOST).toBe('127.0.0.1');
    });
  });

  describe('a statement through the whole pipeline', () => {
    it('detects the profile, parses in house conventions, and commits', async () => {
      const { staged, commit: result } = await importFixture(
        'northgate-checking-2026-01.csv',
        checkingId
      );

      expect(staged.import.status).toBe('staged');
      expect(staged.import.formatProfileId).toBe('northgate-checking-v1');
      expect(staged.import.rowsParsed).toBe(12);
      // The filename carries the last4, which is the strongest of §6.1's guesses.
      expect(staged.accountSuggestion).toMatchObject({ accountId: checkingId });

      expect(result?.body).toMatchObject({ rowsInserted: 12, rowsDuplicate: 0 });

      const page = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${checkingId}&sort=date_asc&includeInternalTransfers=true`,
      });
      const rows = (page.json() as { rows: { transaction: Record<string, unknown> }[] }).rows;

      expect(rows).toHaveLength(12);
      // Negative = money leaving the account; the payroll credit is positive.
      expect(rows[0].transaction).toMatchObject({
        effectiveDate: '2026-01-03',
        amountCents: -1875,
        descriptionNormalized: 'BLUE BOTTLE COFFE',
      });
      expect(rows[3].transaction).toMatchObject({ amountCents: 320000 });
      // §2.5: pending rows are stored and shown, and excluded from every total.
      expect(rows[11].transaction).toMatchObject({ isPending: true, amountCents: -2340 });
      // Every row is keyed under the one frozen collapse.
      expect(new Set(rows.map((r) => r.transaction['dedupeKeyVersion']))).toEqual(
        new Set(['collapse_v1'])
      );
    });

    it('absorbs the credit card’s inverted sign convention', async () => {
      const { commit: result } = await importFixture('cardinal-card-2026-01.csv', cardId, {
        // The trial authorization parses to $0.00 and is not pending, so §3.2
        // refuses it unless the reviewer says it is a trial.
        body: { allowZeroAmountRows: true },
      });
      expect(result?.body).toMatchObject({ rowsInserted: 8 });

      const page = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${cardId}&sort=date_asc&includeInternalTransfers=true&includeExcluded=true`,
      });
      const rows = (page.json() as { rows: { transaction: Record<string, unknown> }[] }).rows;

      // A purchase printed as `15.49` is money leaving; a payment printed as
      // `-500.00` is money arriving. Equal and opposite to the checking side.
      expect(rows[0].transaction).toMatchObject({ amountCents: -1549 });
      const payment = rows.find((r) => r.transaction['amountCents'] === 50000);
      expect(payment).toBeDefined();
    });

    it('refuses a $0 row that nobody explained', async () => {
      const [staged] = await upload('cardinal-card-2026-01.csv');
      await confirmAccount(staged.import.id, cardId);

      const refused = await commit(staged.import.id);

      expect(refused.statusCode).toBe(422);
      expect(refused.body).toMatchObject({ error: 'zero_amount_rows' });
      expect(await transactionCount()).toBe(0);
    });

    it('refuses to commit before the guessed account is confirmed', async () => {
      const [staged] = await upload('northgate-checking-2026-01.csv');
      const refused = await commit(staged.import.id);

      expect(refused.statusCode).toBe(409);
      expect(refused.body).toMatchObject({ error: 'import_not_ready' });
      expect(await transactionCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // The three properties §3.3 is built to guarantee.
  // -----------------------------------------------------------------------

  describe('§3.3 — re-importing the same file inserts zero rows', () => {
    it('short-circuits a byte-identical re-upload (layer one)', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      const before = await transactionCount();

      const [again] = await upload('northgate-checking-2026-01.csv');

      expect(again.created).toBe(false);
      expect(again.import.status).toBe('committed');
      expect(await transactionCount()).toBe(before);

      const history = await app.inject({ method: 'GET', url: '/api/imports' });
      expect(history.json()).toHaveLength(1);
    });

    it('short-circuits a rename too — `file_sha256` is over the contents', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);

      const [renamed] = await upload('northgate-checking-2026-01.csv', 'january-copy.csv');

      expect(renamed.created).toBe(false);
      expect(await transactionCount()).toBe(12);
    });

    it('merges every row of a re-issued statement (layer two)', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);

      // Different bytes, same twelve transactions. Layer one cannot see this,
      // so the merge rule has to do the whole job.
      const reissued = await importFixture('northgate-checking-2026-01.csv', checkingId, {
        bytes: reissue('northgate-checking-2026-01.csv'),
        asFilename: 'northgate-4821-january-reissued.csv',
      });

      expect(reissued.staged.created).toBe(true);
      expect(reissued.commit?.body).toMatchObject({ rowsInserted: 0, rowsDuplicate: 12 });
      expect(await transactionCount()).toBe(12);
    });

    it('is idempotent on a re-POSTed commit', async () => {
      const { staged } = await importFixture('northgate-checking-2026-01.csv', checkingId);
      const again = await commit(staged.import.id);

      expect(again.body).toMatchObject({ alreadyCommitted: true });
      expect(await transactionCount()).toBe(12);
    });
  });

  describe('§3.3 — two overlapping exports converge to zero extra inserts', () => {
    it('inserts each transaction once across two exports of one month', async () => {
      // Part A covers 01/03–01/20 and part B covers 01/12–01/30. Four rows
      // appear in both, and the union is the twelve rows of the full month.
      const a = await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);
      expect(a.commit?.body).toMatchObject({ rowsInserted: 8, rowsDuplicate: 0 });

      const b = await importFixture('northgate-checking-2026-01-part-b.csv', checkingId);
      expect(b.commit?.body).toMatchObject({ rowsInserted: 4, rowsDuplicate: 4 });

      expect(await transactionCount()).toBe(12);
    });

    it('converges — the full month over the two halves inserts nothing', async () => {
      await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);
      await importFixture('northgate-checking-2026-01-part-b.csv', checkingId);

      const whole = await importFixture('northgate-checking-2026-01.csv', checkingId);

      expect(whole.commit?.body).toMatchObject({ rowsInserted: 0, rowsDuplicate: 12 });
      expect(await transactionCount()).toBe(12);
    });

    it('converges in the other order too', async () => {
      const whole = await importFixture('northgate-checking-2026-01.csv', checkingId);
      expect(whole.commit?.body).toMatchObject({ rowsInserted: 12 });

      const a = await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);
      const b = await importFixture('northgate-checking-2026-01-part-b.csv', checkingId);

      expect(a.commit?.body).toMatchObject({ rowsInserted: 0, rowsDuplicate: 8 });
      expect(b.commit?.body).toMatchObject({ rowsInserted: 0, rowsDuplicate: 8 });
      expect(await transactionCount()).toBe(12);
    });

    it('flags the overlap on the review screen before it is committed', async () => {
      await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);

      const [staged] = await upload('northgate-checking-2026-01-part-b.csv');
      await confirmAccount(staged.import.id, checkingId);

      const review = await app.inject({ method: 'GET', url: `/api/imports/${staged.import.id}` });
      const body = review.json() as {
        plan: { willInsert: number; alreadyPresent: number; nearDuplicates: unknown[] };
        rows: { disposition: string }[];
      };

      // "18 of 52 rows already present", in miniature — and still nothing
      // written: §2.5's review-before-commit.
      expect(body.plan).toMatchObject({ willInsert: 4, alreadyPresent: 4, nearDuplicates: [] });
      expect(body.rows.filter((row) => row.disposition === 'duplicate')).toHaveLength(4);
      expect(await transactionCount()).toBe(8);
    });
  });

  describe('§3.3 — two genuine identical charges both survive', () => {
    it('keeps both $4.75 coffees bought on one day', async () => {
      // The row the naive "skip anything whose key exists" rule loses. They are
      // one dedupe key and two real transactions, told apart by occurrence_index.
      const { commit: result } = await importFixture('northgate-checking-2026-02.csv', checkingId);
      expect(result?.body).toMatchObject({ rowsInserted: 4 });

      const page = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${checkingId}&q=BLUE BOTTLE&sort=date_asc`,
      });
      const rows = (page.json() as {
        rows: { transaction: { amountCents: number; dedupeKey: string; occurrenceIndex: number } }[];
      }).rows;

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.transaction.amountCents)).toEqual([-475, -475]);
      expect(rows[0].transaction.dedupeKey).toBe(rows[1].transaction.dedupeKey);
      expect(rows.map((r) => r.transaction.occurrenceIndex).sort()).toEqual([0, 1]);
    });

    it('still merges both of them on a re-import', async () => {
      await importFixture('northgate-checking-2026-02.csv', checkingId);

      const again = await importFixture('northgate-checking-2026-02.csv', checkingId, {
        bytes: reissue('northgate-checking-2026-02.csv'),
        asFilename: 'northgate-4821-february-reissued.csv',
      });

      expect(again.commit?.body).toMatchObject({ rowsInserted: 0, rowsDuplicate: 4 });
      expect(await transactionCount()).toBe(4);
    });
  });

  // -----------------------------------------------------------------------

  describe('import deletion', () => {
    it('keeps the rows the other overlapping import still covers', async () => {
      const a = await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);
      await importFixture('northgate-checking-2026-01-part-b.csv', checkingId);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/imports/${a.staged.import.id}`,
      });

      const body = deleted.json() as {
        deletedTransactionIds: string[];
        retainedTransactionIds: string[];
      };

      // Part A owns 01/03–01/09 alone; the four overlapping rows stay because
      // part B legitimately contains them.
      expect(body.deletedTransactionIds).toHaveLength(4);
      expect(body.retainedTransactionIds).toHaveLength(4);
      expect(await transactionCount()).toBe(8);
    });

    it('leaves the survivors with a verbatim line and a covering import', async () => {
      const a = await importFixture('northgate-checking-2026-01-part-a.csv', checkingId);
      const b = await importFixture('northgate-checking-2026-01-part-b.csv', checkingId);

      await app.inject({ method: 'DELETE', url: `/api/imports/${a.staged.import.id}` });

      const page = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${checkingId}&q=SPOTIFY`,
      });
      const [row] = (page.json() as { rows: { transaction: { id: string } }[] }).rows;

      const detail = await app.inject({ method: 'GET', url: `/api/transactions/${row.transaction.id}` });
      const body = detail.json() as {
        transaction: { rawRowId: string | null };
        coveringImports: { id: string }[];
      };

      expect(body.transaction.rawRowId).not.toBeNull();
      expect(body.coveringImports.map((i) => i.id)).toEqual([b.staged.import.id]);
    });
  });

  describe('export', () => {
    it('exports every row as CSV with integer cents alongside the rendered amount', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);

      const response = await app.inject({ method: 'POST', url: '/api/data/export?format=csv' });
      const lines = response.body.trim().split('\n');

      expect(response.headers['content-type']).toContain('text/csv');
      expect(lines[0]).toContain('amountCents');
      expect(lines).toHaveLength(13);
      expect(lines[1]).toContain('-1875');
      expect(lines[1]).toContain('-$18.75');
    });
  });
});

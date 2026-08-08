/**
 * The three calls §6.1's column mapper is built out of, and the review payload it
 * hands back to the page.
 *
 * The fixture here is a **deliberately unfamiliar format**: no shipped profile
 * matches it, so `POST /api/imports` stages it as `needs_mapping` and the mapper is
 * the only way through. That is the state the mapper exists for and the only state
 * these routes are reachable in, so testing them against a format the app already
 * knows would test nothing.
 *
 * It is also chosen to disagree with the house conventions in every way a real bank
 * does at once: `DD/MM/YYYY` dates, separate debit and credit columns, a semicolon
 * delimiter, two preamble lines, and outflows in the column a naive reading would
 * call `credit`. Getting all five right is the mapper's job.
 */

import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const workspaceRoot = new URL('../../../', import.meta.url);
const PROFILES_DIR = fileURLToPath(new URL('profiles', workspaceRoot));

/**
 * A statement in a format no shipped profile matches.
 *
 * Semicolon-delimited, `DD/MM/YYYY`, a two-line preamble, and debit/credit as
 * separate unsigned columns. `03/02/2026` is the 3rd of February — read as
 * `MM/DD/YYYY` it becomes the 2nd of March, which is the mistake the date-format
 * preview exists to make visible.
 */
const FOREIGN_CSV = [
  'Banco Meridiano — Extracto',
  'Cuenta: ****7788',
  '',
  'Fecha;Concepto;Cargo;Abono;Saldo',
  '03/02/2026;SUPERMERCADO LA PLAZA;45.20;;1954.80',
  '05/02/2026;NOMINA FEBRERO;;2100.00;4054.80',
  '11/02/2026;CAFE CENTRAL 0042;3.60;;4051.20',
  '18/02/2026;NETFLIX.COM;9.99;;4041.21',
].join('\n');

/** The same file with European decimal commas, which v1 refuses outright — see the
 *  test at the bottom. The mapper's degrees of freedom are columns, dates, delimiter
 *  and sign; number *formatting* is not one of them. */
const COMMA_DECIMAL_CSV = FOREIGN_CSV.replace(/(\d)\.(\d\d)(?=;|$)/gm, '$1,$2');

/**
 * The mapping a reviewer would build for the file above.
 *
 * No `delimiter` and no `skipLines`: detection already worked both out, the preview
 * reports them as `detectedDelimiter` / `detectedSkipLines`, and the mapper pre-fills
 * from those. A draft that restates them is a draft that can contradict the file —
 * which is exactly how the first version of this test failed.
 */
const GOOD_DRAFT = {
  institution: 'Banco Meridiano',
  accountTypeHint: 'checking' as const,
  hasHeader: true,
  dateFormat: 'DD/MM/YYYY',
  amountMode: 'debit_credit' as const,
  signConvention: 'as_is' as const,
  columnMap: {
    transactionDate: { by: 'header' as const, name: 'Fecha' },
    description: { by: 'header' as const, name: 'Concepto' },
    debit: { by: 'header' as const, name: 'Cargo' },
    credit: { by: 'header' as const, name: 'Abono' },
    balance: { by: 'header' as const, name: 'Saldo' },
  },
};

interface PreviewShape {
  ok: boolean;
  errors: string[];
  warnings: string[];
  rows: { effectiveDate: string; descriptionRaw: string; amountCents: number }[];
  failures: { rowIndex: number; errors: string[] }[];
  parseWarnings: { kind: string; message: string }[];
  balanceCheck: { kind: string; reason?: string; failureCount?: number };
  headerSignature: string;
  headerTokens: string[];
  detectedDelimiter: string;
  detectedSkipLines: number;
  sampleRows: { cells: string[] }[];
}

describe('the column mapper’s API (§6.1)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let importId: string;
  let accountId: string;

  async function upload(text: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append(
      'files',
      new File([new TextEncoder().encode(text)], filename, { type: 'text/csv' }),
    );
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const response = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { imports: { import: { id: string } }[] }).imports[0].import.id;
  }

  async function preview(draft: unknown): Promise<{ statusCode: number; body: PreviewShape }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/format-profiles/preview',
      payload: { importId, draft },
    });
    return { statusCode: response.statusCode, body: response.json() as PreviewShape };
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

    const account = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { displayName: 'Meridiano Checking', accountType: 'checking', last4: '7788' },
    });
    accountId = (account.json() as { id: string }).id;

    importId = await upload(FOREIGN_CSV, 'meridiano-2026-02.csv');
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  it('stages an unrecognized format as needs_mapping rather than guessing', async () => {
    const review = await app.inject({ method: 'GET', url: `/api/imports/${importId}` });
    const body = review.json() as {
      import: { status: string; formatProfileId: string | null; errorDetail: string | null };
      plan: unknown;
      balanceCheck: { kind: string; reason: string };
    };

    expect(body.import.status).toBe('needs_mapping');
    expect(body.import.formatProfileId).toBeNull();
    expect(body.import.errorDetail).toContain('no format profile matches');
    // §6.1: nothing enters the database until Commit, and there is no plan to
    // compute before an account is confirmed.
    expect(body.plan).toBeNull();
    // A file that was never parsed has an `unavailable` verdict, not a missing one.
    expect(body.balanceCheck.kind).toBe('unavailable');
  });

  describe('GET /api/format-profiles', () => {
    it('lists the shipped profiles so a near-miss can be copied', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/format-profiles' });
      const profiles = response.json() as { id: string; source: string; columnMap: unknown }[];

      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles.every((p) => p.source === 'seed')).toBe(true);
      // The column map arrives structured, not as a JSON string — the mapper has to
      // pre-fill its dropdowns from it.
      expect(profiles[0].columnMap).toBeTypeOf('object');
    });
  });

  describe('POST /api/format-profiles/preview', () => {
    it('parses the file under a good draft and writes nothing', async () => {
      const { body } = await preview(GOOD_DRAFT);

      expect(body.ok).toBe(true);
      expect(body.errors).toEqual([]);
      expect(body.rows).toHaveLength(4);

      // DD/MM/YYYY read correctly: the 3rd of February, not the 2nd of March.
      expect(body.rows[0].effectiveDate).toBe('2026-02-03');
      expect(body.rows[0].descriptionRaw).toBe('SUPERMERCADO LA PLAZA');
      // Debit column → money leaving → negative, in integer cents.
      expect(body.rows[0].amountCents).toBe(-4520);
      // Credit column → money arriving → positive.
      expect(body.rows[1].amountCents).toBe(210000);

      // Nothing was saved and the import is untouched.
      expect(context.store.formatProfiles.list().every((p) => p.source === 'seed')).toBe(true);
      expect(context.store.imports.getOrThrow(importId).status).toBe('needs_mapping');
      expect(context.store.transactions.countAll()).toBe(0);
    });

    it('reconciles the running balance, which is what says the mapping is right', async () => {
      const { body } = await preview(GOOD_DRAFT);

      // §6.1 calls this the strongest signal available at parse time: it proves the
      // amount column really is the amount column and no row was dropped.
      expect(body.balanceCheck.kind).toBe('reconciled');
    });

    it('shows the date read the wrong way round rather than refusing it', async () => {
      const { body } = await preview({ ...GOOD_DRAFT, dateFormat: 'MM/DD/YYYY' });

      // Both formats are syntactically valid, so this is not an error — it is a
      // wrong answer the reviewer has to be able to *see*. 03/02 becomes 2 March.
      expect(body.ok).toBe(true);
      expect(body.rows[0].effectiveDate).toBe('2026-03-02');
    });

    it('catches the swapped debit and credit columns through the balance check', async () => {
      const { body } = await preview({
        ...GOOD_DRAFT,
        columnMap: {
          ...GOOD_DRAFT.columnMap,
          debit: { by: 'header' as const, name: 'Abono' },
          credit: { by: 'header' as const, name: 'Cargo' },
        },
      });

      // Every row's sign is now backwards, so no ordering reconciles.
      expect(body.balanceCheck.kind).toBe('mismatch');
      expect(body.balanceCheck.failureCount).toBeGreaterThan(0);
    });

    it('refuses a draft with no amount column, with reasons and no rows', async () => {
      const { columnMap, ...rest } = GOOD_DRAFT;
      const { body } = await preview({
        ...rest,
        amountMode: 'single',
        columnMap: {
          transactionDate: columnMap.transactionDate,
          description: columnMap.description,
        },
      });

      expect(body.ok).toBe(false);
      expect(body.errors.join(' ')).toContain('amount');
      // A partial preview beside a list of errors reads as a partial success.
      expect(body.rows).toEqual([]);
      expect(body.balanceCheck.kind).toBe('unavailable');
    });

    it('refuses a draft with no date column, naming the rule', async () => {
      const { columnMap, ...rest } = GOOD_DRAFT;
      const { body } = await preview({
        ...rest,
        columnMap: {
          description: columnMap.description,
          debit: columnMap.debit,
          credit: columnMap.credit,
        },
      });

      expect(body.ok).toBe(false);
      // §7.1: effective_date is COALESCE(transaction_date, posted_date) and cannot
      // be null, so one of the two is required.
      expect(body.errors.join(' ')).toMatch(/transactionDate|postedDate/);
    });

    it('warns about a missing balance column without refusing it', async () => {
      const { balance: _dropped, ...withoutBalance } = GOOD_DRAFT.columnMap;
      const { body } = await preview({ ...GOOD_DRAFT, columnMap: withoutBalance });

      expect(body.ok).toBe(true);
      expect(body.warnings.join(' ')).toContain('balance');
      // No balances to compare, so the check cannot run — and says so.
      expect(body.balanceCheck.kind).toBe('unavailable');
    });

    it('returns the signature the profile would be saved under', async () => {
      const { body } = await preview(GOOD_DRAFT);

      expect(body.headerSignature).toMatch(/^[0-9a-f]{8,}$/);
      expect(body.headerTokens).toEqual(['fecha', 'concepto', 'cargo', 'abono', 'saldo']);
    });

    it('reports the delimiter, preamble and sample rows so the mapper pre-fills', async () => {
      const { body } = await preview(GOOD_DRAFT);

      // Nobody should have to count preamble lines by eye, or notice that this file
      // is semicolon-delimited.
      expect(body.detectedDelimiter).toBe(';');
      expect(body.detectedSkipLines).toBe(2);
      expect(body.sampleRows[0].cells).toEqual([
        '03/02/2026',
        'SUPERMERCADO LA PLAZA',
        '45.20',
        '',
        '1954.80',
      ]);
    });

    it('does not let a schema default override what detection found', async () => {
      // The draft omits `delimiter` and `skipLines`. Before the defaults came off
      // `FormatProfileDraft`, Fastify filled them with `,` and `0` — which pointed the
      // mapping at the file's title row and produced an error blaming the column
      // names. An omitted field has to stay omitted for the fallback to see it.
      const { body } = await preview(GOOD_DRAFT);

      expect(body.ok).toBe(true);
      expect(body.detectedDelimiter).toBe(';');
      expect(body.detectedSkipLines).toBe(2);
    });

    it('reports a mapping that names columns the file lacks, rather than throwing', async () => {
      const { statusCode, body } = await preview({
        ...GOOD_DRAFT,
        columnMap: {
          ...GOOD_DRAFT.columnMap,
          description: { by: 'header' as const, name: 'Descripcion' },
        },
      });

      // The most likely state while a mapping is being built, so it is an outcome
      // and not a 500 — and the parser's message already says both what was asked
      // for and what the file has.
      expect(statusCode).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.errors.join(' ')).toContain('Descripcion');
      expect(body.errors.join(' ')).toContain('Columns present in the file');
      // The grid stays populated so the reviewer can fix it in place.
      expect(body.sampleRows.length).toBeGreaterThan(0);
      expect(body.headerTokens).toContain('concepto');
    });

    it('404s an unknown import', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/format-profiles/preview',
        payload: { importId: 'nope', draft: GOOD_DRAFT },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses a European decimal comma per row rather than misreading it', async () => {
      // §3.1 is explicit that `1.234,56` and `1,234` mean different things in
      // different locales and that reading the second as $1,234.00 is a 1000x error
      // no downstream check would catch — so the parse fails loudly per row. v1 is
      // single-currency USD (§3.2) and no column mapping can change that; a
      // European export is a v1 limitation, not a mapping problem, and the mapper
      // should say so rather than appear broken.
      const commaImport = await upload(COMMA_DECIMAL_CSV, 'meridiano-comma.csv');
      const response = await app.inject({
        method: 'POST',
        url: '/api/format-profiles/preview',
        payload: { importId: commaImport, draft: GOOD_DRAFT },
      });
      const body = response.json() as PreviewShape;

      // The mapping itself is fine, so this is not a mapping error — it is every row
      // failing, which is what the failures list is for.
      expect(body.ok).toBe(true);
      expect(body.rows).toEqual([]);
      expect(body.failures).toHaveLength(4);
      expect(body.failures[0].errors.join(' ')).toMatch(/unambiguous USD amount/);
    });
  });

  describe('POST /api/format-profiles', () => {
    async function save(draft: unknown) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/format-profiles',
        payload: { importId, draft },
      });
      return { statusCode: response.statusCode, body: response.json() };
    }

    it('saves a valid draft keyed on the file’s own header signature', async () => {
      const { statusCode, body } = await save(GOOD_DRAFT);
      const profile = body as {
        id: string;
        headerSignature: string;
        source: string;
        version: number;
      };

      expect(statusCode).toBe(201);
      expect(profile.source).toBe('user');
      expect(profile.version).toBe(1);
      expect(profile.id).toContain('banco-meridiano');

      const preview = await app.inject({
        method: 'POST',
        url: '/api/format-profiles/preview',
        payload: { importId, draft: GOOD_DRAFT },
      });
      // The signature is the file's, not the request's.
      expect(profile.headerSignature).toBe((preview.json() as PreviewShape).headerSignature);
    });

    it('refuses to store a mapping that names columns the file lacks', async () => {
      const { statusCode, body } = await save({
        ...GOOD_DRAFT,
        columnMap: { ...GOOD_DRAFT.columnMap, debit: { by: 'header' as const, name: 'Debito' } },
      });

      // Validates in isolation, does not fit the file. Storing it would be the trap:
      // `detect` matches on signature, so every future statement from this bank
      // would fail against it instead of reaching the mapper.
      expect(statusCode).toBe(422);
      expect(body).toMatchObject({ error: 'invalid_profile' });
      expect((body as { message: string }).message).toContain('Debito');
      expect(context.store.formatProfiles.list().every((p) => p.source === 'seed')).toBe(true);
    });

    it('refuses to store a profile that cannot parse', async () => {
      const { columnMap: _dropped, ...rest } = GOOD_DRAFT;
      const { statusCode, body } = await save({ ...rest, columnMap: {} });

      // A stored profile that cannot parse is worse than none: `detect` would match
      // it on signature and every future statement would fail against it instead of
      // reaching the mapper.
      expect(statusCode).toBe(422);
      expect(body).toMatchObject({ error: 'invalid_profile' });
      expect(context.store.formatProfiles.list().every((p) => p.source === 'seed')).toBe(true);
    });

    it('updates in place and bumps the version on a re-save', async () => {
      const first = (await save(GOOD_DRAFT)).body as { id: string; version: number };
      const second = (await save({ ...GOOD_DRAFT, institution: 'Banco Meridiano SA' })).body as {
        id: string;
        version: number;
        institution: string;
      };

      // `header_signature` is UNIQUE (§3.1), so one signature is one profile.
      expect(second.id).toBe(first.id);
      expect(second.version).toBe(first.version + 1);
      expect(second.institution).toBe('Banco Meridiano SA');
      expect(context.store.formatProfiles.list().filter((p) => p.source === 'user')).toHaveLength(
        1,
      );
    });

    it('makes the import parseable, and the next file of that format import without asking', async () => {
      const profile = (await save(GOOD_DRAFT)).body as { id: string };

      // §6.1's re-parse path, which the save deliberately does not do itself.
      const reparsed = await app.inject({
        method: 'PATCH',
        url: `/api/imports/${importId}`,
        payload: { accountId, formatProfileId: profile.id },
      });
      const review = reparsed.json() as {
        import: { status: string; rowsParsed: number };
        rows: { disposition: string; row: { amountCents: number } }[];
        plan: { willInsert: number };
      };

      expect(review.import.status).toBe('staged');
      expect(review.import.rowsParsed).toBe(4);
      expect(review.plan.willInsert).toBe(4);
      expect(review.rows[0].row.amountCents).toBe(-4520);

      const committed = await app.inject({
        method: 'POST',
        url: `/api/imports/${importId}/commit`,
        payload: {},
      });
      expect(committed.json()).toMatchObject({ rowsInserted: 4 });

      // The payoff §6.1 promises: a different file in the same format now detects.
      const second = await upload(
        FOREIGN_CSV.replace('Extracto', 'Extracto (marzo)').replace(/02\/2026/g, '03/2026'),
        'meridiano-2026-03.csv',
      );
      const secondReview = await app.inject({ method: 'GET', url: `/api/imports/${second}` });
      const secondBody = secondReview.json() as {
        import: { status: string; formatProfileId: string | null };
      };

      expect(secondBody.import.status).toBe('staged');
      expect(secondBody.import.formatProfileId).toBe(profile.id);
    });
  });
});

/**
 * §6.6's five views, and §7.2's coverage rule which is the thing that makes them
 * honest.
 *
 * "Any analyzer that computes a per-month aggregate — §5.10, §5.11, the Insights page
 * — restricts itself to months covered for **every** account in scope, and reports
 * the window it used." §6.6 adds the display half: "Months that are not fully covered
 * are rendered hatched rather than omitted, so a gap reads as a gap and not as a drop
 * in spending."
 *
 * Those two sentences pull in opposite directions — exclude from the totals, include
 * in the output — and most of what is asserted below is that both happen at once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
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

/**
 * A statement whose declared period is stated explicitly.
 *
 * §7.2's coverage is read from `statement_import.period_start/end`, not from the rows
 * — "a **single** committed import spans the whole month" — so a fixture that wants
 * an uncovered month has to say so in the header rather than by omitting rows.
 */
function statementCsv(
  rows: readonly StatementRow[],
  period: { from: string; to: string },
  openingCents = 500_000,
): string {
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
    `Statement Period: ${usDate(period.from)} - ${usDate(period.to)}`,
    '',
    'Date,Description,Amount,Running Balance,Status',
    ...lines,
  ].join('\n');
}

interface CategoryInsightShape {
  months: { month: string; covered: boolean; totalCents: number; slices: unknown[] }[];
  categories: string[];
  window: { from: string; to: string; coveredMonths: number; uncoveredMonths: string[] };
}

describe('ledgerline-api insights (§6.6, §7.2)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;

  async function importStatement(
    name: string,
    rows: readonly StatementRow[],
    period: { from: string; to: string },
  ): Promise<void> {
    const form = new FormData();
    form.append('files', new File([statementCsv(rows, period)], name, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    expect(uploaded.statusCode).toBe(200);

    const [staged] = (uploaded.json() as { imports: { import: { id: string } }[] }).imports;
    await app.inject({ method: 'PATCH', url: `/api/imports/${staged.import.id}`, payload: { accountId } });
    const committed = await app.inject({
      method: 'POST',
      url: `/api/imports/${staged.import.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode).toBe(200);
  }

  const get = async <T>(url: string): Promise<T> =>
    (await app.inject({ method: 'GET', url })).json() as T;

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

    // January and March are covered end to end. February is imported as a *partial*
    // statement — rows exist, but no import spans the month — which is exactly the
    // shape §6.6's hatching exists for.
    await importStatement(
      'jan.csv',
      [
        { date: '2026-01-06', description: 'SAFEWAY #1234', amountCents: -8000 },
        { date: '2026-01-14', description: 'SHELL OIL 574411', amountCents: -4200 },
        { date: '2026-01-20', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
      ],
      { from: '2026-01-01', to: '2026-01-31' },
    );

    // Three rows, not one: the delimiter sniffer establishes a column count by
    // consistency across rows, and a preamble plus a single line gives it nothing
    // to be consistent with. The *period* is what makes this month uncovered.
    await importStatement(
      'feb-partial.csv',
      [
        { date: '2026-02-08', description: 'SAFEWAY #1234', amountCents: -3000 },
        { date: '2026-02-12', description: 'SHELL OIL 574411', amountCents: -4500 },
        { date: '2026-02-16', description: 'SAFEWAY #1234', amountCents: -2200 },
      ],
      { from: '2026-02-05', to: '2026-02-18' },
    );

    await importStatement(
      'mar.csv',
      [
        { date: '2026-03-06', description: 'SAFEWAY #1234', amountCents: -12000 },
        { date: '2026-03-14', description: 'SHELL OIL 574411', amountCents: -4600 },
        { date: '2026-03-20', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
      ],
      { from: '2026-03-01', to: '2026-03-31' },
    );
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------------ categories ---

  describe('GET /api/insights/categories', () => {
    it('returns every month in the span, including the uncovered one (§6.6)', async () => {
      const body = await get<CategoryInsightShape>('/api/insights/categories');

      // Omitting February would make the chart read as two months side by side, with
      // nothing to say a third exists.
      expect(body.months.map((month) => month.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    });

    it('marks the partial month uncovered, which is what the page hatches', async () => {
      const body = await get<CategoryInsightShape>('/api/insights/categories');
      const byMonth = new Map(body.months.map((month) => [month.month, month]));

      expect(byMonth.get('2026-01')?.covered).toBe(true);
      // §7.2, unweakened: "a **single** committed import spans the whole month".
      // Feb's statement runs the 5th to the 18th, so the month is not proven.
      expect(byMonth.get('2026-02')?.covered).toBe(false);
      expect(byMonth.get('2026-03')?.covered).toBe(true);
    });

    it('still reports the uncovered month’s rows, so the gap is legible', async () => {
      const body = await get<CategoryInsightShape>('/api/insights/categories');
      const february = body.months.find((month) => month.month === '2026-02');

      // The February charge exists and is returned. What `covered: false` says is
      // that the *month* is not proven — not that nothing happened in it.
      expect(february?.totalCents).not.toBe(0);
    });

    it('reports the window it used (§7.2)', async () => {
      const body = await get<CategoryInsightShape>('/api/insights/categories');

      expect(body.window.coveredMonths).toBe(2);
      expect(body.window.uncoveredMonths).toEqual(['2026-02']);
    });

    it('narrows to the requested range', async () => {
      const body = await get<CategoryInsightShape>(
        '/api/insights/categories?from=2026-03-01&to=2026-03-31',
      );

      expect(body.months.map((month) => month.month)).toEqual(['2026-03']);
      expect(body.window.uncoveredMonths).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- movers ---

  describe('GET /api/insights/movers', () => {
    it('compares the last two covered months, skipping the partial one', async () => {
      const body = await get<{ fromMonth: string; toMonth: string }>('/api/insights/movers');

      // January to March, not February to March. Comparing a complete month against
      // a half-imported one produces a table of large falls that are all the same
      // artefact — §7.2's whole reason for existing.
      expect(body.fromMonth).toBe('2026-01');
      expect(body.toMonth).toBe('2026-03');
    });

    it('puts a genuine rise on the risers side', async () => {
      const body = await get<{ risers: { category: string; deltaCents: number }[] }>(
        '/api/insights/movers',
      );

      // Groceries went $80 → $120 between the two covered months.
      expect(body.risers.length).toBeGreaterThan(0);
      expect(body.risers[0].deltaCents).toBeGreaterThan(0);
    });

    it('refuses to compare when there are fewer than two covered months', async () => {
      const body = await get<{ fromMonth: string | null; risers: unknown[] }>(
        '/api/insights/movers?from=2026-02-01&to=2026-02-28',
      );

      // An empty table rather than a comparison against a month that is not there.
      expect(body.fromMonth).toBeNull();
      expect(body.risers).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ fees ---

  it('rolls fees up per account, from the taxonomy rather than from §5.8', async () => {
    await importStatement(
      'fees.csv',
      [
        { date: '2026-04-06', description: 'MONTHLY MAINTENANCE FEE', amountCents: -1200 },
        { date: '2026-04-11', description: 'SAFEWAY #1234', amountCents: -5500 },
        { date: '2026-04-19', description: 'SHELL OIL 574411', amountCents: -3900 },
      ],
      { from: '2026-04-01', to: '2026-04-30' },
    );

    const body = await get<{ accounts: { displayName: string; totalCents: number }[]; totalCents: number }>(
      '/api/insights/fees',
    );

    // No analysis has run, so §5.8 has produced nothing. The rollup is still
    // populated — it is a sum, not a judgement, and it must not go blank because
    // every individual fee fell below §5.1's floor.
    expect(body.accounts.length).toBeGreaterThan(0);
    expect(body.accounts[0].displayName).toBe('Northgate Checking');
    expect(Math.abs(body.totalCents)).toBeGreaterThan(0);
  });

  // ------------------------------------------------- the two rule-backed views ---

  describe('the views that read a rule’s answer rather than re-deriving it', () => {
    it('says an analysis has not run, rather than reporting none', async () => {
      const outliers = await get<{ rows: unknown[]; unavailableReason: string | null }>(
        '/api/insights/outliers',
      );

      // "There are no outliers" and "nothing has looked yet" are very different
      // statements about an empty list, and only one of them is true here.
      expect(outliers.rows).toEqual([]);
      expect(outliers.unavailableReason).toContain('No analysis has finished');
    });

    it('reports rows once a run has completed', async () => {
      await app.inject({ method: 'POST', url: '/api/analysis/run' });
      await context.jobRunner.drain();

      const smallSpend = await get<{ unavailableReason: string | null }>(
        '/api/insights/small-spend',
      );

      // Whether §5.11 found anything in three months of fixtures is its business —
      // what matters here is that the excuse is gone.
      expect(smallSpend.unavailableReason).toBeNull();
    });
  });
});

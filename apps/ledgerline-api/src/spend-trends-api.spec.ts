/**
 * §5.10's `trend.v1` and §5.11's `micro.v1`, actually emitting.
 *
 * Both rules shipped correct and silent, and §9g said why in full: they restrict
 * themselves to §7.2's fully-covered months, and almost nothing qualified while
 * `period_start`/`period_end` came from row dates rather than a declared statement
 * period; §5.10 additionally needs a `category_id`, and nothing assigned one. §9h
 * closed both gaps. This file is what stops them re-opening — it is the only test
 * in the suite that would go quiet again if either did, because the rules
 * themselves return an empty emission rather than failing when their gates are
 * shut.
 *
 * ## Everything goes through `POST /api/imports`
 *
 * §9e's rule, and the two halves of this fix are exactly why it exists. Coverage
 * is read off `statement_import.period_start/end` (§7.2), so a test that inserted
 * transactions directly would prove nothing about the parser change. And the
 * `merchant_id` the categorizer reads its default off comes from §4's chain, so
 * `STARBUCKS STORE #4821 PORTLAND OR` has to actually resolve to `starbucks` the
 * way a statement does — a hand-set merchant id would test the assertion instead
 * of the code.
 *
 * One statement per calendar month, each declaring the whole month in its
 * preamble, which is what an ordinary bank export looks like and what §9h taught
 * the parser to read.
 */

import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const PROFILES_DIR = fileURLToPath(new URL('profiles', new URL('../../../', import.meta.url)));

interface StatementRow {
  readonly date: string;
  readonly description: string;
  readonly amountCents: number;
}

interface FindingShape {
  id: string;
  ruleId: string;
  subjectType: string;
  subjectId: string;
  title: string;
  detail: Record<string, unknown>;
  impactKind: string;
  impactAnnualCents: number;
  impactMonthlyCents: number;
}

interface CoverageShape {
  months: { month: string; state: string; covered: boolean }[];
  partialMonths: string[];
  gapMonths: string[];
}

// --------------------------------------------------------- the descriptors ---
// Real statement spellings, so §4's chain does the grouping. Each resolves to a
// seed merchant, and each seed merchant carries the default category §9h added.

const COFFEE = 'STARBUCKS STORE #4821 PORTLAND OR';   // → starbucks → dining
const GROCERIES = 'COSTCO WHSE #0612 PORTLAND OR';    // → costco    → groceries
const SHOPPING = 'TARGET T-2231 PORTLAND OR';         // → target    → shopping
const NETFLIX = 'NETFLIX.COM 866-579-7172 CA';        // → netflix   → entertainment

const usDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money = (cents: number): string => (cents / 100).toFixed(2);

/** Days in a calendar month, so the declared period ends on the real last day —
 *  §7.2's spanning test compares against it exactly. */
const lastDayOf = (year: number, month: number): number => new Date(year, month, 0).getDate();

const iso = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe('§5.10 and §5.11 over a multi-year corpus (§7.2, §9h)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;

  /**
   * One month's statement, in the shape `profiles/northgate-checking.json` is
   * keyed on: three preamble lines, a blank, then the header the signature
   * hashes. The third preamble line is the one this whole file is about.
   *
   * The running balance is computed rather than faked, because §6.1's
   * reconciliation would otherwise put a warning on every row.
   */
  function northgateMonth(year: number, month: number, rows: readonly StatementRow[]): string {
    let balance = 5_000_00;
    return [
      'Northgate Bank',
      'Account: *****4821',
      `Statement Period: ${usDate(iso(year, month, 1))} - ${usDate(
        iso(year, month, lastDayOf(year, month)),
      )}`,
      '',
      'Date,Description,Amount,Running Balance,Status',
      ...[...rows]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((row) => {
          balance += row.amountCents;
          return [
            usDate(row.date),
            row.description,
            money(row.amountCents),
            money(balance),
            'Posted',
          ].join(',');
        }),
    ].join('\n');
  }

  async function importMonth(year: number, month: number, rows: readonly StatementRow[]) {
    const form = new FormData();
    form.append(
      'files',
      new File([northgateMonth(year, month, rows)], `northgate-${year}-${month}.csv`, {
        type: 'text/csv',
      }),
    );
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    expect(uploaded.statusCode).toBe(200);

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

  async function analyze(): Promise<void> {
    const response = await app.inject({ method: 'POST', url: '/api/analysis/run' });
    expect(response.statusCode).toBe(202);
    context.jobRunner.drain();
  }

  async function findings(): Promise<FindingShape[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/findings?visibility=all&statuses=active,resolved,suppressed&limit=500',
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { rows: FindingShape[] }).rows;
  }

  const forRule = async (ruleId: string): Promise<FindingShape[]> =>
    (await findings()).filter((finding) => finding.ruleId === ruleId);

  /**
   * Eighteen months, January 2025 through June 2026.
   *
   * - **Coffee** — 10 charges a month between $5.75 and $7.25. §5.11's two tests
   *   exactly: often (≥8/mo) and small (median ≤$15).
   * - **Groceries** — three Costco runs a month totalling $190, climbing $18 a
   *   month. A single maximal run, which §9g made the unit so that one long climb
   *   is one finding rather than fifteen overlapping windows.
   * - **Shopping** — two Target trips a month totalling $120, with one $520 month
   *   in November 2025. §5.10's spike: excess over the trailing three-month
   *   average, by both >40% and >$75.
   * - **Netflix** — a monthly subscription, so `entertainment` is >80% one
   *   recurring series and §5.10 declines to trend it. §5.2 and §5.5 tell that
   *   story better, and telling it twice is the false-positive volume §5.1 names
   *   as what gets a tool like this abandoned.
   *
   * **The grocery and shopping trips wander on purpose.** Both the day of the
   * month and the split between trips move with the month index, because a fixed
   * amount on a fixed day *is* a recurring series — `recurrence.v1` fits it, and
   * §5.10 then excludes the category as series-dominated and says nothing. The
   * exclusion is right; a category that is one subscription is §5.5's story. What
   * this corpus needs is the other thing: ordinary variable household spend, which
   * is what a trend is supposed to be about.
   */
  function monthRows(year: number, month: number): StatementRow[] {
    const index = (year - 2025) * 12 + (month - 1);
    const shift = index % 3;
    const rows: StatementRow[] = [];

    for (let n = 0; n < 10; n += 1) {
      rows.push({
        date: iso(year, month, 2 + n * 2),
        description: COFFEE,
        // A spread rather than a constant, so the median is a median of
        // something and not an artefact of every row being identical.
        amountCents: -(575 + (n % 4) * 50),
      });
    }

    // Split so the parts sum to the month's total exactly — the climb is asserted
    // to the cent, and a rounding remainder would make it approximate.
    const split = (total: number, first: number, second: number): number[] => {
      const a = Math.round(total * first);
      const b = Math.round(total * second);
      return [a, b, total - a - b];
    };

    const groceryTotal = 19_000 + index * 1_800;
    const groceries = split(groceryTotal, 0.28 + shift * 0.06, 0.42 - shift * 0.05);
    [4 + shift, 15 - shift, 25 + shift].forEach((day, part) => {
      rows.push({
        date: iso(year, month, day),
        description: GROCERIES,
        amountCents: -groceries[part],
      });
    });

    const shoppingTotal = year === 2025 && month === 11 ? 52_000 : 12_000;
    const first = Math.round(shoppingTotal * (0.4 + (index % 5) * 0.08));
    rows.push({
      date: iso(year, month, 3 + shift),
      description: SHOPPING,
      amountCents: -first,
    });
    rows.push({
      date: iso(year, month, 19 - shift * 2),
      description: SHOPPING,
      amountCents: -(shoppingTotal - first),
    });

    rows.push({ date: iso(year, month, 5), description: NETFLIX, amountCents: -1549 });

    return rows;
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
      payload: {
        displayName: 'Northgate Checking',
        institution: 'Northgate Bank',
        accountType: 'checking',
        last4: '4821',
      },
    });
    accountId = (account.json() as { id: string }).id;

    for (let index = 0; index < 18; index += 1) {
      const year = 2025 + Math.floor(index / 12);
      const month = (index % 12) + 1;
      await importMonth(year, month, monthRows(year, month));
    }

    await analyze();
  }, 60_000);

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------------- the gates ---

  it('covers every month, because every statement declares one (§7.2, §9h)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}/coverage`,
    });
    const bar = response.json() as CoverageShape;

    expect(bar.months).toHaveLength(18);
    expect(bar.months.every((month) => month.state === 'covered' && month.covered)).toBe(true);
    expect(bar.partialMonths).toEqual([]);
    expect(bar.gapMonths).toEqual([]);
  });

  it('categorizes by rule at import, from the merchant’s own default (§2.5, §9h)', async () => {
    const page = await app.inject({
      method: 'GET',
      url: '/api/transactions?limit=1000&categoryIds=dining,groceries,shopping',
    });
    const rows = (page.json() as {
      rows: { transaction: { categoryId: string | null; categorySource: string | null } }[];
    }).rows;

    // 18 months × (10 coffees + 3 grocery runs + 2 shopping trips).
    expect(rows).toHaveLength(18 * 15);
    expect(rows.every((row) => row.transaction.categorySource === 'rule')).toBe(true);
  });

  // --------------------------------------------------------------- §5.11 ---

  it('emits micro.v1 for the coffee habit, as the annualized arithmetic (§5.11)', async () => {
    const micro = await forRule('micro.v1');
    const coffee = micro.find((finding) => finding.subjectId === 'starbucks');

    expect(coffee).toBeDefined();
    expect(coffee?.subjectType).toBe('merchant');
    expect(coffee?.detail.perMonth).toBe(10);
    expect(coffee?.detail.transactionCount).toBe(180);
    // §5.11 pins this: "adding it to a 'savings' headline that also counts the
    // same transactions in a category trend would make the headline fiction."
    expect(coffee?.impactKind).toBe('visibility');
    expect(coffee?.impactAnnualCents).toBe((coffee?.impactMonthlyCents ?? 0) * 12);
    // The whole finding is the sentence: count, size, and the number nobody has
    // seen before.
    expect(coffee?.title).toMatch(/^Starbucks: 10 charges\/mo, \$[\d,]+\/yr$/);
  });

  it('does not restate the coffee merchant as a dining category (§5.11, §9g)', async () => {
    const micro = await forRule('micro.v1');
    // `dining` is Starbucks wearing a different hat here, and §9g suppresses it
    // at the same 80% dominance §5.10 uses.
    expect(micro.some((finding) => finding.subjectId === 'dining')).toBe(false);
  });

  // --------------------------------------------------------------- §5.10 ---

  it('emits trend.v1 for a sustained climb, measured end to end (§5.10, §9g)', async () => {
    const climbs = (await forRule('trend.v1')).filter(
      (finding) => finding.detail.kind === 'climb',
    );
    const groceries = climbs.find((finding) => finding.detail.categoryId === 'groceries');

    expect(groceries).toBeDefined();
    // One run, not one per three-month window: §9g made the maximal run the unit
    // precisely so a seventeen-month rise is one card rather than fifteen.
    expect(climbs.filter((f) => f.detail.categoryId === 'groceries')).toHaveLength(1);
    expect(groceries?.detail.fromMonth).toBe('2025-01');
    expect(groceries?.detail.toMonth).toBe('2026-06');
    expect(groceries?.detail.riseCents).toBe(17 * 1_800);
    // A climb is a level, so ×12 is a real forward figure.
    expect(groceries?.impactMonthlyCents).toBe(17 * 1_800);
    expect(groceries?.impactKind).toBe('visibility');
  });

  it('emits trend.v1 for a one-month spike, priced as the excess (§5.10)', async () => {
    const spikes = (await forRule('trend.v1')).filter(
      (finding) => finding.detail.kind === 'spike',
    );
    const shopping = spikes.find((finding) => finding.detail.categoryId === 'shopping');

    expect(shopping).toBeDefined();
    expect(shopping?.detail.month).toBe('2025-11');
    expect(shopping?.detail.excessCents).toBe(52_000 - 12_000);
    // A spike happened once, so its monthly rate is zero — annualizing it would
    // claim November repeats every month.
    expect(shopping?.impactMonthlyCents).toBe(0);
    expect(shopping?.impactAnnualCents).toBe(52_000 - 12_000);
  });

  it('leaves a category that is one recurring series to §5.2 and §5.5 (§5.10)', async () => {
    const trend = await forRule('trend.v1');
    expect(trend.some((finding) => finding.detail.categoryId === 'entertainment')).toBe(false);
  });

  // ---------------------------------------------------------------- §7.3 ---

  /**
   * The invariant two new `visibility` emitters could have broken, checked with
   * both of them firing rather than in the abstract.
   */
  it('keeps the headline to exactly the savings findings (§7.3)', async () => {
    const all = await findings();
    const summary = (
      await app.inject({ method: 'GET', url: '/api/findings/summary' })
    ).json() as { savingsAnnualCents: number };

    const savings = all.filter((finding) => finding.impactKind === 'savings');
    expect(summary.savingsAnnualCents).toBe(
      savings.reduce((sum, finding) => sum + finding.impactAnnualCents, 0),
    );

    // And the two rules this file is about are outside it, by name.
    expect(
      all
        .filter((finding) => finding.ruleId === 'micro.v1' || finding.ruleId === 'trend.v1')
        .every((finding) => finding.impactKind === 'visibility'),
    ).toBe(true);
    expect(savings.some((finding) => finding.ruleId === 'micro.v1')).toBe(false);
    expect(savings.some((finding) => finding.ruleId === 'trend.v1')).toBe(false);
  });
});

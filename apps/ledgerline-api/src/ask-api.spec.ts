/**
 * §6.7's Ask, and the three claims that section makes which are only claims until
 * something checks them.
 *
 * "This buys no hallucinated numbers, no arbitrary database access from generated
 * SQL, and data minimization." Each of those is a test below, and each would pass
 * vacuously against a feature that did nothing — so each is paired with a case
 * proving the working path still works.
 *
 * As in `llm-api.spec.ts`, no case here starts a real provider: everything goes
 * through `llmProviderFactory`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { NoneProvider } from '@metrum/ledgerline-llm';
import type { CompleteRequest, JsonRequest, LlmCapability, LlmProvider } from '@metrum/ledgerline-llm';

import { checkNumbers, numericTokens } from './lib/ask/numeric-check.js';
import { validateAskQuery } from './lib/ask/queries.js';
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

/**
 * A provider scripted separately for each of Ask's two calls.
 *
 * They are different questions — pick a query, then describe a result — and a fake
 * that answered both from one function could not express the case that matters most:
 * a valid query followed by prose with an invented number in it.
 *
 * **Both arrive through `complete`, and that is the seam working as designed.**
 * `CachingLlmProvider` implements `completeJson` by fetching raw text through
 * `complete` and validating at the wrapper, so that a wrong-shaped answer is cached
 * once rather than re-fetched forever. A fake that answered on `completeJson` would
 * therefore never be consulted for the query stage — so this discriminates on the
 * prompt, which is also a stronger test: it asserts the two prompts are actually
 * different.
 */
class TwoStageProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly sendsDataOffMachine = false;
  readonly prompts: string[] = [];

  constructor(
    private readonly query: unknown,
    private readonly prose: string | null = 'Here is the answer.',
  ) {}

  capabilities(): LlmCapability[] {
    return ['complete', 'json'];
  }

  health() {
    return Promise.resolve({ ok: true, detail: 'scripted', model: 'scripted' });
  }

  complete(request: CompleteRequest): Promise<string> {
    this.prompts.push(request.prompt);

    if (request.prompt.includes('Choose exactly one function')) {
      return Promise.resolve(JSON.stringify(this.query));
    }
    if (this.prose === null) return Promise.reject(new Error('model unavailable'));
    return Promise.resolve(this.prose);
  }

  completeJson<T>(request: JsonRequest<T>): Promise<T> {
    return this.complete(request).then((text) => request.validate(JSON.parse(text)));
  }
}

describe('ledgerline-api Ask (§6.7, §2.3)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let provider: LlmProvider | null = null;

  const ask = (question: string) =>
    app.inject({ method: 'POST', url: '/api/ask', payload: { question } });

  beforeEach(async () => {
    provider = null;
    context = createContext({
      databaseFile: ':memory:',
      profilesDir: PROFILES_DIR,
      llmProviderFactory: () => provider ?? new NoneProvider(),
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

    const accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;

    const statement: StatementRow[] = [
      { date: '2026-01-04', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
      { date: '2026-01-09', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
      { date: '2026-01-14', description: 'SQ *BLUE BOTTLE 1234 PORTLAND', amountCents: -640 },
      { date: '2026-01-19', description: 'ZELLE PAYMENT TO SARAH M 88213', amountCents: -12000 },
      { date: '2026-02-04', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
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
    await app.inject({ method: 'POST', url: `/api/imports/${staged.import.id}/commit`, payload: {} });
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  const useProvider = async (p: LlmProvider) => {
    provider = p;
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { llm: { providerId: 'ollama' } },
    });
  };

  // ------------------------------------------------------------ §2.3's 409 ---

  describe('with no provider configured (§2.3)', () => {
    it('answers 409 with a machine-readable reason', async () => {
      const response = await ask('what did I spend on coffee?');

      expect(response.statusCode).toBe(409);
      // §2.3 says "machine-readable", which is the code — the page branches on it
      // to offer the link to Settings rather than parsing the sentence.
      expect(response.json().error).toBe('llm_disabled');
      expect(response.json().message).toContain('Settings');
    });

    it('says why this one feature has no deterministic fallback', async () => {
      // Every other degradation in the system returns the rules' answer. Ask has
      // none, and the message has to explain that rather than looking like a bug.
      expect((await ask('anything')).json().message).toContain('no deterministic answer');
    });
  });

  // ------------------------------------------- no arbitrary database access ---

  describe('the model picks a query and never writes one (§6.7)', () => {
    it('rejects a query name that is not one of the six', () => {
      expect(() => validateAskQuery({ name: 'dropEverything' })).toThrow(/not one of/);
    });

    it('rejects a range that is not two ISO dates', () => {
      expect(() => validateAskQuery({ name: 'monthlyTotals', from: '2026-01-01', to: 'soon' })).toThrow(
        /YYYY-MM-DD/,
      );
    });

    it('requires the parameters a query cannot run without', () => {
      expect(() => validateAskQuery({ name: 'merchantHistory' })).toThrow(/needs a merchant/);
      expect(() => validateAskQuery({ name: 'spendByCategory' })).toThrow(/date range/);
    });

    it('bounds `n` rather than refusing a large one', () => {
      expect(validateAskQuery({ name: 'topMerchants', n: 5000 }).n).toBe(50);
    });

    it('degrades to an answerless response when the model picks nothing valid', async () => {
      await useProvider(new TwoStageProvider({ name: 'definitelyNotAQuery' }));

      const response = await ask('what did I spend?');

      // A schema-validation failure degrades exactly like an unreachable provider
      // (§2.4) — not a 500, and nothing was read from the ledger.
      expect(response.statusCode).toBe(200);
      expect(response.json().answer).toBeNull();
      expect(response.json().queryName).toBeNull();
      expect(response.json().withheldReason).toContain('Nothing was read');
      expect(context.store.llm.countDegraded()).toBe(1);
    });
  });

  // ------------------------------------------------------ data minimization ---

  describe('data minimization (§6.7)', () => {
    it('never sends row-level amounts or dates to the provider', async () => {
      const scripted = new TwoStageProvider({
        name: 'transactionSearch',
        from: '2026-01-01',
        to: '2026-12-31',
      });
      await useProvider(scripted);

      await ask('show me everything');

      // The second prompt is the one carrying data. §6.7: the provider receives "a
      // count, the aggregate totals, and at most twenty descriptors".
      const dataPrompt = scripted.prompts[1];
      expect(dataPrompt).toBeDefined();
      expect(dataPrompt).not.toContain('2026-01-09');
      expect(dataPrompt).not.toContain('1840');
      expect(dataPrompt).not.toContain('18.40');
    });

    it('withholds a P2P descriptor from the provider but still counts it (§2.4)', async () => {
      const scripted = new TwoStageProvider({
        name: 'transactionSearch',
        from: '2026-01-01',
        to: '2026-12-31',
      });
      await useProvider(scripted);

      const response = await ask('show me everything');

      expect(scripted.prompts[1]).not.toContain('SARAH');
      expect(response.json().withheldP2P).toBeGreaterThan(0);
    });

    it('still returns the full rows to the UI', async () => {
      await useProvider(
        new TwoStageProvider({ name: 'transactionSearch', from: '2026-01-01', to: '2026-12-31' }),
      );

      const rows = (await ask('show me everything')).json().rows as { label: string }[];

      // "The UI renders the full result locally" — including the row the provider
      // was not shown.
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.some((row) => row.label.includes('ZELLE'))).toBe(true);
    });

    it('sends aggregate lines, which are already aggregates', async () => {
      const scripted = new TwoStageProvider({
        name: 'monthlyTotals',
        from: '2026-01-01',
        to: '2026-12-31',
      });
      await useProvider(scripted);

      await ask('how much per month?');

      // A month total is not a row, so §6.7's minimization does not withhold it —
      // the whole point of choosing an aggregate query is that its output is safe.
      expect(scripted.prompts[1]).toContain('2026-01');
    });
  });

  // ------------------------------------------------- no hallucinated numbers ---

  describe('numeric post-validation (§6.7)', () => {
    it('finds the numbers in prose', () => {
      expect(numericTokens('You spent $1,099.00 across 3 charges, up 12.5%')).toEqual([
        '$1,099.00',
        '3',
        '12.5%',
      ]);
    });

    it('accepts a figure that is in the rows, in dollars where the row is in cents', () => {
      const result = { rows: [{ amountCents: -109_900 }], totalCents: -109_900, rowCount: 1 };
      expect(checkNumbers('You spent $1,099.00.', result).ok).toBe(true);
    });

    it('accepts a simple aggregate of two present values', () => {
      const result = { rows: [{ amountCents: 1000 }, { amountCents: 2500 }], rowCount: 2 };
      // The sum, which §6.7 names as an allowed derivation.
      expect(checkNumbers('That is $35.00 in total.', result).ok).toBe(true);
    });

    it('rejects a figure that is nowhere in the result', () => {
      const result = { rows: [{ amountCents: -109_900 }], totalCents: -109_900, rowCount: 1 };
      const check = checkNumbers('You spent $4,120.00.', result);

      expect(check.ok).toBe(false);
      expect(check.unsupported).toContain('$4,120.00');
    });

    it('withholds the whole answer but still shows the table', async () => {
      await useProvider(
        new TwoStageProvider(
          { name: 'monthlyTotals', from: '2026-01-01', to: '2026-12-31' },
          'You spent $98,765.43 last month, which is remarkable.',
        ),
      );

      const body = (await ask('how much per month?')).json();

      // §6.7: "An answer that fails validation is not shown; the table is shown
      // instead with a note."
      expect(body.answer).toBeNull();
      expect(body.withheldReason).toContain('$98,765.43');
      expect(body.rows.length).toBeGreaterThan(0);
    });

    it('shows prose whose numbers all check out', async () => {
      await useProvider(
        new TwoStageProvider(
          { name: 'findRecurring' },
          'You have no active subscriptions on record yet.',
        ),
      );

      const body = (await ask('what am I subscribed to?')).json();

      // No numbers at all is trivially valid — and the empty-result rule is what
      // catches it instead, which is the interaction worth pinning.
      expect(body.queryName).toBe('findRecurring');
      expect(body.withheldReason).toContain('no data behind it');
    });
  });

  // ------------------------------------------------------- the working path ---

  it('names the query it ran, and returns the table behind the answer (§6.7)', async () => {
    await useProvider(
      new TwoStageProvider(
        { name: 'topMerchants', from: '2026-01-01', to: '2026-12-31', n: 3 },
        'Netflix is your largest merchant over the period.',
      ),
    );

    const body = (await ask('who do I pay the most?')).json();

    expect(body.answer).toBe('Netflix is your largest merchant over the period.');
    expect(body.withheldReason).toBeNull();
    // §6.7: every answer "names the query it ran".
    expect(body.queryName).toBe('topMerchants');
    expect(body.queryDescription).toContain('top 3 merchants');
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it('falls back to the table when the model answers the query but not the question', async () => {
    await useProvider(
      new TwoStageProvider({ name: 'monthlyTotals', from: '2026-01-01', to: '2026-12-31' }, null),
    );

    const body = (await ask('how much per month?')).json();

    // The query ran deterministically and its rows are real; only the prose is
    // missing. That is a degraded call, not a failed request.
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.answer).toBeNull();
    expect(body.withheldReason).toContain('did not answer');
    expect(context.store.llm.countDegraded()).toBe(1);
  });
});

/**
 * §7.6's corpus written against the ledger, and the recall figure §9z could not
 * produce (§9ab).
 *
 * §9z's finding labels measure precision — of what fired, how much was right — and
 * that suite exists. What is asserted here is the thing only per-row ground truth can
 * say: **the rule did not fire and should have**. A miss leaves no finding to judge,
 * so nothing in the §9z shape can see it.
 *
 * The other half is the correction snapshot, and its test is the one that would have
 * caught the trap: correcting a merchant *destroys* the evidence it produces unless
 * the chain's answer is captured first.
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

function statementCsv(rows: readonly StatementRow[]): string {
  let balance = 500_000;
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

interface CalibrationShape {
  progress: { labelled: number; fromReview: number; fromCorrection: number; total: number };
  normalization: {
    compared: number;
    agreed: number;
    disagreed: number;
    fromReview: { compared: number; agreed: number };
    fromCorrection: { compared: number; agreed: number };
  };
  rules: {
    ruleId: string;
    expected: number;
    found: number;
    missed: number;
    falsePositives: number;
    judgedCorrect: number;
  }[];
  unavailableReason: string | null;
}

describe('ledgerline-api calibration (§7.6, §9ab)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let rows: { id: string; descriptionRaw: string; merchantId: string | null }[];

  const calibration = async (): Promise<CalibrationShape> =>
    (await app.inject({ method: 'GET', url: '/api/calibration' })).json() as CalibrationShape;

  const label = (transactionId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/transactions/${transactionId}/label`, payload: body });

  const rowFor = (fragment: string) => {
    const found = rows.find((row) => row.descriptionRaw.includes(fragment));
    if (!found) throw new Error(`no row matching ${fragment}`);
    return found;
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

    const accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;

    // Two charges from an obscure gym that no rule will call a subscription — which
    // is exactly the shape a recall test needs: something a person can see is
    // recurring and the rules cannot.
    const statement: StatementRow[] = [
      { date: '2026-01-05', description: 'ANYTIME FITNESS 4417', amountCents: -3900 },
      { date: '2026-01-11', description: 'SAFEWAY #1234', amountCents: -8200 },
      { date: '2026-02-05', description: 'ANYTIME FITNESS 4417', amountCents: -3900 },
      { date: '2026-02-14', description: 'SHELL OIL 574411', amountCents: -4400 },
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

    rows = context.store.db
      .prepare('SELECT id, description_raw AS descriptionRaw, merchant_id AS merchantId FROM "transaction"')
      .all() as typeof rows;
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  /**
   * §9ab: the preflight has to name every method a route uses.
   *
   * This test exists because the browser found what the suite could not. Every
   * other case here reaches the router through `app.inject`, which never sends a
   * preflight — so a PUT route the CORS header did not list passed 297 tests and
   * failed on the first keystroke in the actual page.
   */
  it('allows the methods its own routes use, so a browser can reach them', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/transactions/whatever/label',
      headers: { origin: 'http://localhost:4200' },
    });

    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
  });

  // ------------------------------------------------------------- the write ---

  describe('PUT /api/transactions/:id/label', () => {
    it('records an assertion and the chain’s answer beside it', async () => {
      const row = rowFor('ANYTIME FITNESS');
      const response = await label(row.id, { isRecurring: true });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        isRecurring: true,
        // Read off the row, never accepted from the client.
        chainMerchantId: row.merchantId,
        origin: 'review',
      });
      // Untouched fields stay unasserted rather than defaulting to false.
      expect(response.json().isFee).toBeNull();
    });

    it('merges rather than replaces, so an afternoon accumulates', async () => {
      const row = rowFor('ANYTIME FITNESS');
      await label(row.id, { isRecurring: true });
      const second = await label(row.id, { isFee: false });

      // Marking it "not a fee" on Tuesday has not retracted Monday's assertion.
      expect(second.json()).toMatchObject({ isRecurring: true, isFee: false });
    });

    it('distinguishes “not asserted” from “asserted false”', async () => {
      const row = rowFor('SAFEWAY');
      await label(row.id, { isFee: false });
      const cleared = await label(row.id, { isFee: null });

      // The whole reason recall is computable: a null is nobody looking, and a
      // false is somebody looking and saying no.
      expect(cleared.json().isFee).toBeNull();
    });

    it('404s for a transaction or a merchant that does not exist', async () => {
      expect((await label('nope', { isFee: true })).statusCode).toBe(404);
      expect(
        (await label(rowFor('SAFEWAY').id, { expectedMerchantId: 'not-a-merchant' })).statusCode,
      ).toBe(404);
    });

    it('withdraws a judgement, which is not the same as asserting false', async () => {
      const row = rowFor('SAFEWAY');
      await label(row.id, { isFee: false });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/transactions/${row.id}/label`,
      });

      expect(removed.json()).toEqual({ removed: true });
      expect(context.store.transactionLabels.get(row.id)).toBeNull();
    });
  });

  // ----------------------------------------- the thing §9z could not measure ---

  describe('recall', () => {
    it('counts a rule that should have fired and did not', async () => {
      const gym = rowFor('ANYTIME FITNESS');
      await label(gym.id, { isRecurring: true });

      await app.inject({ method: 'POST', url: '/api/analysis/run' });
      await context.jobRunner.drain();

      const report = await calibration();
      const recurrence = report.rules.find((rule) => rule.ruleId === 'recurrence.v1');

      // Two charges is below §5.2's minimum, so no series exists — and the label
      // is what turns that from an invisible absence into a counted miss. No
      // finding was emitted, so nothing in §9z's shape could have seen this.
      expect(recurrence?.expected).toBe(1);
      expect(recurrence?.missed).toBe(1);
      expect(recurrence?.found).toBe(0);
    });

    it('ignores rows nobody asserted anything about', async () => {
      await app.inject({ method: 'POST', url: '/api/analysis/run' });
      await context.jobRunner.drain();

      const report = await calibration();

      // Four transactions, no labels. Counting unexamined rows as agreement would
      // make every rule look perfect on an untouched ledger.
      for (const rule of report.rules) {
        expect(rule.expected).toBe(0);
        expect(rule.missed).toBe(0);
      }
    });

    it('refuses to report recall before an analysis has run', async () => {
      await label(rowFor('ANYTIME FITNESS').id, { isRecurring: true });

      const report = await calibration();

      // "Everything was missed" would be a lie about the rules rather than a fact
      // about the corpus.
      expect(report.rules).toEqual([]);
      expect(report.unavailableReason).toContain('No analysis has finished');
    });
  });

  // ------------------------------------------------- the correction snapshot ---

  describe('a merchant correction becomes evidence (§4.3, §9ab)', () => {
    it('captures what the chain said *before* the correction lands', async () => {
      const gym = rowFor('ANYTIME FITNESS');
      const chainMerchant = gym.merchantId;
      const [target] = context.store.merchants.list().filter((m) => m.id !== chainMerchant);

      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${gym.id}`,
        payload: { merchantId: target.id },
      });

      const stored = context.store.transactionLabels.get(gym.id);
      // The trap this exists for: after the alias lands the chain resolves to
      // `target`, and without this snapshot nothing would remember it had not.
      expect(stored).toMatchObject({
        expectedMerchantId: target.id,
        chainMerchantId: chainMerchant,
        origin: 'correction',
      });
    });

    it('counts as a disagreement, in its own bucket', async () => {
      const gym = rowFor('ANYTIME FITNESS');
      const [target] = context.store.merchants.list().filter((m) => m.id !== gym.merchantId);

      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${gym.id}`,
        payload: { merchantId: target.id },
      });

      const report = await calibration();

      expect(report.normalization).toMatchObject({
        compared: 1,
        agreed: 0,
        disagreed: 1,
        fromCorrection: { compared: 1, agreed: 0 },
        // Kept apart: corrections are by definition the rows the chain got wrong,
        // so mixing them into a deliberate pass would libel the chain.
        fromReview: { compared: 0, agreed: 0 },
      });
    });

    it('records a deliberate agreement separately', async () => {
      const safeway = rowFor('SAFEWAY');
      await label(safeway.id, { expectedMerchantId: safeway.merchantId });

      const report = await calibration();

      expect(report.normalization).toMatchObject({
        compared: 1,
        agreed: 1,
        fromReview: { compared: 1, agreed: 1 },
        fromCorrection: { compared: 0, agreed: 0 },
      });
    });

    it('a later deliberate judgement outranks the correction’s side effect', async () => {
      const gym = rowFor('ANYTIME FITNESS');
      const [target] = context.store.merchants.list().filter((m) => m.id !== gym.merchantId);

      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${gym.id}`,
        payload: { merchantId: target.id },
      });
      await label(gym.id, { isRecurring: true });

      // A row somebody actually looked at is better evidence than one inferred
      // from an edit, so `review` wins and does not flip back.
      expect(context.store.transactionLabels.get(gym.id)?.origin).toBe('review');
    });
  });

  // ------------------------------------------------------------- progress ---

  it('reports how far the pass has got, split by where the judgements came from', async () => {
    await label(rowFor('SAFEWAY').id, { isFee: false });
    const gym = rowFor('ANYTIME FITNESS');
    const [target] = context.store.merchants.list().filter((m) => m.id !== gym.merchantId);
    await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${gym.id}`,
      payload: { merchantId: target.id },
    });

    const report = await calibration();

    expect(report.progress).toMatchObject({
      labelled: 2,
      fromReview: 1,
      fromCorrection: 1,
      total: 4,
    });
  });
});

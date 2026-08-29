/**
 * §7.6's corpus, collected from use (§9z).
 *
 * §7.6 says nothing in §5 has been run against a real statement and that "the first
 * phase that ships analyzers also ships a fixture corpus — a hand-labelled year of
 * real statements with the expected findings written down". It has not been built,
 * and the reason is not that anybody forgot: it is an afternoon of sitting with a
 * year of statements before ever seeing what the rules found. This is the half a
 * person can do thirty seconds at a time.
 *
 * The cases below are mostly about one distinction. A label is not a dismissal, and
 * a system that conflated them would calibrate §5 toward what annoys the reader —
 * silently, and unrecoverably, because the two verdicts would already have been
 * mixed by the time anyone noticed.
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

function monthly(
  description: string,
  amountCents: number,
  startIso: string,
  count: number,
): StatementRow[] {
  const rows: StatementRow[] = [];
  let year = Number(startIso.slice(0, 4));
  let month = Number(startIso.slice(5, 7));
  const day = startIso.slice(8, 10);

  for (let index = 0; index < count; index += 1) {
    rows.push({
      date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${day}`,
      description,
      amountCents,
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return rows;
}

interface FindingShape {
  id: string;
  ruleId: string;
  naturalKey: string;
  verdict: 'correct' | 'incorrect' | 'unsure' | null;
  verdictStale: boolean;
  userStatus: string | null;
}

describe('ledgerline-api finding labels (§7.6, §9z)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let finding: FindingShape;

  const findings = async (): Promise<FindingShape[]> =>
    (
      await app.inject({ method: 'GET', url: '/api/findings?limit=200&visibility=all' })
    ).json().rows as FindingShape[];

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

    const form = new FormData();
    form.append(
      'files',
      new File(
        [statementCsv(monthly('NETFLIX.COM 866-579-7172 CA', -1099, '2026-01-04', 12))],
        'year.csv',
        { type: 'text/csv' },
      ),
    );
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

    await app.inject({ method: 'POST', url: '/api/analysis/run' });
    await context.jobRunner.drain();

    const all = await findings();
    expect(all.length).toBeGreaterThan(0);
    finding = all[0];
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  const label = (verdict: string, note?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/findings/${finding.id}/label`,
      payload: note === undefined ? { verdict } : { verdict, note },
    });

  it('records a judgement and returns it on the finding', async () => {
    const response = await label('correct');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ verdict: 'correct', verdictStale: false });
    expect((await findings())[0].verdict).toBe('correct');
  });

  it('keeps the note, which is the column no threshold can reconstruct', async () => {
    await label('incorrect', 'double-counted the refund');

    expect(context.store.findingLabels.get(finding.naturalKey)?.note).toBe(
      'double-counted the refund',
    );
  });

  it('lets a judgement be changed rather than accumulating a history', async () => {
    await label('correct');
    await label('incorrect');

    expect((await findings())[0].verdict).toBe('incorrect');
    expect(context.store.findingLabels.list()).toHaveLength(1);
  });

  it('rejects a verdict that is not one of the three', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/findings/${finding.id}/label`,
      payload: { verdict: 'probably' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for a finding that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/findings/nope/label',
      payload: { verdict: 'correct' },
    });

    expect(response.statusCode).toBe(404);
  });

  // ------------------------------------- the distinction this table exists for ---

  describe('a label is not a dismissal', () => {
    it('marking one wrong does not hide it', async () => {
      await label('incorrect');

      const after = (await findings()).find((row) => row.id === finding.id);
      // §7.6 wants the judgement; §5.1 owns the hiding. A "No" that removed the
      // card would teach a reader that the honest answer costs them the finding.
      expect(after?.userStatus).toBeNull();
      expect(after?.verdict).toBe('incorrect');
    });

    it('dismissing one does not mark it wrong', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/findings/${finding.id}/state`,
        payload: { status: 'dismissed' },
      });

      const after = (await findings()).find((row) => row.id === finding.id);
      // The case that would poison the corpus: a correct finding the user has
      // decided to stop seeing. Counting it as wrong would tune §5 toward what
      // annoys rather than toward what errs.
      expect(after?.userStatus).toBe('dismissed');
      expect(after?.verdict).toBeNull();
    });

    it('carries both at once, because both can be true', async () => {
      await label('correct');
      await app.inject({
        method: 'POST',
        url: `/api/findings/${finding.id}/state`,
        payload: { status: 'dismissed' },
      });

      const after = (await findings()).find((row) => row.id === finding.id);
      expect(after).toMatchObject({ verdict: 'correct', userStatus: 'dismissed' });
    });
  });

  // ----------------------------------------------------------- staleness ---

  describe('a judgement about evidence that has moved (§5.1’s rule, applied to labels)', () => {
    it('is flagged rather than silently recounted', async () => {
      await label('correct');

      // §5.1's own mechanism for a dismissal: move the evidence hash and the
      // verdict is about a claim that no longer exists in that form.
      context.store.db
        .prepare('UPDATE finding SET evidence_hash = ? WHERE id = ?')
        .run('a-different-claim', finding.id);

      const after = (await findings()).find((row) => row.id === finding.id);
      expect(after).toMatchObject({ verdict: 'correct', verdictStale: true });
    });

    it('is excluded from the rule’s tally and counted separately', async () => {
      await label('correct');
      context.store.db
        .prepare('UPDATE finding SET evidence_hash = ? WHERE id = ?')
        .run('a-different-claim', finding.id);

      const accuracy = context.store.findingLabels.accuracyByRule().get(finding.ruleId);

      // A rule whose labels are mostly stale has an accuracy figure resting on a
      // handful of current ones, and a reader about to move a threshold on the
      // strength of it should be told.
      expect(accuracy).toMatchObject({ correct: 0, stale: 1 });
    });
  });

  // ------------------------------------------------ what Settings shows ---

  it('reports the tally beside the rule whose thresholds it would tune (§6.8)', async () => {
    await label('correct');

    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    const rule = settings.rules.find(
      (entry: { id: string }) => entry.id === finding.ruleId,
    );

    expect(rule.labelled).toMatchObject({ correct: 1, incorrect: 0, unsure: 0, stale: 0 });
  });

  it('survives the finding it judged, which is the point of a separate table', async () => {
    await label('incorrect');

    // A threshold change can remove a finding from every future run. The judgement
    // about how the rule behaved *at the old threshold* is exactly what tuning wants
    // to look back at, so it must not be joined away.
    context.store.db.prepare('DELETE FROM finding_evidence').run();
    context.store.db.prepare('DELETE FROM finding').run();

    expect(context.store.findingLabels.get(finding.naturalKey)?.verdict).toBe('incorrect');
    expect(
      context.store.findingLabels.accuracyByRule().get(finding.ruleId),
    ).toMatchObject({ incorrect: 1, stale: 0 });
  });
});

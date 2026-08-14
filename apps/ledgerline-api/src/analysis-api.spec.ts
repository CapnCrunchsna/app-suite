/**
 * §5.1's finding lifecycle, exercised end to end.
 *
 * The rules themselves are unit-tested in `libs/ledgerline/analyzers` against
 * literal arrays, and that is the right place for "does the cadence fit". What
 * a pure-function test structurally cannot reach is everything §5.1 says about
 * what happens **between** runs — upsert by natural key, resolution, the evidence
 * hash surviving a re-run, three dismissal scopes composing — because all four
 * are statements about stored state across two invocations. So this suite runs
 * the real analyzers over the real store through the real HTTP surface, twice.
 *
 * ## The dataset is generated, and generated through the import pipeline
 *
 * §5's rules need years, not rows: a fitted series is three or more charges at a
 * cadence, a price step has to *hold*, and "lapsed" is measured in multiples of a
 * cadence against §7.2's coverage end. The committed fixtures are three
 * statements covering two months, which is correct for §6.3's page and produces
 * no series at all.
 *
 * The statements below are therefore built in-test — but built as **Northgate
 * CSVs and posted to `POST /api/imports`**, not inserted into the table. Two
 * things depend on that. Coverage comes from `statement_import.period_start/end`
 * (§7.2), so a test that inserted transactions directly would be measuring
 * liveness against coverage no import ever claimed. And the merchant ids the
 * rules group on come from §4's chain, so `NETFLIX.COM 866-579-7172 CA` has to
 * actually resolve to `netflix` the way a statement does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { JobRunner } from './lib/job-runner.js';
import { buildServer } from './lib/server.js';

const PROFILES_DIR = new URL('../../../profiles', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);

interface StatementRow {
  /** ISO, because everything in this system is (§7.1). Converted to the bank's
   *  `MM/DD/YYYY` on the way into the file. */
  readonly date: string;
  readonly description: string;
  readonly amountCents: number;
}

interface FindingShape {
  id: string;
  ruleId: string;
  naturalKey: string;
  subjectId: string;
  title: string;
  detail: Record<string, unknown>;
  band: string;
  impactKind: string;
  impactAnnualCents: number;
  impactMonthlyCents: number;
  evidenceHash: string;
  evidenceTransactionIds: string[];
  firstDetectedAt: string;
  status: string;
  userStatus: string | null;
  changedSinceDismissal: boolean;
  reEvaluated: boolean;
}

interface SummaryShape {
  subscriptions: {
    activeCount: number;
    lapsedCount: number;
    monthlyCents: number;
    annualCents: number;
  };
  savingsAnnualCents: number;
  activeFindingCount: number;
  unreviewedCount: number;
  countsByRule: Record<string, number>;
  lastRunAt: string | null;
  lastRunConfigHash: string | null;
  lastRunSnapshotRows: number | null;
  configHash: string;
}

// ------------------------------------------------------- statement building ---

const usDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Plain decimal, no thousands separator, so no field ever needs quoting. */
const money = (cents: number): string => (cents / 100).toFixed(2);

/**
 * A Northgate statement, in exactly the shape `profiles/northgate-checking.json`
 * expects: three preamble lines, a blank, the header signature it is keyed on.
 *
 * The running balance is computed rather than faked. §6.1's balance check
 * reconciles `balance[n] − balance[n−1] === amount[n]` across the file and a
 * mismatch is a warning on every row — noise that would sit on top of any real
 * failure this suite is trying to show.
 */
function statementCsv(rows: readonly StatementRow[], openingCents = 500_000): string {
  let balance = openingCents;
  const lines = rows.map((row) => {
    balance += row.amountCents;
    return [
      usDate(row.date),
      row.description,
      money(row.amountCents),
      money(balance),
      'Posted',
    ].join(',');
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

/** `count` charges on the same day of successive months. A fixed day of month is
 *  what a real subscription does, and it is also what keeps §5.2's four-weekly
 *  tie-break from claiming the series: any span over a 31-day month forces a
 *  delta outside 27–29. */
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

const byDate = (a: StatementRow, b: StatementRow): number => (a.date < b.date ? -1 : 1);

const NETFLIX = 'NETFLIX.COM 866-579-7172 CA';
const HULU = 'HULU 877-8244858 CA';
const SPOTIFY = 'SPOTIFY USA 4029357733';

describe('ledgerline-api analysis surface (§5.1)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;

  async function importStatement(name: string, rows: readonly StatementRow[]): Promise<string> {
    const form = new FormData();
    form.append('files', new File([statementCsv(rows)], name, { type: 'text/csv' }));
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

    return staged.import.id;
  }

  /**
   * §2.7's round trip: enqueue, then run the queue.
   *
   * `drain()` rather than waiting on the scheduled one. The runner holds a
   * coalescing window before it starts (§2.7), so a request returns long before
   * the analysis does, and a test that awaited that would be a test with a sleep
   * in it — while the thing being asserted ("one run produces these findings")
   * needs no timer to be true. The window itself is asserted separately, by the
   * coalescing test at the bottom of this file.
   */
  async function analyze(): Promise<void> {
    const response = await app.inject({ method: 'POST', url: '/api/analysis/run' });
    expect(response.statusCode).toBe(202);
    context.jobRunner.drain();

    const job = await app.inject({
      method: 'GET',
      url: `/api/jobs/${(response.json() as { id: string }).id}`,
    });
    expect(job.json()).toMatchObject({ state: 'succeeded', progress: 100 });
  }

  async function findings(query = ''): Promise<FindingShape[]> {
    const response = await app.inject({ method: 'GET', url: `/api/findings?${query}` });
    expect(response.statusCode).toBe(200);
    return (response.json() as { rows: FindingShape[] }).rows;
  }

  async function findingFor(ruleId: string, merchantId?: string): Promise<FindingShape> {
    const all = await findings('visibility=all&statuses=active,resolved,suppressed&limit=500');
    const matched = all.filter(
      (finding) =>
        finding.ruleId === ruleId &&
        (merchantId === undefined || finding.detail['merchantId'] === merchantId),
    );
    expect(matched).toHaveLength(1);
    return matched[0];
  }

  async function summary(): Promise<SummaryShape> {
    const response = await app.inject({ method: 'GET', url: '/api/findings/summary' });
    expect(response.statusCode).toBe(200);
    return response.json() as SummaryShape;
  }

  async function setState(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: FindingShape }> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/findings/${id}/state`,
      payload: body,
    });
    return { statusCode: response.statusCode, body: response.json() as FindingShape };
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

    // Fourteen months in two statements. Netflix runs throughout at $15.49; Hulu
    // and Spotify stop in mid-2025 and never come back, which is what makes them
    // lapsed against a coverage end of 2026-01-05 (§5.7, §7.2).
    await importStatement(
      'northgate-2025-h1.csv',
      [
        ...monthly(NETFLIX, -1549, '2025-02-05', 6),
        ...monthly(HULU, -1299, '2025-02-12', 5),
        ...monthly(SPOTIFY, -1199, '2025-02-20', 5),
      ].sort(byDate),
    );

    await importStatement('northgate-2025-h2.csv', monthly(NETFLIX, -1549, '2025-08-05', 6));
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  /** The third statement raises Netflix to $17.99 and holds it for three months —
   *  §5.5's "an amount change that **holds** for a cadence-appropriate number of
   *  consecutive occurrences", which for a monthly series is two. */
  async function importPriceRise(): Promise<string> {
    return importStatement('northgate-2026-q1.csv', monthly(NETFLIX, -1799, '2026-02-05', 3));
  }

  // ------------------------------------------------------------- the basics ---

  describe('a run over stored data', () => {
    it('produces the series and findings §5 describes, and records the run', async () => {
      await importPriceRise();
      await analyze();

      const rules = (await findings('limit=500')).map((finding) => finding.ruleId).sort();
      expect(rules).toEqual(['lapsed.v1', 'lapsed.v1', 'price_creep.v1', 'recurrence.v1']);

      const creep = await findingFor('price_creep.v1');
      expect(creep.detail).toMatchObject({
        merchantId: 'netflix',
        cadenceLabel: 'monthly',
        firstCents: 1549,
        currentCents: 1799,
        cumulativeDeltaCents: 250,
      });
      // §7.3: integer cents end to end. $2.50 a month is $30 a year.
      expect(creep.impactAnnualCents).toBe(3000);
      expect(creep.impactKind).toBe('savings');

      // §5.7 emits zero impact with the former cost in the detail — a lapsed
      // subscription is not money being spent (§9d).
      const hulu = await findingFor('lapsed.v1', 'hulu');
      expect(hulu.impactAnnualCents).toBe(0);
      expect(hulu.detail).toMatchObject({ formerAnnualCents: 15588, coverageEnd: '2026-04-05' });
    });

    it('measures liveness against statement coverage, not the transaction maximum', async () => {
      // §7.2: "Every liveness and lapse test measures against the account's own
      // coverage end." Netflix's last charge *is* the dataset maximum, so a rule
      // reading the maximum would call every series lapsed by construction; one
      // reading the wall clock would call all three lapsed, since these dates are
      // in the past. Exactly two are.
      await importPriceRise();
      await analyze();

      const lapsed = (await findings('ruleIds=lapsed.v1&limit=500')).map(
        (finding) => finding.detail['merchantId'],
      );
      expect(lapsed.sort()).toEqual(['hulu', 'spotify']);
    });

    it('materializes finding_evidence, which is what §6.3’s has-finding filter reads', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      expect(creep.evidenceTransactionIds).toHaveLength(15);

      const flagged = await app.inject({
        method: 'GET',
        url: '/api/transactions?hasFinding=true&limit=1000',
      });
      // Every Netflix, Hulu and Spotify charge is now evidence for something.
      expect((flagged.json() as { total: number }).total).toBe(25);
    });

    it('records config_hash and snapshot_rows on the run (§2.2, §7.4)', async () => {
      await importPriceRise();
      await analyze();

      const totals = await summary();
      expect(totals.lastRunSnapshotRows).toBe(25);
      expect(totals.lastRunConfigHash).toBe(totals.configHash);
      expect(totals.lastRunAt).not.toBeNull();
    });

    it('sums only savings into the headline (§5.1, §7.3)', async () => {
      await importPriceRise();
      await analyze();

      const totals = await summary();

      // The recurrence summary is $215.88/yr of `visibility` and the two lapsed
      // findings are zero. Only the price-creep delta is savings, and adding the
      // subscription total to it would count the same Netflix charges twice.
      expect(totals.savingsAnnualCents).toBe(3000);
      expect(totals.subscriptions).toMatchObject({
        activeCount: 1,
        lapsedCount: 2,
        annualCents: 21588,
      });
      expect(totals.unreviewedCount).toBe(totals.activeFindingCount);
    });

    it('is idempotent — a second run over unchanged data changes nothing', async () => {
      await importPriceRise();
      await analyze();
      const before = await findings('limit=500');

      await analyze();
      const after = await findings('limit=500');

      expect(after.map((finding) => finding.id).sort()).toEqual(
        before.map((finding) => finding.id).sort(),
      );
      expect(after.map((finding) => finding.evidenceHash).sort()).toEqual(
        before.map((finding) => finding.evidenceHash).sort(),
      );
    });
  });

  // ------------------------------------------------- 1. upsert by natural key ---

  describe('§5.1 upsert by natural key', () => {
    it('keeps one row per natural key across runs, with its first-detected date', async () => {
      await importPriceRise();
      await analyze();

      const first = await findingFor('price_creep.v1');
      await analyze();
      const second = await findingFor('price_creep.v1');

      // The whole point of `UNIQUE (rule_id, subject_type, subject_id)`: the same
      // finding, not a new one that happens to say the same thing.
      expect(second.id).toBe(first.id);
      expect(second.naturalKey).toBe(first.naturalKey);
      // Never re-stamped. This is the age of the problem, and a finding ignored
      // for four months has to be able to say so.
      expect(second.firstDetectedAt).toBe(first.firstDetectedAt);
    });

    it('preserves user state across a re-run', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      const acknowledged = await setState(creep.id, { status: 'acknowledged' });
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.body.userStatus).toBe('acknowledged');

      await analyze();

      // §5.1: "user state survives every re-run". An acknowledged finding stays
      // acknowledged and stays out of the unreviewed count.
      const after = await findingFor('price_creep.v1');
      expect(after.userStatus).toBe('acknowledged');

      const totals = await summary();
      expect(totals.unreviewedCount).toBe(totals.activeFindingCount - 1);
    });

    it('keeps a snoozed finding out of the list until its snooze expires', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      await setState(creep.id, { status: 'snoozed', snoozeDays: 90 });

      expect((await findings('ruleIds=price_creep.v1')).map((f) => f.id)).toEqual([]);
      // Hidden, not gone: §5.1's snooze is "deal with it later", not "resolved".
      expect((await findings('ruleIds=price_creep.v1&visibility=all')).map((f) => f.id)).toEqual([
        creep.id,
      ]);
    });
  });

  // --------------------------------------------------------- 2. resolution ---

  describe('§5.1 resolution', () => {
    it('marks a finding resolved rather than deleting it when it stops being true', async () => {
      const priceRiseImportId = await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      await setState(creep.id, { status: 'acknowledged' });

      // The statement that carried the higher price is removed — §3.3's delete
      // takes the rows for which it is the last remaining source. There is no
      // longer a price step, so the rule stops emitting.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/imports/${priceRiseImportId}`,
      });
      expect(deleted.statusCode).toBe(200);

      await analyze();

      // §5.1: "'this stopped being true' is itself information." The row is still
      // there, with its history and the user's acknowledgement intact.
      expect(await findings('ruleIds=price_creep.v1')).toEqual([]);

      const resolved = await findingFor('price_creep.v1');
      expect(resolved).toMatchObject({
        id: creep.id,
        status: 'resolved',
        userStatus: 'acknowledged',
        firstDetectedAt: creep.firstDetectedAt,
      });
    });

    it('brings a resolved finding back to active when it becomes true again', async () => {
      const priceRiseImportId = await importPriceRise();
      await analyze();
      const creep = await findingFor('price_creep.v1');

      await app.inject({ method: 'DELETE', url: `/api/imports/${priceRiseImportId}` });
      await analyze();
      expect((await findingFor('price_creep.v1')).status).toBe('resolved');

      await importPriceRise();
      await analyze();

      const revived = await findingFor('price_creep.v1');
      expect(revived).toMatchObject({ id: creep.id, status: 'active' });
      expect(revived.firstDetectedAt).toBe(creep.firstDetectedAt);
    });
  });

  // ---------------------------------------------- 3. the evidence hash ---

  describe('§5.1 the evidence hash', () => {
    it('keeps a dismissal in force while the evidence is unchanged', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      const dismissed = await setState(creep.id, {
        status: 'dismissed',
        reason: 'I know, I chose to keep it',
      });
      expect(dismissed.body.userStatus).toBe('dismissed');

      await analyze();
      await analyze();

      // Two more runs, and the finding stays out of the way. The dismissal is
      // recorded against the natural key, so it is not disturbed by the row being
      // re-upserted underneath it.
      expect(await findings('ruleIds=price_creep.v1')).toEqual([]);

      const hidden = await findingFor('price_creep.v1');
      expect(hidden).toMatchObject({
        userStatus: 'dismissed',
        changedSinceDismissal: false,
        evidenceHash: creep.evidenceHash,
      });
    });

    it('returns a dismissed finding, flagged, when the price moves again', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      await setState(creep.id, { status: 'dismissed' });
      expect(await findings('ruleIds=price_creep.v1')).toEqual([]);

      // A second rise, to $19.99, held for two months.
      await importStatement('northgate-2026-q2.csv', monthly(NETFLIX, -1999, '2026-05-05', 2));
      await analyze();

      // §5.1: "if the price changes [...] the hash changes and the finding returns
      // flagged **'changed since you dismissed this'**".
      const returned = await findingFor('price_creep.v1');
      expect(returned.id).toBe(creep.id);
      expect(returned.evidenceHash).not.toBe(creep.evidenceHash);
      expect(returned).toMatchObject({
        userStatus: 'dismissed',
        changedSinceDismissal: true,
        // The other resurfacing reason, and it did not happen here: no threshold
        // moved, so this is a price change and says so (§5.1).
        reEvaluated: false,
      });

      const visible = await findings('ruleIds=price_creep.v1');
      expect(visible.map((finding) => finding.id)).toEqual([creep.id]);
      expect(visible[0].detail).toMatchObject({ firstCents: 1549, currentCents: 1999 });
    });

    it('resurfaces a dismissal as re-evaluated when a threshold moves (§7.4)', async () => {
      await importPriceRise();
      await analyze();

      const creep = await findingFor('price_creep.v1');
      await setState(creep.id, { status: 'dismissed' });
      expect(await findings('ruleIds=price_creep.v1')).toEqual([]);

      // Settings tightens §5.5's noise floor. The finding is unchanged — same
      // price, same cadence, same hash — but it was judged by different numbers.
      context.store.settings.set('analyzer.config', { priceCreep: { minStepDeltaCents: 40 } });
      await analyze();

      const returned = await findingFor('price_creep.v1');
      expect(returned).toMatchObject({
        id: creep.id,
        evidenceHash: creep.evidenceHash,
        userStatus: 'dismissed',
        // §5.1 asks for these two to be told apart, and they are: the evidence is
        // identical, so this is not "the price changed".
        changedSinceDismissal: false,
        reEvaluated: true,
      });
      expect((await findings('ruleIds=price_creep.v1')).map((f) => f.id)).toEqual([creep.id]);
    });

    it('flips a lapsed finding’s hash through series_status, not occurrence count', async () => {
      await importPriceRise();
      await analyze();

      const before = await findingFor('lapsed.v1', 'hulu');

      // Three more months of statements with no Hulu charge in them. §5.1
      // deliberately keeps occurrence count *out* of the hash — a hash that moved
      // every billing cycle would un-dismiss every subscription on a schedule.
      // Hulu's own facts have not changed, so neither has its hash.
      await importStatement('northgate-2026-q2.csv', monthly(NETFLIX, -1799, '2026-05-05', 3));
      await analyze();

      const after = await findingFor('lapsed.v1', 'hulu');
      expect(after.evidenceHash).toBe(before.evidenceHash);
      expect(after.id).toBe(before.id);
    });
  });

  // ------------------------------------------------ 4. the dismissal scopes ---

  describe('§5.1 the three dismissal scopes', () => {
    it('scopes a per-finding dismissal to that finding alone', async () => {
      await analyze();

      const hulu = await findingFor('lapsed.v1', 'hulu');
      await setState(hulu.id, { status: 'dismissed' });
      await analyze();

      const visible = await findings('ruleIds=lapsed.v1');
      expect(visible.map((finding) => finding.detail['merchantId'])).toEqual(['spotify']);

      // `finding_state` is per-finding user state (§3.1) and nothing else moved.
      expect(context.store.findings.listDismissalRules()).toEqual([]);
    });

    it('suppresses one merchant’s findings for one rule at emit time', async () => {
      await analyze();

      const spotify = await findingFor('lapsed.v1', 'spotify');

      const created = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: { scope: 'merchant_rule', ruleId: 'lapsed.v1', merchantId: 'spotify' },
      });
      expect(created.statusCode).toBe(201);

      // Emit time, not read time (§3.1): the standing rule takes effect on the
      // next run, and it changes the finding's own status rather than filtering it
      // out of a query.
      await analyze();

      expect((await findings('ruleIds=lapsed.v1')).map((f) => f.detail['merchantId'])).toEqual([
        'hulu',
      ]);
      const suppressed = await findingFor('lapsed.v1', 'spotify');
      expect(suppressed).toMatchObject({ id: spotify.id, status: 'suppressed' });
    });

    it('suppresses a whole rule, and leaves the other rules alone', async () => {
      await importPriceRise();
      await analyze();

      await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: { scope: 'rule', ruleId: 'lapsed.v1', reason: 'I do not need cancellations' },
      });
      await analyze();

      expect(await findings('ruleIds=lapsed.v1')).toEqual([]);
      expect(
        (await findings('ruleIds=lapsed.v1&statuses=suppressed&visibility=all')).map(
          (f) => f.detail['merchantId'],
        ),
      ).toHaveLength(2);

      // The rest of §5 is untouched — a rule-scoped dismissal is about one rule.
      expect((await findings('ruleIds=price_creep.v1')).map((f) => f.detail['merchantId'])).toEqual(
        ['netflix'],
      );
    });

    it('composes all three, and lifting the standing rule restores exactly what it hid', async () => {
      await analyze();

      const hulu = await findingFor('lapsed.v1', 'hulu');
      const spotify = await findingFor('lapsed.v1', 'spotify');

      // Scope one on Hulu, scope two on Spotify. They are different tables and
      // different mechanisms, and they have to be able to hold at once.
      await setState(hulu.id, { status: 'dismissed' });
      const rule = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: { scope: 'merchant_rule', ruleId: 'lapsed.v1', merchantId: 'spotify' },
      });
      const ruleId = (rule.json() as { id: string }).id;

      await analyze();
      expect(await findings('ruleIds=lapsed.v1')).toEqual([]);

      const lifted = await app.inject({ method: 'DELETE', url: `/api/dismissal-rules/${ruleId}` });
      expect(lifted.statusCode).toBe(200);
      await analyze();

      // Spotify comes back because its suppression was the standing rule's.
      // Hulu does not, because its dismissal was never the standing rule's to
      // lift — which is the whole reason §3.1 keeps the two in separate tables.
      expect((await findings('ruleIds=lapsed.v1')).map((f) => f.detail['merchantId'])).toEqual([
        'spotify',
      ]);

      const restored = await findingFor('lapsed.v1', 'spotify');
      expect(restored).toMatchObject({
        id: spotify.id,
        status: 'active',
        firstDetectedAt: spotify.firstDetectedAt,
      });

      const stillDismissed = await findingFor('lapsed.v1', 'hulu');
      expect(stillDismissed).toMatchObject({ id: hulu.id, userStatus: 'dismissed' });
    });

    it('refuses a merchant-scoped rule with no merchant, and an unknown merchant', async () => {
      const noMerchant = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: { scope: 'merchant_rule', ruleId: 'lapsed.v1' },
      });
      expect(noMerchant.statusCode).toBe(400);

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: { scope: 'merchant_rule', ruleId: 'lapsed.v1', merchantId: 'nope' },
      });
      expect(unknown.statusCode).toBe(404);
    });

    it('is idempotent on (scope, rule, merchant)', async () => {
      const body = { scope: 'rule', ruleId: 'lapsed.v1' };
      const first = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: body,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/dismissal-rules',
        payload: body,
      });

      expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
      expect(context.store.findings.listDismissalRules()).toHaveLength(1);
    });
  });

  // --------------------------------------------------------- §2.7's runner ---

  describe('§2.7 the job runner', () => {
    it('runs a merchant correction’s coalesced re-normalize and converges §4.3', async () => {
      await analyze();

      // Two spellings of one merchant, as §4.1 stage 4 leaves them. Correcting
      // one enqueues the job; correcting the second merges into it.
      const page = await app.inject({
        method: 'GET',
        url: `/api/transactions?q=SPOTIFY&limit=1000`,
      });
      const rows = (page.json() as { rows: { transaction: { id: string } }[] }).rows;
      expect(rows.length).toBeGreaterThan(0);

      const corrected = await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${rows[0].transaction.id}`,
        payload: { merchantId: 'apple' },
      });
      expect(corrected.statusCode).toBe(200);

      const queued = context.store.jobs
        .list()
        .filter((job) => job.kind === 'renormalize' && job.state === 'queued');
      expect(queued).toHaveLength(1);

      // The message §6.3 used to have to show — "the job runner is not built yet,
      // so it stays queued" — is what this test exists to make false.
      context.jobRunner.drain();

      const job = context.store.jobs.get(queued[0].id);
      expect(job).toMatchObject({ state: 'succeeded', progress: 100 });

      // §4.3: the correction reached every charge with that descriptor, not just
      // the row that was clicked — and the analysis that follows sees the new
      // grouping, so the Spotify series is now Apple's.
      const after = await app.inject({
        method: 'GET',
        url: '/api/transactions?merchantIds=apple&limit=1000',
      });
      expect((after.json() as { total: number }).total).toBe(5);

      const lapsed = await findings('ruleIds=lapsed.v1&limit=500');
      expect(lapsed.map((finding) => finding.detail['merchantId']).sort()).toEqual([
        'apple',
        'hulu',
      ]);
    });

    it('records a failed job rather than throwing out of the queue', async () => {
      // §2.7's `job.kind` is a free-text column so a third kind needs no
      // migration, which means the runner can meet one it has no handler for.
      // A runner with an empty handler table is the same condition without
      // inventing a kind the type does not admit.
      const { job } = context.store.jobs.enqueueCoalesced({
        kind: 'analysis',
        mergePayload: () => null,
      });

      new JobRunner(context, {}).drain();

      expect(context.store.jobs.get(job.id)).toMatchObject({
        state: 'failed',
        message: 'no handler for job kind "analysis"',
      });
    });

    it('marks a job failed, with its reason, when the work throws', async () => {
      const { job } = context.store.jobs.enqueueCoalesced({
        kind: 'analysis',
        mergePayload: () => null,
      });

      new JobRunner(context, {
        analysis: () => {
          throw new Error('the snapshot could not be loaded');
        },
      }).drain();

      // §2.7 has `GET /api/jobs/:id` report `{ state, progress, message }`. A
      // readable reason there is a UI the user can act on; an unhandled rejection
      // that takes the API down is not.
      expect(context.store.jobs.get(job.id)).toMatchObject({
        state: 'failed',
        message: 'the snapshot could not be loaded',
      });
    });

    it('coalesces a second analysis request into the queued one (§2.7)', async () => {
      await app.inject({ method: 'POST', url: '/api/analysis/run' });
      const second = await app.inject({ method: 'POST', url: '/api/analysis/run' });

      const queued = context.store.jobs.list().filter((job) => job.state === 'queued');
      expect(queued).toHaveLength(1);
      expect((second.json() as { id: string }).id).toBe(queued[0].id);
    });
  });
});

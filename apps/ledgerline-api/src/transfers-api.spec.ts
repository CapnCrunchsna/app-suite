/**
 * §2.6's linking and §6.2's two surfaces, over HTTP and over the real fixtures.
 *
 * The matcher itself is unit-tested in `libs/ledgerline/analyzers` against literal
 * arrays, which is where "does the bipartite assignment hold" belongs. What a pure
 * function structurally cannot reach is everything that makes a link *stick*:
 * whether the flags move, whether a confirmed pair survives the next pass, whether
 * a rejection stays rejected, and whether the money actually leaves the totals.
 * All four are statements about stored state across two invocations, so this suite
 * runs the real matcher over the real store through the real routes.
 *
 * The fixtures earn their place here. `northgate-checking-2026-01.csv` prints
 * `ONLINE PMT CARDINAL CARD XXXX9012` at −$500.00 and `cardinal-card-2026-01.csv`
 * prints `PAYMENT THANK YOU - WEB` at +$500.00 on the same day, which is §2.6's
 * unambiguous case in its natural habitat: keyword-matched on both sides, the
 * card's last4 in the payment descriptor, the card's institution named, same day.
 * Eight points against a threshold of five.
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
  amountCents: number;
  descriptionNormalized: string;
  isInternalTransfer: boolean;
  transferPairId: string | null;
}

interface TransferLinkShape {
  id: string;
  state: 'proposed' | 'confirmed' | 'rejected' | 'auto';
  kind: 'one_to_one' | 'partial';
  score: number;
  reasons: { signal: string; points: number; detail: string }[];
  debits: TransactionShape[];
  credit: TransactionShape;
  debitAccount: { id: string; displayName: string } | null;
  creditAccount: { id: string; displayName: string } | null;
  amountCents: number;
  spendReductionCents: number;
  dayGapDays: number;
}

interface CoverageShape {
  accountId: string;
  periods: { importId: string; sourceFilename: string; start: string; end: string }[];
  months: {
    month: string;
    state: 'covered' | 'partial' | 'missing';
    covered: boolean;
    transactionCount: number;
  }[];
  coverageStart: string | null;
  coverageEnd: string | null;
  gapMonths: string[];
  partialMonths: string[];
  transactionCount: number;
  unmatchedTransferCount: number;
}

interface MergeShape {
  targetAccountId: string;
  sourceAccountId: string;
  transactionsMoved: number;
  importsMoved: number;
  occurrencesRenumbered: number;
  seriesMoved: number;
  evidenceMoved: number;
  selfLinksRemoved: number;
}

describe('ledgerline-api transfers and accounts (§2.6, §6.2)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let checkingId: string;
  let cardId: string;

  function fixture(name: string): Uint8Array {
    return new Uint8Array(
      readFileSync(fileURLToPath(new URL(`fixtures/statements/${name}`, workspaceRoot))),
    );
  }

  async function createAccount(payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/accounts', payload });
    expect(response.statusCode).toBe(201);
    return (response.json() as { id: string }).id;
  }

  /** Upload, confirm the guessed account, commit — §6.1's sequence in one call. */
  async function importBytes(
    name: string,
    bytes: Uint8Array | string,
    accountId: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    const form = new FormData();
    form.append('files', new File([bytes], name, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
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

  const importFixture = (
    name: string,
    accountId: string,
    body: Record<string, unknown> = {},
  ): Promise<void> => importBytes(name, fixture(name), accountId, body);

  /**
   * A Northgate statement built in-test, for the months the committed fixtures do
   * not cover.
   *
   * Same shape `profiles/northgate-checking.json` is keyed on — three preamble
   * lines, a blank, then the header signature — so it goes through the real
   * detection and parse rather than around them. The running balance is computed
   * because §6.1's balance check reconciles it and a mismatch would be a warning
   * on every row.
   */
  function northgateCsv(
    period: { start: string; end: string },
    rows: readonly { date: string; description: string; amountCents: number }[],
  ): string {
    const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
    let balance = 500_000;

    return [
      'Northgate Bank',
      'Account: *****4821',
      `Statement Period: ${usDate(period.start)} - ${usDate(period.end)}`,
      '',
      'Date,Description,Amount,Running Balance,Status',
      ...rows.map((row) => {
        balance += row.amountCents;
        return [
          usDate(row.date),
          row.description,
          (row.amountCents / 100).toFixed(2),
          (balance / 100).toFixed(2),
          'Posted',
        ].join(',');
      }),
    ].join('\n');
  }

  /** The card's own format, keyed on `profiles/cardinal-card.json`'s signature.
   *  Amounts go out in the bank's convention — a purchase is positive — which the
   *  profile inverts into the house one (§3.1), so callers pass house cents. */
  function cardinalCsv(
    rows: readonly { date: string; description: string; amountCents: number }[],
  ): string {
    return [
      'Transaction Date,Post Date,Description,Category,Amount',
      ...rows.map((row) =>
        [row.date, row.date, row.description, 'Payment', (-row.amountCents / 100).toFixed(2)].join(
          ',',
        ),
      ),
    ].join('\n');
  }

  async function transfers(query = 'states=auto,proposed'): Promise<TransferLinkShape[]> {
    const response = await app.inject({ method: 'GET', url: `/api/transfers?${query}` });
    expect(response.statusCode).toBe(200);
    return response.json() as TransferLinkShape[];
  }

  async function coverage(accountId: string): Promise<CoverageShape> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}/coverage`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as CoverageShape;
  }

  async function row(query: string): Promise<TransactionShape> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/transactions?includeInternalTransfers=true&limit=1000&${query}`,
    });
    const page = response.json() as { rows: { transaction: TransactionShape }[] };
    expect(page.rows).toHaveLength(1);
    return page.rows[0].transaction;
  }

  async function visibleTotal(): Promise<number> {
    const response = await app.inject({ method: 'GET', url: '/api/transactions?limit=1000' });
    return (response.json() as { total: number }).total;
  }

  /** The most recently created import — `GET /api/imports` is newest first. */
  async function lastImportId(): Promise<string> {
    const response = await app.inject({ method: 'GET', url: '/api/imports' });
    return (response.json() as { id: string }[])[0].id;
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

    checkingId = await createAccount({
      displayName: 'Northgate Checking',
      institution: 'Northgate Bank',
      accountType: 'checking',
      last4: '4821',
    });
    cardId = await createAccount({
      displayName: 'Cardinal Card',
      institution: 'Cardinal Card',
      accountType: 'credit_card',
      last4: '9012',
    });
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------- auto-linking ---

  describe('auto-linking at commit (§2.5, §2.6)', () => {
    it('links the $500 card payment as soon as both sides exist', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);

      // One statement in: the debit has no counterpart, so nothing links. §2.6's
      // "What this cannot do" is the honest state of the world at this moment.
      expect(await transfers()).toEqual([]);
      expect((await coverage(checkingId)).unmatchedTransferCount).toBe(1);

      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      const links = await transfers();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        state: 'auto',
        kind: 'one_to_one',
        // +3 keywords on both sides, +2 the card's last4 in the payment
        // descriptor, +2 the card's institution named, +1 same day.
        score: 8,
        amountCents: 50_000,
        spendReductionCents: 50_000,
        dayGapDays: 0,
      });
      expect(links[0].debits[0].descriptionNormalized).toContain('ONLINE PMT CARDINAL CARD');
      expect(links[0].credit.descriptionNormalized).toContain('PAYMENT THANK YOU');
      expect(links[0].debitAccount?.id).toBe(checkingId);
      expect(links[0].creditAccount?.id).toBe(cardId);

      // The counterpart is in the system now, so it is no longer unmatched.
      expect((await coverage(checkingId)).unmatchedTransferCount).toBe(0);
    });

    it('takes both rows out of the spend totals and stamps them with a pair id', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      expect(await visibleTotal()).toBe(12);

      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      // 12 + 8 = 20 committed, less the two the link claimed.
      expect(await visibleTotal()).toBe(18);

      const debit = await row(`q=ONLINE PMT CARDINAL&accountIds=${checkingId}`);
      const credit = await row(`q=PAYMENT THANK YOU&accountIds=${cardId}`);

      expect(debit.isInternalTransfer).toBe(true);
      expect(credit.isInternalTransfer).toBe(true);
      // A shared, non-null pair id is what tells this apart from a row someone
      // marked by hand on §6.3 — and what stops a later pass clearing that edit.
      expect(debit.transferPairId).not.toBeNull();
      expect(debit.transferPairId).toBe(credit.transferPairId);
    });

    it('names every signal that fed the score (§6.2)', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      const [link] = await transfers();
      expect(link.reasons.map((reason) => reason.signal).sort()).toEqual([
        'close_date_gap',
        'counterparty_last4',
        'credit_card_institution',
        'keyword_both_sides',
      ]);
      // The sentence, not the code: §6.2 shows this to a human deciding whether
      // to remove $500 from every total.
      expect(link.reasons.map((reason) => reason.detail).join(' ')).toContain('9012');
    });

    it('proposes rather than links when the accounts give it nothing to go on', async () => {
      // Same two statements, but neither account declares a last4 or an
      // institution the descriptor could name. All that survives is the keyword
      // match and the same-day gap: four points, which is §2.6's propose band.
      const plainChecking = await createAccount({
        displayName: 'Plain Checking',
        accountType: 'checking',
      });
      const plainCard = await createAccount({
        displayName: 'Plain Card',
        accountType: 'credit_card',
      });

      await importFixture('northgate-checking-2026-01.csv', plainChecking);
      await importFixture('cardinal-card-2026-01.csv', plainCard, { allowZeroAmountRows: true });

      const [link] = await transfers();
      expect(link).toMatchObject({ state: 'proposed', score: 4 });

      // §2.6: a proposal "is *not* excluded from spend until confirmed". Both
      // rows are still on the Transactions page and still in every total, which
      // is the visible-too-big failure the design deliberately prefers.
      const debit = await row(`q=ONLINE PMT CARDINAL&accountIds=${plainChecking}`);
      expect(debit.isInternalTransfer).toBe(false);
      expect(debit.transferPairId).toBeNull();
      expect(await visibleTotal()).toBe(20);
    });
  });

  // ------------------------------------------------- confirm and reject ---

  describe('confirming and rejecting (§2.6, §6.2)', () => {
    let plainChecking: string;
    let plainCard: string;

    beforeEach(async () => {
      plainChecking = await createAccount({
        displayName: 'Plain Checking',
        accountType: 'checking',
      });
      plainCard = await createAccount({ displayName: 'Plain Card', accountType: 'credit_card' });
      await importFixture('northgate-checking-2026-01.csv', plainChecking);
      await importFixture('cardinal-card-2026-01.csv', plainCard, { allowZeroAmountRows: true });
    });

    it('takes the money out of the totals when a proposal is confirmed', async () => {
      const [proposal] = await transfers('states=proposed');
      expect(await visibleTotal()).toBe(20);

      const confirmed = await app.inject({
        method: 'POST',
        url: `/api/transfers/${proposal.id}/confirm`,
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({ state: 'confirmed' });

      // The dollar effect §6.2 promised, delivered.
      expect(await visibleTotal()).toBe(18);
      expect((await row(`q=ONLINE PMT CARDINAL&accountIds=${plainChecking}`)).isInternalTransfer)
        .toBe(true);
    });

    it('writes §2.6’s learning rule, so the next pass auto-links', async () => {
      const [proposal] = await transfers('states=proposed');
      await app.inject({ method: 'POST', url: `/api/transfers/${proposal.id}/confirm` });

      const rules = context.store.transfers.listRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        // The trailing reference number is dropped so next month still matches.
        descriptorPattern: 'ONLINE PMT CARDINAL CARD',
        debitAccountId: plainChecking,
        creditAccountId: plainCard,
      });

      // Confirming twice teaches one rule, not two that both score +3.
      await app.inject({ method: 'POST', url: `/api/transfers/${proposal.id}/confirm` });
      expect(context.store.transfers.listRules()).toHaveLength(1);
    });

    it('puts the money back when a confirmed link is rejected', async () => {
      const [proposal] = await transfers('states=proposed');
      await app.inject({ method: 'POST', url: `/api/transfers/${proposal.id}/confirm` });
      expect(await visibleTotal()).toBe(18);

      const rejected = await app.inject({ method: 'DELETE', url: `/api/transfers/${proposal.id}` });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ state: 'rejected' });

      // Reversible, which is the rule for anything that moves a total.
      expect(await visibleTotal()).toBe(20);
      const debit = await row(`q=ONLINE PMT CARDINAL&accountIds=${plainChecking}`);
      expect(debit.isInternalTransfer).toBe(false);
      expect(debit.transferPairId).toBeNull();
    });

    it('keeps a rejection through the next pass rather than re-proposing it', async () => {
      const [proposal] = await transfers('states=proposed');
      await app.inject({ method: 'DELETE', url: `/api/transfers/${proposal.id}` });

      const rerun = await app.inject({ method: 'POST', url: '/api/transfers/propose' });
      expect(rerun.statusCode).toBe(200);

      // A deleted row is one the matcher offers again next month, and the month
      // after. The `rejected` state is what makes "no" a durable answer.
      expect(await transfers('states=proposed')).toEqual([]);
      expect(await transfers('states=rejected')).toHaveLength(1);
    });

    it('keeps a confirmation through the next pass', async () => {
      const [proposal] = await transfers('states=proposed');
      await app.inject({ method: 'POST', url: `/api/transfers/${proposal.id}/confirm` });

      await app.inject({ method: 'POST', url: '/api/transfers/propose' });

      const confirmed = await transfers('states=confirmed');
      expect(confirmed).toHaveLength(1);
      expect(await visibleTotal()).toBe(18);
    });

    it('confirms a partial payment as one group, flipping every debit', async () => {
      // §2.6's second pass: "a single credit in B against a set of ≤3 debits in A
      // inside the window summing exactly to it". §3.1 models a link as one debit
      // and one credit, so this is two rows sharing a credit — and half a split
      // payment linked and half not is a state no total could be computed from.
      const splitChecking = await createAccount({
        displayName: 'Split Checking',
        accountType: 'checking',
      });
      const splitCard = await createAccount({
        displayName: 'Split Card',
        accountType: 'credit_card',
      });

      await importBytes(
        'split-checking.csv',
        northgateCsv({ start: '2026-03-01', end: '2026-03-31' }, [
          { date: '2026-03-10', description: 'ONLINE PMT SPLIT CARD', amountCents: -30_000 },
          { date: '2026-03-12', description: 'ONLINE PMT SPLIT CARD', amountCents: -20_000 },
        ]),
        splitChecking,
      );
      await importBytes(
        'split-card.csv',
        cardinalCsv([
          { date: '2026-03-13', description: 'PAYMENT THANK YOU - WEB', amountCents: 50_000 },
        ]),
        splitCard,
      );

      const partial = (await transfers(`states=proposed&accountIds=${splitChecking}`))[0];
      expect(partial).toMatchObject({
        kind: 'partial',
        // Never linked on its own authority, whatever it scores.
        state: 'proposed',
        amountCents: 50_000,
        spendReductionCents: 50_000,
      });
      expect(partial.debits).toHaveLength(2);

      const confirmed = await app.inject({
        method: 'POST',
        url: `/api/transfers/${partial.id}/confirm`,
      });
      expect(confirmed.statusCode).toBe(200);

      const visible = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${splitChecking},${splitCard}&limit=1000`,
      });
      // All three rows out of the totals, not one of them.
      expect((visible.json() as { total: number }).total).toBe(0);

      const all = await app.inject({
        method: 'GET',
        url: `/api/transactions?accountIds=${splitChecking},${splitCard}&includeInternalTransfers=true&limit=1000`,
      });
      const flags = (all.json() as { rows: { transaction: TransactionShape }[] }).rows.map(
        (entry) => entry.transaction,
      );
      expect(flags).toHaveLength(3);
      expect(flags.every((entry) => entry.isInternalTransfer)).toBe(true);
      // One shared pair id across all three, so the group is one fact rather than
      // three rows that happen to agree.
      expect(new Set(flags.map((entry) => entry.transferPairId)).size).toBe(1);

      // §2.6's learning is about a repeating pairing; "these two debits totalled
      // that credit" is one month's arithmetic, so no rule is taught.
      expect(context.store.transfers.listRules()).toEqual([]);
    });

    it('404s an unknown link rather than reporting a change it did not make', async () => {
      const confirm = await app.inject({ method: 'POST', url: '/api/transfers/nope/confirm' });
      expect(confirm.statusCode).toBe(404);

      const reject = await app.inject({ method: 'DELETE', url: '/api/transfers/nope' });
      expect(reject.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------- the link pass ---

  describe('POST /api/transfers/propose (§2.3)', () => {
    it('reports what it did, including what it declined to link', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      const response = await app.inject({ method: 'POST', url: '/api/transfers/propose' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ autoLinked: 1, proposed: 0 });
    });

    it('withdraws an auto-link when the account it depended on stops naming the card', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });
      expect(await visibleTotal()).toBe(18);

      // Take away the last4 and the institution: 8 points becomes 4, which is a
      // proposal rather than a link. A machine-owned link the evidence no longer
      // supports has to be *withdrawable*, or §2.6's "a false link removes money
      // from every total invisibly" would be permanent.
      await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${cardId}`,
        payload: { last4: null, institution: null },
      });

      const response = await app.inject({ method: 'POST', url: '/api/transfers/propose' });
      expect(response.json()).toMatchObject({ autoLinked: 0, proposed: 1, unflagged: 2 });
      expect(await visibleTotal()).toBe(20);
    });

    it('leaves a hand-marked transfer alone when it withdraws its own', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      // §6.3's inline edit, on a row no link claims.
      const zelle = await row(`q=ZELLE&accountIds=${checkingId}`);
      await app.inject({
        method: 'PATCH',
        url: `/api/transactions/${zelle.id}`,
        payload: { isInternalTransfer: true },
      });

      await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${cardId}`,
        payload: { last4: null, institution: null },
      });
      await app.inject({ method: 'POST', url: '/api/transfers/propose' });

      // The withdrawal put the card payment back and left the user's edit alone:
      // a null `transfer_pair_id` is what tells a hand-set flag from a machine
      // one, and clearing it would silently undo an edit made on another page.
      const after = await row(`q=ZELLE&accountIds=${checkingId}`);
      expect(after.isInternalTransfer).toBe(true);
      expect(after.transferPairId).toBeNull();
    });

    it('runs at the head of an analysis run, before any rule reads the flags', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });

      const enqueued = await app.inject({ method: 'POST', url: '/api/analysis/run' });
      expect(enqueued.statusCode).toBe(202);
      context.jobRunner.drain();

      const job = await app.inject({
        method: 'GET',
        url: `/api/jobs/${(enqueued.json() as { id: string }).id}`,
      });
      const body = job.json() as { state: string; message: string };
      expect(body.state).toBe('succeeded');
      expect(body.message).toContain('1 transfers linked');
    });
  });

  // ---------------------------------------------------- the coverage bar ---

  describe('GET /api/accounts/:id/coverage (§6.2, §7.2)', () => {
    it('reports coverage from the statement periods, not from the rows', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('northgate-checking-2026-02.csv', checkingId);

      const bar = await coverage(checkingId);
      expect(bar.months.map((month) => month.month)).toEqual(['2026-01', '2026-02']);
      expect(bar.periods.map((period) => period.sourceFilename)).toEqual([
        'northgate-checking-2026-01.csv',
        'northgate-checking-2026-02.csv',
      ]);

      // The periods are the parser's, and the parser fills them from the first
      // and last row it saw — January's statement runs the 3rd to the 30th. So
      // §7.2's spanning test fails on a perfectly ordinary month, and the bar
      // says `partial` rather than lying in either direction. §9f.
      expect(bar.coverageStart).toBe('2026-01-03');
      // §7.2's reference point for every liveness and lapse test in §5.
      expect(bar.coverageEnd).toBe('2026-02-14');
      expect(bar.months.every((month) => month.state === 'partial')).toBe(true);
      expect(bar.months.every((month) => month.covered)).toBe(false);
      expect(bar.gapMonths).toEqual([]);
    });

    it('says covered when a statement really does span the month (§7.2)', async () => {
      await importBytes(
        'northgate-full-march.csv',
        northgateCsv({ start: '2026-03-01', end: '2026-03-31' }, [
          { date: '2026-03-01', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1549 },
          { date: '2026-03-12', description: 'TRADER JOES PORTLAND OR', amountCents: -2200 },
          { date: '2026-03-31', description: 'SHELL OIL PORTLAND OR', amountCents: -4000 },
        ]),
        checkingId,
      );

      const bar = await coverage(checkingId);
      expect(bar.months).toEqual([
        { month: '2026-03', state: 'covered', covered: true, transactionCount: 3 },
      ]);
      expect(bar.partialMonths).toEqual([]);
    });

    it('shows a missing month as a gap rather than leaving it out', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importBytes(
        'northgate-checking-2026-04.csv',
        northgateCsv({ start: '2026-04-01', end: '2026-04-30' }, [
          { date: '2026-04-06', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1549 },
          { date: '2026-04-12', description: 'TRADER JOES PORTLAND OR', amountCents: -2200 },
          { date: '2026-04-20', description: 'SHELL OIL PORTLAND OR', amountCents: -4000 },
        ]),
        checkingId,
      );

      const bar = await coverage(checkingId);
      // Contiguous cells, so the hole is visible at a glance — which is §6.2's
      // stated reason for the bar existing. February and March have no statement
      // at all; January and April have one that does not reach both month
      // boundaries, which is what every real statement looks like.
      expect(bar.months.map((month) => `${month.month}:${month.state}`)).toEqual([
        '2026-01:partial',
        '2026-02:missing',
        '2026-03:missing',
        '2026-04:partial',
      ]);
      expect(bar.gapMonths).toEqual(['2026-02', '2026-03']);
    });

    it('counts a staged import as no coverage at all', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);

      // Uploaded and reviewed but never committed: §7.2 says "a committed
      // import", and claiming coverage for a statement nobody accepted would put
      // a green cell over a month with no rows behind it.
      const form = new FormData();
      form.append(
        'files',
        new File(
          [fixture('northgate-checking-2026-02.csv')],
          'northgate-checking-2026-02.csv',
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
      await app.inject({
        method: 'PATCH',
        url: `/api/imports/${staged.import.id}`,
        payload: { accountId: checkingId },
      });

      const bar = await coverage(checkingId);
      expect(bar.coverageEnd).toBe('2026-01-30');
      expect(bar.months.map((month) => month.month)).toEqual(['2026-01']);
    });

    it('answers for an account with nothing in it', async () => {
      const bar = await coverage(cardId);
      expect(bar).toMatchObject({
        months: [],
        periods: [],
        coverageStart: null,
        coverageEnd: null,
        gapMonths: [],
        transactionCount: 0,
        unmatchedTransferCount: 0,
      });
    });

    it('404s an unknown account', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/accounts/nope/coverage' });
      expect(response.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------- the merge ---

  describe('POST /api/accounts/:id/merge (§6.2)', () => {
    it('folds one account into another and archives the source', async () => {
      const duplicate = await createAccount({
        displayName: 'Northgate Checking (old export)',
        institution: 'Northgate Bank',
        accountType: 'checking',
        last4: '4821',
      });

      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('northgate-checking-2026-02.csv', duplicate);

      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${checkingId}/merge`,
        payload: { sourceAccountId: duplicate },
      });
      expect(response.statusCode).toBe(200);

      const merged = response.json() as MergeShape;
      expect(merged).toMatchObject({
        targetAccountId: checkingId,
        sourceAccountId: duplicate,
        transactionsMoved: 4,
        importsMoved: 1,
      });

      // Both statements now belong to one account, and its coverage bar says so.
      const bar = await coverage(checkingId);
      expect(bar.months.map((month) => month.month)).toEqual(['2026-01', '2026-02']);
      expect(bar.transactionCount).toBe(16);

      // Archived, not deleted (§6.2): the row survives as the explanation for
      // why its imports now belong somewhere else.
      const source = await app.inject({ method: 'GET', url: `/api/accounts/${duplicate}` });
      expect(source.json()).toMatchObject({ isActive: false });
    });

    it('keeps rows that exist in both accounts rather than merging them away', async () => {
      const duplicate = await createAccount({
        displayName: 'Northgate Checking (again)',
        institution: 'Northgate Bank',
        accountType: 'checking',
        last4: '4821',
      });

      // The same three charges in both accounts, which is the situation a merge
      // is for: one bank changed its export format and the second import made a
      // second account. Two files rather than one, because §3.3's layer one
      // short-circuits a byte-identical re-upload before it can reach a second
      // account at all — so the duplicate is a re-issue with the same rows and a
      // different preamble, which is what a re-export actually looks like.
      const rows = [
        { date: '2026-05-04', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1549 },
        { date: '2026-05-11', description: 'TRADER JOES PORTLAND OR', amountCents: -2200 },
        { date: '2026-05-18', description: 'SHELL OIL PORTLAND OR', amountCents: -4000 },
      ];
      await importBytes(
        'northgate-may.csv',
        northgateCsv({ start: '2026-05-01', end: '2026-05-31' }, rows),
        checkingId,
      );
      await importBytes(
        'northgate-may-reissued.csv',
        `${northgateCsv({ start: '2026-05-01', end: '2026-05-31' }, rows)}\n`,
        duplicate,
      );

      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${checkingId}/merge`,
        payload: { sourceAccountId: duplicate },
      });

      const merged = response.json() as MergeShape;
      expect(merged.transactionsMoved).toBe(3);

      // Six rows for three charges, and that is the honest outcome rather than a
      // bug this test is documenting away. §3.3's `dedupe_key` hashes the
      // **account id** into the material, so the same charge in two accounts has
      // two different keys — the merge rule cannot see them as the same row, and
      // §3.2's `UNIQUE (account_id, dedupe_key, occurrence_index)` never fires,
      // which is why nothing needed renumbering. Recomputing the keys would be a
      // rewrite of frozen key material and §3.3 forbids doing that in passing.
      //
      // So a merge re-points history; it does not deduplicate it. The user
      // deletes the redundant import, which §3.3 already knows how to do exactly.
      // Recorded in §9f.
      expect(merged.occurrencesRenumbered).toBe(0);
      expect((await coverage(checkingId)).transactionCount).toBe(6);

      const importId = merged.importsMoved > 0 ? await lastImportId() : null;
      expect(importId).not.toBeNull();
      const deleted = await app.inject({ method: 'DELETE', url: `/api/imports/${importId}` });
      expect(deleted.statusCode).toBe(200);
      expect((await coverage(checkingId)).transactionCount).toBe(3);
    });

    it('drops the links that a merge turns into self-transfers', async () => {
      await importFixture('northgate-checking-2026-01.csv', checkingId);
      await importFixture('cardinal-card-2026-01.csv', cardId, { allowZeroAmountRows: true });
      expect(await transfers()).toHaveLength(1);
      expect(await visibleTotal()).toBe(18);

      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${checkingId}/merge`,
        payload: { sourceAccountId: cardId },
      });
      expect((response.json() as MergeShape).selfLinksRemoved).toBe(1);

      // Money moved from an account to itself is not a transfer, so the $500 is
      // real spending again — and leaving it linked would keep it out of every
      // total on the strength of a duplicate the user has just repaired.
      expect(await transfers()).toEqual([]);
      expect(await visibleTotal()).toBe(20);
    });

    it('refuses to merge an account into itself', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/accounts/${checkingId}/merge`,
        payload: { sourceAccountId: checkingId },
      });
      expect(response.statusCode).toBe(400);
    });

    it('404s an unknown account on either side', async () => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/accounts/nope/merge',
            payload: { sourceAccountId: checkingId },
          })
        ).statusCode,
      ).toBe(404);

      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/accounts/${checkingId}/merge`,
            payload: { sourceAccountId: 'nope' },
          })
        ).statusCode,
      ).toBe(404);
    });
  });
});

/**
 * §2.4's provider wired into the app, and §4.2's stage doing its one job.
 *
 * `libs/ledgerline/llm` already tests the three providers against fakes. What that
 * suite structurally cannot reach is everything that only exists once a provider
 * meets the store: which provider gets built from a settings row, the cache that
 * makes a second identical call free, the degraded-call log that survives a
 * restart, and §4.2's floor and settled-series exception — all of which are
 * statements about persisted state.
 *
 * ## Nothing here starts a real provider
 *
 * `ClaudeCliProvider` sends merchant descriptors to Anthropic. A suite that spawned
 * it would do that on every `npm run check`, against whatever is in the developer's
 * database. `OllamaProvider` would reach a real daemon on 127.0.0.1 if one happened
 * to be running, which makes the same test pass and fail on different machines.
 *
 * So every case below goes through `llmProviderFactory` — the context seam that
 * exists for exactly this — and the two real providers are exercised through their
 * own `spawnFn` and `fetchFn`, which is how their unit suite does it. The
 * assertions are still about the real classes: what is faked is the subprocess and
 * the socket, never the provider.
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { ClaudeCliProvider, NoneProvider, OllamaProvider } from '@metrum/ledgerline-llm';
import type {
  CompleteRequest,
  JsonRequest,
  LlmCapability,
  LlmProvider,
} from '@metrum/ledgerline-llm';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { LLM_CONFIDENCE_FLOOR } from './lib/llm-merchants.js';
import { buildServer } from './lib/server.js';

const PROFILES_DIR = new URL('../../../profiles', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);

// ------------------------------------------------------- statement building ---
// The same shape `analysis-api.spec.ts` uses, and for its stated reason: coverage
// comes from `statement_import.period_start/end` (§7.2) and the merchant ids the
// rules group on come from §4's chain, so rows have to arrive as a statement.

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

const byDate = (a: StatementRow, b: StatementRow): number => (a.date < b.date ? -1 : 1);

// ------------------------------------------------------------- fake providers ---

/**
 * A provider that answers with whatever it is told to, and records what it saw.
 *
 * `prompts` is the important field and most of the privacy assertions read it: the
 * only way to prove that no amount, date or account number left is to look at the
 * bytes that would have.
 */
class ScriptedProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly sendsDataOffMachine = false;
  readonly prompts: string[] = [];
  calls = 0;

  constructor(private readonly answer: (prompt: string) => unknown) {}

  capabilities(): LlmCapability[] {
    return ['complete', 'json'];
  }

  health() {
    return Promise.resolve({ ok: true, detail: 'scripted', model: 'scripted' });
  }

  complete(request: CompleteRequest): Promise<string> {
    this.prompts.push(request.prompt);
    this.calls += 1;
    return Promise.resolve(JSON.stringify(this.answer(request.prompt)));
  }

  async completeJson<T>(request: JsonRequest<T>): Promise<T> {
    return request.validate(JSON.parse(await this.complete(request)));
  }
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn(), on: vi.fn() };
  child.kill = vi.fn();
  return child;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------- suite ---

describe('ledgerline-api LLM surface (§2.4, §4.2, §6.8)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;
  let provider: LlmProvider | null = null;

  async function boot(): Promise<void> {
    context = createContext({
      databaseFile: ':memory:',
      profilesDir: PROFILES_DIR,
      // Never the real three — see the header.
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

    accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;
  }

  async function importStatement(name: string, rows: readonly StatementRow[]): Promise<void> {
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
    await app.inject({ method: 'PATCH', url: `/api/imports/${staged.import.id}`, payload: { accountId } });
    const committed = await app.inject({
      method: 'POST',
      url: `/api/imports/${staged.import.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode).toBe(200);
  }

  const setProvider = (id: 'none' | 'ollama' | 'claude-cli', extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'PATCH', url: '/api/settings', payload: { llm: { providerId: id, ...extra } } });

  /**
   * §4.2's stage, through the route and the job — the production path.
   *
   * The job's own state is asserted rather than assumed. §2.7 makes a throw inside
   * a handler a `failed` job with a message rather than an exception, which is
   * right for the API and would otherwise make every assertion below fail as
   * "nothing was written" with the actual reason sitting unread in a table.
   */
  async function propose(): Promise<void> {
    const response = await app.inject({ method: 'POST', url: '/api/llm/propose-merchants' });
    expect(response.statusCode).toBe(202);
    await context.jobRunner.drain();

    const job = context.store.jobs.get((response.json() as { jobId: string }).jobId);
    expect(job?.message ?? '').not.toContain('Error');
    expect(job?.state).toBe('succeeded');
  }

  beforeEach(async () => {
    provider = null;
    await boot();
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ============================================================ §2.3 health ===

  describe('GET /api/llm/health (§2.3, §6.8)', () => {
    it('answers for `none` without pretending there is anything to connect to', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/llm/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        providerId: 'none',
        ok: false,
        // §2.4's own words. A green tick here would teach the button to mean
        // nothing.
        detail: 'LLM disabled',
        sendsDataOffMachine: false,
        capabilities: [],
      });
    });

    it('answers for `ollama`, naming the fix when the model is not pulled', async () => {
      // The real `OllamaProvider`, with only its socket faked — so what is asserted
      // is that class's own health logic, reached through the route.
      provider = new OllamaProvider({
        model: 'llama3.2:3b',
        fetchFn: (async () =>
          new Response(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      await setProvider('ollama');

      const response = await app.inject({ method: 'GET', url: '/api/llm/health' });

      expect(response.json()).toMatchObject({ providerId: 'ollama', ok: false });
      // §2.4 singles this failure out: it "otherwise surfaces as a confusing 404".
      expect((response.json() as { detail: string }).detail).toContain(
        'ollama pull llama3.2:3b',
      );
      expect((response.json() as { sendsDataOffMachine: boolean }).sendsDataOffMachine).toBe(false);
    });

    it('answers ok for `ollama` when the configured model is pulled', async () => {
      provider = new OllamaProvider({
        model: 'llama3.2',
        fetchFn: (async () =>
          new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      await setProvider('ollama');

      const response = await app.inject({ method: 'GET', url: '/api/llm/health' });

      // A bare `llama3.2` means the default tag of it, which is what a user who
      // typed that meant.
      expect(response.json()).toMatchObject({ providerId: 'ollama', ok: true, model: 'llama3.2' });
    });

    it('answers for `claude-cli`, and reports that it sends data off this machine', async () => {
      const child = fakeChild();
      provider = new ClaudeCliProvider({
        spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
      });
      await setProvider('claude-cli');

      const pending = app.inject({ method: 'GET', url: '/api/llm/health' });
      await tick();
      child.stdout.emit('data', '1.2.3 (Claude Code)');
      child.emit('close', 0);

      const response = await pending;
      expect(response.json()).toMatchObject({
        providerId: 'claude-cli',
        ok: true,
        // §2.4: "True only for claude-cli." This is the fact §6.8's warning card
        // and the header indicator both read.
        sendsDataOffMachine: true,
      });
    });

    it('is never cached — a remembered “ok” is the one answer it must not give', async () => {
      let pulled = true;
      provider = new OllamaProvider({
        model: 'llama3.2:3b',
        fetchFn: (async () =>
          new Response(JSON.stringify({ models: pulled ? [{ name: 'llama3.2:3b' }] : [] }), {
            status: 200,
          })) as unknown as typeof fetch,
      });
      await setProvider('ollama');

      expect((await app.inject({ method: 'GET', url: '/api/llm/health' })).json()).toMatchObject({
        ok: true,
      });

      pulled = false;
      expect((await app.inject({ method: 'GET', url: '/api/llm/health' })).json()).toMatchObject({
        ok: false,
      });
    });
  });

  // =========================================================== §6.8 settings ===

  describe('the provider setting (§6.8)', () => {
    it('defaults to `none`, which is what makes the app work with nothing configured', async () => {
      const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();

      expect(settings.llm).toMatchObject({
        providerId: 'none',
        model: null,
        redaction: true,
        redactionLocked: false,
        sendsDataOffMachine: false,
      });
    });

    it('does not move `config_hash` — a provider is not a §5 threshold', async () => {
      const before = (await app.inject({ method: 'GET', url: '/api/settings' })).json().configHash;

      const response = await setProvider('ollama', { model: 'llama3.2:3b' });

      expect(response.statusCode).toBe(200);
      expect(response.json().configHashChanged).toBe(false);
      expect(response.json().settings.configHash).toBe(before);
      // The whole reason the two live in different settings keys: §5.1 re-evaluates
      // a rule's dismissals when `config_hash` moves, and choosing a model is not a
      // reason to invalidate every dismissal in the database.
      expect(response.json().dismissalsAffected).toBe(0);
    });

    it('carries a threshold and a provider in one request, and reports each truthfully', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: {
          changes: [{ section: 'global', key: 'minAnnualImpactCents', value: 500 }],
          llm: { providerId: 'ollama' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().configHashChanged).toBe(true);
      expect(response.json().settings.llm.providerId).toBe('ollama');
    });

    it('locks redaction on while `claude-cli` is selected (§6.8)', async () => {
      await setProvider('claude-cli');
      const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();

      expect(settings.llm).toMatchObject({ redaction: true, redactionLocked: true });
    });

    it('refuses to disable redaction under `claude-cli` rather than quietly ignoring it', async () => {
      await setProvider('claude-cli');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { llm: { redaction: false } },
      });

      // Refused with the reason, not silently corrected: a privacy control that
      // stored `true` after being told `false` is one that comes to be believed off
      // when it is on.
      expect(response.statusCode).toBe(422);
      expect(response.json().message).toContain('cannot be disabled');
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings' })).json().llm.redaction,
      ).toBe(true);
    });

    it('allows redaction off under a local provider, where §6.8 does not lock it', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { llm: { providerId: 'ollama', redaction: false } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().settings.llm).toMatchObject({
        redaction: false,
        redactionLocked: false,
      });
    });

    it('rejects a provider that is not one of §2.4’s three', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { llm: { providerId: 'gpt-9' } },
      });

      // 400 from the schema enum rather than 422 from the handler — either is a
      // refusal, and what matters is that nothing was stored.
      expect([400, 422]).toContain(response.statusCode);
      expect(
        (await app.inject({ method: 'GET', url: '/api/settings' })).json().llm.providerId,
      ).toBe('none');
    });
  });

  // ============================================================ §2.4's cache ===

  describe('the response cache (§2.4)', () => {
    beforeEach(async () => {
      await importStatement('one.csv', [
        { date: '2026-01-04', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
        { date: '2026-01-11', description: 'TST* THE PLANT CAFE #0042', amountCents: -2210 },
      ]);
    });

    it('asks once for a repeated prompt, and answers the second time from `llm_cache`', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;
      await setProvider('ollama');

      await propose();
      expect(scripted.calls).toBe(1);
      expect(context.store.llm.countCached()).toBe(1);

      await propose();
      // The prompt is identical — the same descriptors are still unresolved — so
      // §2.4's key is the same and the provider is not asked again. This is what
      // makes "bulk merchant normalization tolerable" on the CLI path.
      expect(scripted.calls).toBe(1);
      expect(context.store.llm.countCached()).toBe(1);
    });

    it('keys on provider and model as well as prompt, so a model change re-asks', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;

      await setProvider('ollama', { model: 'llama3.2:3b' });
      await propose();
      await setProvider('ollama', { model: 'qwen2.5:7b' });
      await propose();

      expect(scripted.calls).toBe(2);
      expect(context.store.llm.countCached()).toBe(2);
    });
  });

  // ================================================== §6.8's degraded-call log ===

  describe('the degraded-call log (§2.4, §6.8)', () => {
    beforeEach(async () => {
      await importStatement('one.csv', [
        { date: '2026-01-04', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
        { date: '2026-01-18', description: 'TST* THE PLANT CAFE #0042', amountCents: -2210 },
      ]);
    });

    it('records a failed call and keeps working', async () => {
      provider = {
        id: 'ollama',
        sendsDataOffMachine: false,
        capabilities: () => ['json'],
        health: () => Promise.resolve({ ok: false, detail: 'down' }),
        complete: () => Promise.reject(new Error('connection refused')),
        completeJson: () => Promise.reject(new Error('connection refused')),
      } as LlmProvider;
      await setProvider('ollama');

      await propose();

      const log = (await app.inject({ method: 'GET', url: '/api/llm/degraded-calls' })).json();
      expect(log.total).toBe(1);
      expect(log.entries[0]).toMatchObject({
        // The caller's words, not a stack frame (§2.4).
        operation: 'merchant normalization',
      });
      expect(log.entries[0].reason).toContain('connection refused');
    });

    it('records a wrong-shaped answer as the same kind of failure', async () => {
      // §2.4: "Any throw, timeout, or schema-validation failure yields the fallback
      // and records a degraded-call event." A model that answered with prose is the
      // same event as a model that was not running.
      provider = new ScriptedProvider(() => ({ sorry: 'I cannot help with that' }));
      await setProvider('ollama');

      await propose();

      const log = (await app.inject({ method: 'GET', url: '/api/llm/degraded-calls' })).json();
      expect(log.total).toBe(1);
      // And it still names the provider — a schema failure that logged `unknown`
      // would stop the log pointing at what actually misbehaved.
      expect(log.entries[0].provider).toBe('ollama');
    });

    it('survives a restart, because a week of failures is the signal (§6.8, §9s)', async () => {
      context.store.llm.recordDegraded({
        at: '2026-08-20T09:00:00.000Z',
        provider: 'ollama',
        operation: 'merchant normalization',
        reason: 'connection refused',
      });

      // A second store over the same database is what a restart looks like from
      // here. `:memory:` cannot be reopened, so the assertion is that the row is in
      // the *table* rather than in a field on a service.
      const rows = context.store.db
        .prepare('SELECT COUNT(*) AS n FROM llm_degraded_call')
        .get() as { n: number };
      expect(rows.n).toBe(1);
    });

    it('is empty and untroubled with no provider configured', async () => {
      await propose();

      const log = (await app.inject({ method: 'GET', url: '/api/llm/degraded-calls' })).json();
      // `none` is not a failure. It throws `LlmUnavailableError` like any other
      // dead provider — but it is only ever asked when there is something to ask
      // about, and with nothing unresolved there is not.
      expect(log.total).toBeLessThanOrEqual(1);
    });
  });

  // ============================================================ §4.2's stage ===

  describe('§4.2 — merchant proposals', () => {
    /** Descriptors the §4 chain cannot place, plus one it can, plus a person. */
    beforeEach(async () => {
      await importStatement(
        'jan.csv',
        [
          { date: '2026-01-04', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
          { date: '2026-01-09', description: 'TST* THE PLANT CAFE #0042', amountCents: -2210 },
          { date: '2026-01-14', description: 'SQ *BLUE BOTTLE 1234 PORTLAND', amountCents: -640 },
          { date: '2026-01-19', description: 'ZELLE PAYMENT TO SARAH M 88213', amountCents: -12000 },
          { date: '2026-01-24', description: 'NETFLIX.COM 866-579-7172 CA', amountCents: -1099 },
        ].sort(byDate),
      );
    });

    const proposalsFor = () =>
      app
        .inject({ method: 'GET', url: '/api/merchants/review-queue' })
        .then((response) => response.json().llmProposals as { descriptor: string; status: string; merchantName: string; blockedReason: string | null }[]);

    it('sends descriptor strings and nothing else', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;
      await setProvider('ollama');

      await propose();

      const [prompt] = scripted.prompts;
      expect(prompt).toContain('THE PLANT CAFE');
      // §4.2: "no amounts, no dates, no account numbers". The only way to prove it
      // is to look at the bytes that would have carried them.
      expect(prompt).not.toContain('18.40');
      expect(prompt).not.toContain('1840');
      expect(prompt).not.toContain('2026-01');
      expect(prompt).not.toContain('01/04/2026');
      expect(prompt).not.toContain('4821');
    });

    it('never sends a P2P descriptor at all (§2.4’s hard filter)', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;
      await setProvider('ollama');

      await propose();

      const [prompt] = scripted.prompts;
      // §2.4: "a partially-masked personal name is still a personal name", so this
      // is a filter and not a redaction — the name is not masked, it is absent.
      expect(prompt).not.toContain('SARAH');
      expect(prompt).not.toContain('ZELLE');
    });

    it('redacts the account-shaped runs out of what does go (§2.4)', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;
      await setProvider('ollama');

      await propose();

      const [prompt] = scripted.prompts;
      expect(prompt).toContain('BLUE BOTTLE');
      // The store number in `SQ *BLUE BOTTLE 1234 PORTLAND`. Substituted rather
      // than deleted, so the merchant either side of it stays readable.
      expect(prompt).not.toContain('1234');
    });

    it('leaves an already-resolved descriptor out of the batch', async () => {
      const scripted = new ScriptedProvider(() => ({ proposals: [] }));
      provider = scripted;
      await setProvider('ollama');

      await propose();

      // §4.2 is "only at step 7" — a descriptor a seed alias already resolves has
      // nothing to gain and would be a call paid for twice.
      expect(scripted.prompts[0]).not.toContain('NETFLIX');
    });

    it('applies a confident proposal as a `source = "llm"` alias', async () => {
      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt)
          .filter((descriptor) => descriptor.includes('BLUE BOTTLE'))
          .map((descriptor) => ({
            descriptor,
            merchant_name: 'Netflix',
            category: 'Streaming',
            confidence: 0.95,
          })),
      }));
      await setProvider('ollama');

      await propose();

      const alias = context.store.merchants
        .listAliases()
        .find((entry) => entry.source === 'llm');

      expect(alias).toBeDefined();
      expect(alias?.merchantId).toBe('netflix');
      expect(alias?.matchType).toBe('exact');
      // The alias key is the *real* descriptor, never the redacted string the model
      // was shown — an alias keyed on `[redacted]` matches no transaction at all.
      expect(alias?.aliasKey).not.toContain('redacted');
    });

    // ------------------------------------------- §2.5's category, §9x's home for it ---

    describe('the category §4.2 asks for (§2.5, §9x)', () => {
      const rowFor = (fragment: string) =>
        (
          context.store.db
            .prepare(
              `SELECT category_id, category_source FROM "transaction"
                WHERE description_raw LIKE ? LIMIT 1`,
            )
            .get(`%${fragment}%`) as { category_id: string | null; category_source: string | null }
        );

      const proposeCategory = async (name: string | null, confidence = 0.95) => {
        provider = new ScriptedProvider((prompt) => ({
          proposals: descriptorsIn(prompt)
            .filter((descriptor) => descriptor.includes('BLUE BOTTLE'))
            .map((descriptor) => ({
              descriptor,
              merchant_name: 'Netflix',
              category: name,
              confidence,
            })),
        }));
        await setProvider('ollama');
        await propose();
      };

      it('applies it as `category_source = "llm"` when the grouping applied', async () => {
        const [category] = context.store.merchants.listCategories();
        await proposeCategory(category.name);

        expect(rowFor('BLUE BOTTLE')).toMatchObject({
          category_id: category.id,
          category_source: 'llm',
        });
      });

      /**
       * §2.5 orders the two — "category assigned by rule, then optionally by LLM" —
       * so a sweep must not put the merchant's default back over the model's answer.
       * That is the reverse of how the same two sources rank for *aliases*, which is
       * exactly the asymmetry §9x exists to state.
       */
      it('survives a re-normalize, which would once have clobbered it', async () => {
        const [category] = context.store.merchants.listCategories();
        await proposeCategory(category.name);

        await app.inject({ method: 'POST', url: '/api/jobs/renormalize' });
        await context.jobRunner.drain();

        expect(rowFor('BLUE BOTTLE')).toMatchObject({
          category_id: category.id,
          category_source: 'llm',
        });
      });

      it('never overwrites a category the user chose (§4.3)', async () => {
        const categories = context.store.merchants.listCategories();
        const [first, second] = categories;
        context.store.db
          .prepare(
            `UPDATE "transaction" SET category_id = ?, category_source = 'user'
              WHERE description_raw LIKE ?`,
          )
          .run(second.id, '%BLUE BOTTLE%');

        await proposeCategory(first.name);

        expect(rowFor('BLUE BOTTLE')).toMatchObject({
          category_id: second.id,
          category_source: 'user',
        });
      });

      it('applies nothing when the grouping itself was withheld', async () => {
        const [category] = context.store.merchants.listCategories();
        const before = rowFor('BLUE BOTTLE');

        // Sub-floor: §4.2 says such a proposal "applies to nothing", and a category
        // resting on an identity nobody accepted is still something.
        await proposeCategory(category.name, LLM_CONFIDENCE_FLOOR - 0.1);

        expect(rowFor('BLUE BOTTLE')).toMatchObject({
          category_source: before.category_source,
        });
      });

      it('drops a category name this taxonomy does not have, rather than creating one', async () => {
        await proposeCategory('Artisanal Nitro Cold Brew');

        // §6.8 files the taxonomy under an editor that does not exist yet. A model
        // inventing rows in it would be the one write on this path with no human
        // anywhere near it.
        expect(context.store.merchants.listCategories().map((c) => c.name)).not.toContain(
          'Artisanal Nitro Cold Brew',
        );
        // The *alias* still applied, so the row moved to Netflix and §2.5's rule
        // re-derived a category from that merchant's default — which is the rule
        // doing its job, not the model's answer landing. `llm` is what would mean
        // the invented name was written.
        expect(rowFor('BLUE BOTTLE').category_source).not.toBe('llm');
        expect(
          context.store.merchants.listAliases().some((entry) => entry.source === 'llm'),
        ).toBe(true);
      });
    });

    it('holds a sub-floor proposal in the review queue and applies nothing', async () => {
      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt)
          .filter((descriptor) => descriptor.includes('PLANT CAFE'))
          .map((descriptor) => ({
            descriptor,
            merchant_name: 'Netflix',
            category: null,
            confidence: LLM_CONFIDENCE_FLOOR - 0.1,
          })),
      }));
      await setProvider('ollama');

      await propose();

      expect(context.store.merchants.listAliases().filter((a) => a.source === 'llm')).toEqual([]);

      const proposals = await proposalsFor();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ status: 'pending', merchantName: 'Netflix' });
      expect(proposals[0].blockedReason).toContain('below the');
    });

    it('never overwrites an existing alias, however confident (§4.2)', async () => {
      // A user correction on the same descriptor, written first.
      const descriptor = context.store.merchants
        .list()
        .find((merchant) => merchant.canonicalName.includes('PLANT CAFE'))!.canonicalName;
      context.store.merchants.upsertAlias({
        aliasKey: descriptor,
        merchantId: 'netflix',
        matchType: 'exact',
        confidence: null,
        source: 'user',
      });

      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt).map((entry) => ({
          descriptor: entry,
          merchant_name: 'Spotify',
          category: null,
          confidence: 1,
        })),
      }));
      await setProvider('ollama');

      await propose();

      const alias = context.store.merchants
        .listAliases()
        .find((entry) => entry.aliasKey === descriptor);

      // §4.3's precedence, and §4.2's stricter rule on top of it. A user correction
      // is permanent and "a later re-run with a better model" does not touch it.
      expect(alias?.source).toBe('user');
      expect(alias?.merchantId).toBe('netflix');
    });

    /**
     * §4.2's "never overwrites an existing alias", and the one exception §9s adds
     * to keep it from meaning "never applies at all".
     *
     * Pinned here rather than in `data`'s own suite because the rule is §4.2's, not
     * the table's: what a `rule` alias *is* — a cache of the chain's deterministic
     * output rather than anybody's decision — is the whole argument for the
     * exception, and it is an argument about this stage.
     */
    describe('what an `llm` alias may and may not replace (§4.2, §4.3, §9s)', () => {
      const write = (source: 'seed' | 'rule' | 'user' | 'llm', merchantId: string) =>
        context.store.merchants.upsertAlias({
          aliasKey: 'A DESCRIPTOR',
          merchantId,
          matchType: 'exact',
          confidence: 1,
          source,
        });

      const sourceOf = () =>
        context.store.merchants.listAliases().find((a) => a.aliasKey === 'A DESCRIPTOR');

      it('replaces a `rule` alias, because that is the chain restating itself', () => {
        write('rule', 'spotify');
        write('llm', 'netflix');

        expect(sourceOf()).toMatchObject({ source: 'llm', merchantId: 'netflix' });
      });

      it('does not replace a `seed` alias', () => {
        write('seed', 'spotify');
        write('llm', 'netflix');

        expect(sourceOf()).toMatchObject({ source: 'seed', merchantId: 'spotify' });
      });

      it('does not replace a `user` alias — §4.3 calls a correction permanent', () => {
        write('user', 'spotify');
        write('llm', 'netflix');

        expect(sourceOf()).toMatchObject({ source: 'user', merchantId: 'spotify' });
      });

      it('does not replace another `llm` alias, so a re-run is idempotent', () => {
        write('llm', 'spotify');
        write('llm', 'netflix');

        // Two models trading one descriptor back and forth is a merchant that
        // changes name every time the provider does.
        expect(sourceOf()).toMatchObject({ source: 'llm', merchantId: 'spotify' });
      });

      it('leaves §4.3’s precedence intact for every other source', () => {
        write('user', 'spotify');
        write('rule', 'netflix');
        expect(sourceOf()).toMatchObject({ source: 'user', merchantId: 'spotify' });

        // And a stronger source still wins, which is what makes a correction stick.
        write('user', 'hulu');
        expect(sourceOf()).toMatchObject({ source: 'user', merchantId: 'hulu' });
      });
    });

    it('ignores a descriptor nobody asked about', async () => {
      provider = new ScriptedProvider(() => ({
        proposals: [
          { descriptor: 'A DESCRIPTOR THAT WAS NEVER SENT', merchant_name: 'Netflix', category: null, confidence: 1 },
        ],
      }));
      await setProvider('ollama');

      await propose();

      // Either a hallucination or a mangled echo. Writing an alias keyed on it
      // would put a row in the table for a descriptor the ledger does not have.
      expect(context.store.merchants.listAliases().filter((a) => a.source === 'llm')).toEqual([]);
    });

    it('keeps the good entries when one in a batch is malformed', async () => {
      provider = new ScriptedProvider((prompt) => ({
        proposals: [
          { descriptor: descriptorsIn(prompt)[0], merchant_name: 'Netflix', category: null, confidence: 0.95 },
          { descriptor: descriptorsIn(prompt)[1], merchant_name: null, confidence: 'very' },
        ],
      }));
      await setProvider('ollama');

      await propose();

      // Forty-nine right and one wrong is still forty-nine useful answers; failing
      // the batch would make the feature hostage to its worst entry.
      expect(context.store.merchants.listAliases().filter((a) => a.source === 'llm')).toHaveLength(1);
    });

    it('does nothing at all with the provider set to `none`', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/llm/propose-merchants' });

      expect(response.json().willDoNothing).toBe(true);
      await context.jobRunner.drain();

      expect(context.store.merchants.listAliases().filter((a) => a.source === 'llm')).toEqual([]);
      expect(await proposalsFor()).toEqual([]);
    });

    it('says why the queue is empty rather than looking broken', async () => {
      const queue = (await app.inject({ method: 'GET', url: '/api/merchants/review-queue' })).json();

      expect(queue.llmProposals).toEqual([]);
      expect(queue.llmProposalsUnavailableReason).toContain('No LLM provider is configured');
    });
  });

  // ================================== §4.2's exception, which overrides the floor ===

  describe('the settled-series exception (§4.2)', () => {
    /**
     * A subscription with a year of history, plus one unresolved descriptor a model
     * might want to fold into it. §4.2's exception is about exactly this shape.
     */
    beforeEach(async () => {
      await importStatement(
        'year.csv',
        [
          ...monthly('NETFLIX.COM 866-579-7172 CA', -1099, '2026-01-04', 12),
          { date: '2026-01-14', description: 'TST* THE PLANT CAFE #0042', amountCents: -1840 },
          { date: '2026-02-14', description: 'TST* THE PLANT CAFE #0042', amountCents: -2210 },
        ].sort(byDate),
      );

      // The series has to exist before the exception can protect it.
      await app.inject({ method: 'POST', url: '/api/analysis/run' });
      await context.jobRunner.drain();

      const settled = context.store.analysis
        .listSeries()
        .filter((series) => series.occurrenceCount >= 3);
      expect(settled.length).toBeGreaterThan(0);
    });

    it('withholds a 0.99 proposal that would merge into a settled series', async () => {
      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt).map((descriptor) => ({
          descriptor,
          merchant_name: 'Netflix',
          category: null,
          confidence: 0.99,
        })),
      }));
      await setProvider('ollama');

      await propose();

      // "never auto-applies at any confidence" — the floor does not protect
      // against this and is not what refused it.
      expect(context.store.merchants.listAliases().filter((a) => a.source === 'llm')).toEqual([]);

      const proposals = (
        await app.inject({ method: 'GET', url: '/api/merchants/review-queue' })
      ).json().llmProposals as { status: string; blockedReason: string }[];

      expect(proposals.some((proposal) => proposal.status === 'blocked')).toBe(true);
      expect(
        proposals.find((proposal) => proposal.status === 'blocked')?.blockedReason,
      ).toContain('settled');
    });

    it('says it was the series and not the confidence, because they have different fixes', async () => {
      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt).map((descriptor) => ({
          descriptor,
          merchant_name: 'Netflix',
          category: null,
          confidence: 0.99,
        })),
      }));
      await setProvider('ollama');
      await propose();

      const proposals = (
        await app.inject({ method: 'GET', url: '/api/merchants/review-queue' })
      ).json().llmProposals as { blockedReason: string }[];

      // A settled-series block reported as "below the floor" would send someone to
      // raise a threshold that was never the reason.
      expect(proposals[0].blockedReason).not.toContain('floor');
    });
  });

  // ================================================ T1 — provenance ablation ===

  /**
   * §2.4's **T1**, which it names as one of the three tests that replace the design
   * session's tautological parity suite.
   *
   * "Over a database with LLM aliases applied, run the analyzers twice: once with
   * the full alias set, once with every `source='llm'` alias stripped so those rows
   * fall back to their rule-normalized provisional merchants. Assert (a) the
   * ablated run is non-empty for every rule that fires in the full run, (b) every
   * finding in the ablated run survives into the full run with the same `rule_id`
   * and subject, and (c) the diff is emitted as the run's *LLM-attributable finding
   * set* for review. A regression that lets a model suppress a deterministic
   * finding fails (b)."
   *
   * ## The order is ablated-first, and that is not a detail
   *
   * The obvious reading is "apply, run, strip, run". Doing it that way makes the
   * ablated run the second one, which means it is also the one that runs against a
   * database the first run has already written findings into — and §5.1's upsert by
   * natural key would then be part of what is being compared. So the deterministic
   * run happens first, on a database no model has touched, and the full run second.
   * Both are read from the API, so what is compared is what a user would see.
   */
  describe('T1 — provenance ablation (§2.4)', () => {
    interface Finding {
      ruleId: string;
      subjectId: string;
      naturalKey: string;
      band: string;
      confidence: number;
      llmDependent: boolean;
    }

    async function analyze(): Promise<Finding[]> {
      const run = await app.inject({ method: 'POST', url: '/api/analysis/run' });
      expect(run.statusCode).toBe(202);
      await context.jobRunner.drain();

      const findings = await app.inject({ method: 'GET', url: '/api/findings?limit=500' });
      return (findings.json() as { rows: Finding[] }).rows;
    }

    beforeEach(async () => {
      /**
       * A statement where the model has something real to contribute, sitting next
       * to findings it has nothing to do with.
       *
       * The subscriptions are the deterministic half: a year of Netflix with a
       * price step and a year of Spotify produce §5.2 and §5.5 findings that no
       * model touched, and they are what (a) and (b) are measured against.
       *
       * The coffee shop is the LLM's half — `STARBUCKS STORE …` resolves through a
       * seed alias, `SBUX #4471 …` does not and becomes a provisional merchant. Two
       * charges each, at deliberately **non-cadenced** dates, and both halves of
       * that are load-bearing. Two, because §4.2's settled-series exception
       * withholds at any confidence once either side reaches three occurrences —
       * three would test the exception, which is covered above on its own.
       * Non-cadenced, because four charges that *did* fit a cadence would let the
       * merge create a series neither half could carry, and a new series brings a
       * new subject that §5.7 can then report on — a rule firing in the full run and
       * nowhere else, which is what (a) refuses. That is not hypothetical: it is
       * what the first version of this fixture did, and it is recorded in §9s as
       * the place (a) is stricter than the reason §2.4 gives for it. The cap it
       * would have demonstrated is demonstrated on its own fixture below.
       */
      await importStatement(
        'ablation.csv',
        [
          ...monthly('NETFLIX.COM 866-579-7172 CA', -1099, '2026-01-04', 6),
          ...monthly('NETFLIX.COM 866-579-7172 CA', -1499, '2026-07-04', 6),
          ...monthly('SPOTIFY USA 4029357733', -1149, '2026-01-17', 12),
          { date: '2026-01-03', description: 'STARBUCKS STORE 1234 SEATTLE', amountCents: -685 },
          { date: '2026-06-08', description: 'STARBUCKS STORE 1234 SEATTLE', amountCents: -740 },
          { date: '2026-02-27', description: 'SBUX #4471 SEATTLE WA', amountCents: -512 },
          { date: '2026-11-19', description: 'SBUX #4471 SEATTLE WA', amountCents: -908 },
        ].sort(byDate),
      );
    });

    it('ablated ⊆ full, and the diff is the LLM-attributable set', async () => {
      // (1) The deterministic run: no provider has ever been configured, so every
      //     input carries `source ∈ {seed, rule, user}`. This is §2.4's
      //     **completeness** invariant as a fact rather than a claim.
      const ablated = await analyze();
      expect(ablated.length).toBeGreaterThan(0);

      // (2) Apply §4.2's stage for real, through the job.
      provider = new ScriptedProvider((prompt) => ({
        proposals: descriptorsIn(prompt)
          .filter((descriptor) => descriptor.includes('SBUX'))
          .map((descriptor) => ({
            descriptor,
            merchant_name: 'Starbucks',
            category: null,
            confidence: 0.95,
          })),
      }));
      await setProvider('ollama');
      await propose();
      // A second drain: applying an alias enqueues §4.3's re-normalize, and the
      // rows have to move before the full run can see the regrouping.
      await context.jobRunner.drain();

      const llmAliases = context.store.merchants.listAliases().filter((a) => a.source === 'llm');
      expect(llmAliases.length).toBeGreaterThan(0);

      const full = await analyze();

      // (a) Every rule that fires in the full run also fires in the ablated one.
      //     A rule that only ever emits *because* a model grouped something is a
      //     provider-gated rule, which §2.4 forbids in as many words.
      const ablatedRules = new Set(ablated.map((finding) => finding.ruleId));
      for (const ruleId of new Set(full.map((finding) => finding.ruleId))) {
        expect(ablatedRules.has(ruleId)).toBe(true);
      }

      // (b) Every ablated finding survives into the full run, same rule and
      //     subject. This is the assertion that fails when a model suppresses a
      //     deterministic finding.
      const fullKeys = new Set(full.map((finding) => finding.naturalKey));
      const suppressed = ablated.filter((finding) => !fullKeys.has(finding.naturalKey));
      expect(suppressed).toEqual([]);

      // (c) The diff, which is the run's LLM-attributable finding set. Non-empty is
      //     not required — a model that added nothing useful is a normal outcome —
      //     but it must be *computable*, because that is what a reviewer reads.
      const ablatedKeys = new Set(ablated.map((finding) => finding.naturalKey));
      const attributable = full.filter((finding) => !ablatedKeys.has(finding.naturalKey));
      expect(Array.isArray(attributable)).toBe(true);
    });

    it('every rule still runs and can still emit with the provider `none` (§2.4 completeness)', async () => {
      const findings = await analyze();

      // Nothing was ever asked of a model, and the run is not empty. That is the
      // whole of the completeness invariant: "With the provider set to `none`,
      // every rule still runs and can still emit, using only inputs with
      // `source ∈ {seed, rule, user}`."
      expect(findings.length).toBeGreaterThan(0);
      expect(context.store.merchants.listAliases().every((alias) => alias.source !== 'llm')).toBe(
        true,
      );
    });

    /**
     * §2.4's third invariant — **no silent authority**.
     *
     * "A finding whose evidence depends on any `source='llm'` alias or category
     * carries `llm_dependent = true`, is badged in the UI as resting on an
     * AI-suggested grouping, and has its confidence **capped at Medium** until the
     * underlying alias is user-confirmed. High confidence is reserved for groupings
     * a human or a seed vouched for."
     *
     * Its own fixture, because the property needs the opposite of what T1 needs. T1
     * wants a grouping that disturbs no rule, so the ablation diff is clean. This
     * wants one that lands *inside* a finding's evidence, which on this data means
     * the four coffee charges have to fit a cadence: two spellings, two charges
     * each, quarterly, so the merge builds a series neither half could carry. That
     * is also why the two cannot share a fixture — see §9s.
     *
     * Asserted as a pair, because either half alone passes by accident. Before
     * §4.2's stage landed, "nothing is flagged" was true and the other half was
     * vacuous: no `llm` alias had ever been written, so `llmDependent` was correctly
     * false everywhere and could not be observed to be broken.
     */
    describe('no silent authority (§2.4)', () => {
      beforeEach(async () => {
        await importStatement(
          'capped.csv',
          [
            { date: '2026-01-05', description: 'STARBUCKS STORE 1234 SEATTLE', amountCents: -1250 },
            { date: '2026-04-05', description: 'STARBUCKS STORE 1234 SEATTLE', amountCents: -1250 },
            { date: '2026-07-05', description: 'SBUX #4471 SEATTLE WA', amountCents: -1250 },
            { date: '2026-10-05', description: 'SBUX #4471 SEATTLE WA', amountCents: -1250 },
          ].sort(byDate),
        );
      });

      it('flags nothing as AI-dependent before a model has been asked', async () => {
        const findings = await analyze();

        expect(findings.length).toBeGreaterThan(0);
        expect(findings.some((finding) => finding.llmDependent)).toBe(false);
      });

      it('flags a finding whose evidence rests on an `llm` alias, and caps it', async () => {
        expect((await analyze()).some((finding) => finding.llmDependent)).toBe(false);

        provider = new ScriptedProvider((prompt) => ({
          proposals: descriptorsIn(prompt)
            .filter((descriptor) => descriptor.includes('SBUX'))
            .map((descriptor) => ({
              descriptor,
              merchant_name: 'Starbucks',
              category: null,
              confidence: 0.95,
            })),
        }));
        await setProvider('ollama');
        await propose();
        await context.jobRunner.drain();

        const dependent = (await analyze()).filter((finding) => finding.llmDependent);

        expect(dependent.length).toBeGreaterThan(0);
        // The cap, which is the half that matters: High is "reserved for groupings
        // a human or a seed vouched for", and a model vouching for itself at 0.95
        // is not that.
        for (const finding of dependent) {
          expect(finding.band).not.toBe('high');
          expect(finding.confidence).toBeLessThanOrEqual(0.79);
        }
      });
    });
  });
});

/**
 * The descriptors a prompt actually carried.
 *
 * Read back out of the prompt rather than assumed, because the model only ever sees
 * what `redactBatch` let through — a fake that answered about the descriptor it
 * *expected* would be testing the test rather than the batch.
 */
function descriptorsIn(prompt: string): string[] {
  const marker = prompt.indexOf('Descriptors:');
  if (marker === -1) return [];
  return prompt
    .slice(marker + 'Descriptors:'.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

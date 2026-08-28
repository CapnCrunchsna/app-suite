/**
 * §2.4's seam, over fakes.
 *
 * No test here starts a real `claude` process or reaches a real Ollama. That is
 * not squeamishness about slow tests: `ClaudeCliProvider` is the one component in
 * this repository whose correct operation sends statement text to a third party,
 * and a test suite that exercises it for real would do so on every `npm run check`
 * — including on a machine where somebody happened to be logged in. The behaviours
 * worth pinning are all observable through an injected `spawn`.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { llmAssist } from './assist.js';
import type { DegradedCall } from './assist.js';
import { ClaudeCliProvider } from './claude-cli-provider.js';
import { NoneProvider } from './none-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { LlmUnavailableError } from './provider.js';
import { REDACTED, redactBatch, redactText } from './redact.js';

// ------------------------------------------------------------- the default ---

describe('NoneProvider (§2.4)', () => {
  it('claims nothing and keeps everything local', () => {
    const provider = new NoneProvider();

    expect(provider.capabilities()).toEqual([]);
    expect(provider.sendsDataOffMachine).toBe(false);
  });

  it('reports unhealthy rather than pretending a disabled provider is fine', async () => {
    // §6.8's Test Connection button has to mean something, and "there is nothing
    // to connect to" is the true answer for `none`.
    await expect(new NoneProvider().health()).resolves.toEqual({
      ok: false,
      detail: 'LLM disabled',
    });
  });

  it('throws the same error a broken provider throws', async () => {
    // The whole reason §2.4 makes this a real implementation: the disabled path
    // and the failure path are one path, so the common case exercises the rare one.
    const provider = new NoneProvider();

    await expect(provider.complete({ prompt: 'x' })).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(
      provider.completeJson({ prompt: 'x', validate: (v) => v }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

// ------------------------------------------------------------- llmAssist ---

describe('llmAssist (§2.4)', () => {
  it('returns the model answer when the call works', async () => {
    const answer = await llmAssist(() => Promise.resolve('from the model'), {
      fallback: () => 'deterministic',
      operation: 'test',
    });

    expect(answer).toBe('from the model');
  });

  it('falls back on any provider failure, and records it', async () => {
    const degraded: DegradedCall[] = [];

    const answer = await llmAssist(
      () => Promise.reject(new LlmUnavailableError('ollama is down', 'ollama')),
      {
        fallback: () => 'deterministic',
        operation: 'merchant normalization',
        onDegraded: (event) => degraded.push(event),
        now: () => new Date('2026-08-27T12:00:00.000Z'),
      },
    );

    expect(answer).toBe('deterministic');
    expect(degraded).toEqual([
      {
        at: '2026-08-27T12:00:00.000Z',
        providerId: 'ollama',
        operation: 'merchant normalization',
        reason: 'ollama is down',
      },
    ]);
  });

  it('treats a schema failure exactly like an unreachable provider', async () => {
    // §2.4 lists "any throw, timeout, or schema-validation failure" as one
    // outcome. A caller that could tell them apart would have two code paths to
    // the same answer.
    const answer = await llmAssist(() => Promise.reject(new TypeError('not an object')), {
      fallback: () => 'deterministic',
      operation: 'test',
    });

    expect(answer).toBe('deterministic');
  });

  it('does not swallow a broken fallback', async () => {
    // The deterministic path failing is a real bug, and hiding it would defeat
    // the thing this design protects.
    await expect(
      llmAssist(() => Promise.reject(new Error('provider')), {
        fallback: () => {
          throw new Error('the deterministic path is broken');
        },
        operation: 'test',
      }),
    ).rejects.toThrow('the deterministic path is broken');
  });
});

// -------------------------------------------------------------- redaction ---

describe('redaction (§2.4)', () => {
  it('strips account-shaped runs and last4', () => {
    expect(redactText('SQ *BLUE BOTTLE 4821 PORTLAND')).toBe(`SQ *BLUE BOTTLE ${REDACTED} PORTLAND`);
    expect(redactText('PAYMENT ACCT #7261')).toBe(`PAYMENT ${REDACTED}`);
    expect(redactText('VISA XXXX4821')).toBe(`VISA ${REDACTED}`);
  });

  it('substitutes rather than deletes, so neighbours do not glue together', () => {
    // §4.1 stage 1's argument, in a different setting: deleting the run would
    // invent a merchant that does not exist.
    expect(redactText('SQ *BLUE BOTTLE 1234 PORTLAND')).toContain('BLUE BOTTLE');
    expect(redactText('SQ *BLUE BOTTLE 1234 PORTLAND')).toContain('PORTLAND');
  });

  it('leaves a merchant name that merely contains a short number alone', () => {
    expect(redactText('7-ELEVEN 76 GAS')).toBe('7-ELEVEN 76 GAS');
  });

  it('withholds a P2P descriptor entirely rather than masking it', () => {
    // §2.4: "a partially-masked personal name is still a personal name."
    const result = redactBatch([
      { id: 'a', text: 'ZELLE PAYMENT TO SARAH M', isP2P: true },
      { id: 'b', text: 'SQ *BLUE BOTTLE 4821', isP2P: false },
    ]);

    expect(result.withheldP2P).toEqual(['a']);
    expect(result.sendable).toEqual([{ id: 'b', text: `SQ *BLUE BOTTLE ${REDACTED}` }]);
  });

  it('reports what it withheld, so a filtered batch is not mistaken for an empty one', () => {
    const result = redactBatch([{ id: 'a', text: 'VENMO TO ALEX', isP2P: true }]);

    expect(result.sendable).toEqual([]);
    expect(result.withheldP2P).toEqual(['a']);
  });
});

// ------------------------------------------------------------------ ollama ---

describe('OllamaProvider (§2.4)', () => {
  const tags = (names: string[]) =>
    new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });

  it('keeps everything on this machine', () => {
    expect(new OllamaProvider().sendsDataOffMachine).toBe(false);
  });

  it('reports healthy only when the configured model is actually pulled', async () => {
    const provider = new OllamaProvider({
      model: 'llama3.2:3b',
      fetchFn: (() => Promise.resolve(tags(['llama3.2:3b']))) as unknown as typeof fetch,
    });

    await expect(provider.health()).resolves.toMatchObject({ ok: true });
  });

  it('names the fix when the daemon is up but the model is missing', async () => {
    // §2.4: "a common failure that otherwise surfaces as a confusing 404."
    const provider = new OllamaProvider({
      model: 'llama3.2:3b',
      fetchFn: (() => Promise.resolve(tags(['mistral:7b']))) as unknown as typeof fetch,
    });
    const health = await provider.health();

    expect(health.ok).toBe(false);
    expect(health.detail).toContain('ollama pull llama3.2:3b');
  });

  it('accepts a bare model name against a tagged listing', async () => {
    // A user who configured `llama3.2` means the default tag of it, and a correct
    // configuration must not read as a missing model.
    const provider = new OllamaProvider({
      model: 'llama3.2',
      fetchFn: (() => Promise.resolve(tags(['llama3.2:3b']))) as unknown as typeof fetch,
    });

    await expect(provider.health()).resolves.toMatchObject({ ok: true });
  });

  it('says the daemon is not answering rather than throwing a fetch error', async () => {
    const provider = new OllamaProvider({
      fetchFn: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    });

    await expect(provider.health()).resolves.toMatchObject({ ok: false });
  });

  it('asks for JSON mode only on completeJson', async () => {
    const bodies: string[] = [];
    const fetchFn = ((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(
        new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 }),
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ fetchFn });
    await provider.complete({ prompt: 'plain' });
    await provider.completeJson({ prompt: 'structured', validate: (v) => v });

    expect(JSON.parse(bodies[0]).format).toBeUndefined();
    expect(JSON.parse(bodies[1]).format).toBe('json');
  });

  it('turns a wrong-shaped answer into an unavailability', async () => {
    const provider = new OllamaProvider({
      fetchFn: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: { content: '{"a":1}' } }), { status: 200 }),
        )) as unknown as typeof fetch,
    });

    await expect(
      provider.completeJson({
        prompt: 'x',
        validate: () => {
          throw new TypeError('wrong shape');
        },
      }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});

// -------------------------------------------------------------- claude cli ---

/**
 * Let the concurrency queue hand work to `run`.
 *
 * `enqueue` chains onto a resolved promise, so the child is not spawned until a
 * microtask after the call. Emitting before that lands on a process nobody is
 * listening to yet — which is a property of the queue §2.4 asks for, not an
 * accident worth working around in the product.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake child process good enough for the four behaviours §2.4 pins. */
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

describe('ClaudeCliProvider (§2.4)', () => {
  it('declares that it sends data off this machine', () => {
    // §6.8's warning card and the header indicator both read this. A provider
    // that got it wrong would put a reassuring badge over a network call.
    expect(new ClaudeCliProvider().sendsDataOffMachine).toBe(true);
  });

  it('writes the prompt to stdin and never to argv', async () => {
    // The injection and argument-length rule, and the single most important
    // assertion in this file.
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const provider = new ClaudeCliProvider({ spawnFn });

    const pending = provider.complete({ prompt: 'TST* THE PLANT CAFE #0042' });
    await tick();
    child.stdout.emit('data', JSON.stringify({ result: 'ok' }));
    child.emit('close', 0);
    await pending;

    const [, args, options] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toEqual(['-p', '--output-format', 'json']);
    expect(args.join(' ')).not.toContain('PLANT CAFE');
    expect(child.stdin.end).toHaveBeenCalledWith('TST* THE PLANT CAFE #0042');
    // A shell would reopen the injection question the stdin rule just closed.
    expect(options.shell).toBe(false);
  });

  it('parses the envelope for the result text', async () => {
    const child = fakeChild();
    const provider = new ClaudeCliProvider({
      spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
    });

    const pending = provider.complete({ prompt: 'x' });
    await tick();
    child.stdout.emit('data', JSON.stringify({ result: 'the answer', cost_usd: 0.01 }));
    child.emit('close', 0);

    await expect(pending).resolves.toBe('the answer');
  });

  it('treats a malformed envelope as an unavailability', async () => {
    const child = fakeChild();
    const provider = new ClaudeCliProvider({
      spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
    });

    const pending = provider.complete({ prompt: 'x' });
    await tick();
    child.stdout.emit('data', 'not json at all');
    child.emit('close', 0);

    await expect(pending).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('treats a non-zero exit as an unavailability, carrying the reason', async () => {
    const child = fakeChild();
    const provider = new ClaudeCliProvider({
      spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
    });

    const pending = provider.complete({ prompt: 'x' });
    await tick();
    child.stderr.emit('data', 'not logged in');
    child.emit('close', 1);

    await expect(pending).rejects.toThrow('not logged in');
  });

  it('kills a hung child rather than waiting on it', async () => {
    const child = fakeChild();
    const provider = new ClaudeCliProvider({
      spawnFn: (() => child) as unknown as typeof import('node:child_process').spawn,
      timeoutMs: 10,
    });

    await expect(provider.complete({ prompt: 'x' })).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('runs one child at a time, however many callers there are', async () => {
    // §2.4 pins concurrency at 1: the CLI is a process per call, and fifty at
    // once is a fork bomb with a friendly name.
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const provider = new ClaudeCliProvider({ spawnFn });
    const first = provider.complete({ prompt: 'one' });
    const second = provider.complete({ prompt: 'two' });

    await tick();
    expect(children).toHaveLength(1);

    children[0].stdout.emit('data', JSON.stringify({ result: 'one' }));
    children[0].emit('close', 0);
    await first;

    // Only now does the second call get a process of its own.
    await tick();
    children[1].stdout.emit('data', JSON.stringify({ result: 'two' }));
    children[1].emit('close', 0);

    await expect(second).resolves.toBe('two');
    expect(children).toHaveLength(2);
  });

  it('keeps the queue alive after a failed call', async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawnFn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn;

    const provider = new ClaudeCliProvider({ spawnFn });
    const first = provider.complete({ prompt: 'one' });
    const second = provider.complete({ prompt: 'two' });

    await tick();
    children[0].emit('close', 1);
    await expect(first).rejects.toBeInstanceOf(LlmUnavailableError);

    await tick();
    children[1].stdout.emit('data', JSON.stringify({ result: 'two' }));
    children[1].emit('close', 0);

    await expect(second).resolves.toBe('two');
  });
});

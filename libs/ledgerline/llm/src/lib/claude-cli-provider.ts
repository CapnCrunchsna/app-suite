/**
 * §2.4's `ClaudeCliProvider` — the only provider that sends statement text off
 * this machine.
 *
 * "spawns `claude -p --output-format json` and writes the prompt to **stdin**,
 * never to argv. That is both an argument-length and an injection concern:
 * statement text is untrusted input and must never be interpolated into a command
 * line. Concurrency is pinned to 1, with a 90s default timeout and hard process
 * kill on expiry."
 *
 * ## Every clause of that sentence is load-bearing
 *
 * **stdin, never argv.** A merchant descriptor is attacker-influenced in the only
 * sense that matters here: it is text this app did not write, arriving from a file
 * the user downloaded. Interpolating it into a command line makes the shell's
 * quoting rules part of this app's security model. Writing to stdin removes the
 * question — and it removes the argument-length ceiling, which a batch of fifty
 * descriptors would otherwise reach on Windows.
 *
 * **`spawn`, not `exec`.** `exec` runs the command through a shell, which reopens
 * the injection question the stdin rule just closed. `shell: false` is the default
 * here and is set explicitly, because a future edit adding `shell: true` for
 * convenience is exactly the change that would look harmless.
 *
 * **Concurrency 1.** The CLI is a whole process per call; running fifty at once is
 * a fork bomb with a friendly name. §2.4 pins it, and the queue below is the whole
 * of that pinning — calls line up rather than being rejected, because a batch
 * that fails halfway is worse than one that takes longer.
 *
 * **Hard kill on timeout.** A hung child holding a pipe is a hung import. The
 * timer kills the process and the promise rejects; a `SIGKILL` follows the first
 * signal, because a process ignoring `SIGTERM` is precisely the case a timeout
 * exists for.
 *
 * ## What this file deliberately does not do
 *
 * It does not redact. `redact.ts` runs before any provider is handed a prompt, and
 * putting a second, partial redaction here would create two places to keep in step
 * and a false sense that this one is a safety net.
 */

import { spawn } from 'node:child_process';

import { LlmUnavailableError } from './provider.js';
import type {
  CompleteRequest,
  JsonRequest,
  LlmCapability,
  LlmHealth,
  LlmProvider,
} from './provider.js';

/** §2.4's default. Long, because a cold CLI start plus a real completion is
 *  seconds, and a timeout that fires on a working call is a broken feature. */
export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 90_000;

/** How long the child gets to honour the first signal before it is killed
 *  outright. Short: this only runs after a timeout has already expired. */
const SIGKILL_GRACE_MS = 2_000;

export interface ClaudeCliOptions {
  /** The executable. A name resolved on PATH by default; a full path in tests. */
  readonly command?: string;
  readonly timeoutMs?: number;
  /** Injected so the spec can drive a fake child process. Production never passes
   *  it — the default is `node:child_process`'s own `spawn`. */
  readonly spawnFn?: typeof spawn;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli' as const;
  /** §2.4: true only for this one, and it is what §6.8's warning card reads. */
  readonly sendsDataOffMachine = true;

  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: typeof spawn;

  /** The concurrency-1 pin: every call chains onto the previous one's settlement,
   *  so at most one child exists at a time however many callers there are. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ClaudeCliOptions = {}) {
    this.command = options.command ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  capabilities(): LlmCapability[] {
    return ['complete', 'json'];
  }

  async health(): Promise<LlmHealth> {
    try {
      const version = await this.run(['--version'], null, 10_000);
      return { ok: true, detail: version.trim() || 'claude CLI responded' };
    } catch (cause) {
      return {
        ok: false,
        detail: cause instanceof Error ? cause.message : 'claude CLI did not respond',
      };
    }
  }

  async complete(request: CompleteRequest): Promise<string> {
    const raw = await this.enqueue(() =>
      this.run(this.argsFor(request.model), request.prompt, request.timeoutMs ?? this.timeoutMs),
    );
    return this.resultTextOf(raw);
  }

  async completeJson<T>(request: JsonRequest<T>): Promise<T> {
    const text = await this.complete(request);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new LlmUnavailableError('claude CLI returned text that is not JSON', this.id, cause);
    }

    // The caller's validator throws on a shape mismatch, and §2.4 wants that to
    // degrade exactly like an unreachable provider — so it becomes this error and
    // `llmAssist` falls back.
    try {
      return request.validate(parsed);
    } catch (cause) {
      throw new LlmUnavailableError('claude CLI returned JSON of the wrong shape', this.id, cause);
    }
  }

  /**
   * `-p` for a single non-interactive prompt, `--output-format json` for the
   * envelope. The prompt is *not* here: it goes to stdin, which is the point.
   */
  private argsFor(model: string | undefined): string[] {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    return args;
  }

  /** §2.4: "The JSON envelope is parsed for the result text". A shape that does
   *  not carry one is a malformed envelope, which §2.4 makes an unavailability. */
  private resultTextOf(raw: string): string {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (cause) {
      throw new LlmUnavailableError('claude CLI returned a malformed envelope', this.id, cause);
    }

    const result = (envelope as { result?: unknown })?.result;
    if (typeof result !== 'string') {
      throw new LlmUnavailableError('claude CLI envelope carried no result text', this.id);
    }
    return result;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // Swallow on the chain itself, never on the returned promise: the queue must
    // survive a failed call so the next caller still runs, while this caller still
    // sees the rejection.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private run(args: readonly string[], input: string | null, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(this.command, [...args], {
          // Explicit, and not a default worth inheriting silently — see the header.
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (cause) {
        reject(new LlmUnavailableError(`could not start ${this.command}`, this.id, cause));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS);
          reject(
            new LlmUnavailableError(`${this.command} timed out after ${timeoutMs}ms`, this.id),
          );
        });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk);
      });

      child.on('error', (cause: unknown) => {
        finish(() => reject(new LlmUnavailableError(`${this.command} failed`, this.id, cause)));
      });

      child.on('close', (code: number | null) => {
        finish(() => {
          if (code === 0) resolve(stdout);
          else
            reject(
              new LlmUnavailableError(
                `${this.command} exited ${code ?? 'without a code'}${
                  stderr.trim() ? `: ${stderr.trim()}` : ''
                }`,
                this.id,
              ),
            );
        });
      });

      if (input === null) {
        child.stdin?.end();
        return;
      }

      // The prompt, on stdin. An EPIPE here means the child died before reading
      // it, which its own `close` will report with a real reason — so this must
      // not reject with a less useful one.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }
}

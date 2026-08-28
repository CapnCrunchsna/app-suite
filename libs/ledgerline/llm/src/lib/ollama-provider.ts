/**
 * §2.4's `OllamaProvider` — the local one.
 *
 * "`POST http://127.0.0.1:11434/api/chat`, using Ollama's `format: 'json'` mode
 * for `completeJson`. Model is configurable; default is a small instruct model.
 * Health check hits `/api/tags` and verifies the configured model is actually
 * pulled — a common failure that otherwise surfaces as a confusing 404.
 * `sendsDataOffMachine = false`."
 *
 * ## The health check is the interesting part
 *
 * Asking whether Ollama is *running* is easy and nearly useless: the daemon
 * answers happily while the model you configured has never been pulled, and the
 * failure then arrives later as a 404 from a chat call, which reads as a bug in
 * this app rather than as a missing download. So health resolves the model list
 * and looks for the configured name, and says which it is — running-but-missing
 * and not-running are different problems with different fixes, and §6.8's Test
 * Connection button is where that difference is worth a sentence.
 *
 * Ollama reports tags as `name:tag` (`llama3.2:3b`), and a user who configured
 * `llama3.2` means the default tag of it. Matching on the bare name as well as the
 * exact string is what stops a correct configuration reading as a missing model.
 *
 * ## 127.0.0.1, not localhost
 *
 * Same rule the API binds itself by. `localhost` can resolve to `::1` first, and
 * an Ollama listening only on IPv4 then fails with a connection error that says
 * nothing about why.
 */

import { LlmUnavailableError } from './provider.js';
import type {
  CompleteRequest,
  JsonRequest,
  LlmCapability,
  LlmHealth,
  LlmProvider,
} from './provider.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
/** §2.4 says "a small instruct model" without naming one. This is the smallest
 *  broadly-available instruct model that reliably honours `format: 'json'`. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.2:3b';
export const OLLAMA_DEFAULT_TIMEOUT_MS = 60_000;

export interface OllamaOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Injected for the spec. Production uses the global `fetch`. */
  readonly fetchFn?: typeof fetch;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly sendsDataOffMachine = false;

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = options.model ?? OLLAMA_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? OLLAMA_DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  capabilities(): LlmCapability[] {
    return ['complete', 'json'];
  }

  async health(): Promise<LlmHealth> {
    let payload: { models?: { name?: string }[] };
    try {
      const response = await this.call('/api/tags', undefined, 5_000);
      payload = (await response.json()) as { models?: { name?: string }[] };
    } catch (cause) {
      return {
        ok: false,
        detail:
          cause instanceof LlmUnavailableError
            ? cause.message
            : `Ollama is not answering on ${this.baseUrl}`,
        model: this.model,
      };
    }

    const names = (payload.models ?? []).map((entry) => entry.name ?? '');
    const pulled = names.some((name) => name === this.model || name.split(':')[0] === this.model);

    return pulled
      ? { ok: true, detail: `Ollama is running and ${this.model} is pulled`, model: this.model }
      : {
          ok: false,
          // Naming the fix, because "model not found" sends people to the wrong place.
          detail: `Ollama is running but ${this.model} is not pulled — run: ollama pull ${this.model}`,
          model: this.model,
        };
  }

  async complete(request: CompleteRequest): Promise<string> {
    return this.chat(request, false);
  }

  async completeJson<T>(request: JsonRequest<T>): Promise<T> {
    const text = await this.chat(request, true);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new LlmUnavailableError('Ollama returned text that is not JSON', this.id, cause);
    }

    try {
      return request.validate(parsed);
    } catch (cause) {
      throw new LlmUnavailableError('Ollama returned JSON of the wrong shape', this.id, cause);
    }
  }

  private async chat(
    request: CompleteRequest | JsonRequest<unknown>,
    json: boolean,
  ): Promise<string> {
    const response = await this.call(
      '/api/chat',
      {
        model: request.model ?? this.model,
        messages: [{ role: 'user', content: request.prompt }],
        stream: false,
        // §2.4's "using Ollama's `format: 'json'` mode for `completeJson`".
        ...(json ? { format: 'json' } : {}),
      },
      request.timeoutMs ?? this.timeoutMs,
    );

    const payload = (await response.json()) as { message?: { content?: unknown } };
    const content = payload.message?.content;
    if (typeof content !== 'string') {
      throw new LlmUnavailableError('Ollama returned no message content', this.id);
    }
    return content;
  }

  private async call(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new LlmUnavailableError(
          `Ollama answered ${response.status} for ${path}`,
          this.id,
        );
      }
      return response;
    } catch (cause) {
      if (cause instanceof LlmUnavailableError) throw cause;
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new LlmUnavailableError(
        aborted
          ? `Ollama timed out after ${timeoutMs}ms`
          : `Ollama is not answering on ${this.baseUrl}`,
        this.id,
        cause,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

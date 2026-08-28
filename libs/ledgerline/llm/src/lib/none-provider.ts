/**
 * §2.4's `NoneProvider`, and the default for this app.
 *
 * "`capabilities()` returns `[]`, `health()` returns `{ ok: false, detail: 'LLM
 * disabled' }`, and both call methods throw `LlmUnavailableError` immediately. It
 * is a real implementation, not a null, so the degradation path is exercised
 * rather than special-cased."
 *
 * The last clause is the whole design. A codebase that models "no provider" as
 * `null` grows a `provider?.` at every call site, and the branch that runs when
 * there is no provider is then a different branch from the one that runs when a
 * provider fails — so the common case in this app (nothing configured) exercises
 * code the failure case does not. Here they are the same path: this throws, and
 * `llmAssist` falls back, exactly as it would for a dead Ollama or a CLI timeout.
 *
 * `health()` reporting `ok: false` is deliberate rather than pedantic. §6.8's Test
 * Connection button is honest about a disabled provider — "there is nothing to
 * connect to" is the true answer, and a green tick for `none` would teach the
 * button to mean nothing.
 */

import { LlmUnavailableError } from './provider.js';
import type {
  CompleteRequest,
  JsonRequest,
  LlmCapability,
  LlmHealth,
  LlmProvider,
} from './provider.js';

export class NoneProvider implements LlmProvider {
  readonly id = 'none' as const;
  readonly sendsDataOffMachine = false;

  capabilities(): LlmCapability[] {
    return [];
  }

  health(): Promise<LlmHealth> {
    return Promise.resolve({ ok: false, detail: 'LLM disabled' });
  }

  complete(_request: CompleteRequest): Promise<string> {
    return Promise.reject(this.unavailable());
  }

  completeJson<T>(_request: JsonRequest<T>): Promise<T> {
    return Promise.reject(this.unavailable());
  }

  private unavailable(): LlmUnavailableError {
    return new LlmUnavailableError(
      'No LLM provider is configured. Everything runs on the deterministic path.',
      this.id,
    );
  }
}

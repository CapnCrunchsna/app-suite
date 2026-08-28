/**
 * §2.4's one entry point: "**No feature calls a provider directly.** Everything
 * goes through `llmAssist(() => provider.completeJson({...}), deterministicFallback)`.
 * Any throw, timeout, or schema-validation failure yields the fallback and records
 * a degraded-call event visible in Settings."
 *
 * ## Why a wrapper rather than a convention
 *
 * The rule it enforces is that **the deterministic answer always exists**. §4.1's
 * chain resolves every descriptor without help; §2.5 assigns a category from the
 * merchant's default. The model's job is to improve on those, never to be required
 * for them — which is the same statement as §2.4's completeness invariant, "with
 * the provider set to `none`, every rule still runs and can still emit".
 *
 * Writing that as a wrapper taking the fallback *first* makes it structurally hard
 * to get wrong: you cannot call this without having already computed what happens
 * when the model is absent. A try/catch convention would let a call site forget,
 * and the forgetting would be invisible until someone switched the provider off.
 *
 * ## Every failure is the same failure
 *
 * A dead Ollama, a CLI timeout, a malformed envelope and a model that answered
 * with prose where an object was asked for are four different bugs with one
 * correct response: use the deterministic path and record that you did. Callers
 * get no way to distinguish them, because a caller that branched on *why* the
 * model failed would be a caller with two code paths to the same answer.
 *
 * The recorded event is not logging. §6.8's Data section shows this log, and its
 * purpose is answering "is my provider actually doing anything?" — a run of
 * degraded calls is how a user discovers Ollama has been down for a week while the
 * app quietly carried on working.
 */

import { LlmUnavailableError } from './provider.js';
import type { LlmProviderId } from './provider.js';

export interface DegradedCall {
  readonly at: string;
  readonly providerId: LlmProviderId | 'unknown';
  /** What the call was for, in the caller's words — "merchant normalization",
   *  not a stack frame. The log is read by the person who configured the
   *  provider, not by whoever wrote the call site. */
  readonly operation: string;
  readonly reason: string;
}

/** Where a degraded call goes. A sink rather than a return value because
 *  `llmAssist` returns the *answer*, and a caller should not have to thread a
 *  diagnostic through its own return type to stay honest. */
export type DegradedCallSink = (event: DegradedCall) => void;

export interface AssistOptions<T> {
  /** What runs when the provider is unavailable, fails, or answers wrongly.
   *  Required — see the header. */
  readonly fallback: () => T | Promise<T>;
  readonly operation: string;
  readonly onDegraded?: DegradedCallSink;
  readonly now?: () => Date;
}

/**
 * Run an LLM-assisted call, or the deterministic answer.
 *
 * Never rejects for a provider reason. It can still reject if the **fallback**
 * throws, and that is correct: a broken deterministic path is a real bug and
 * swallowing it would hide the thing this whole design is protecting.
 */
export async function llmAssist<T>(call: () => Promise<T>, options: AssistOptions<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    options.onDegraded?.({
      at: (options.now?.() ?? new Date()).toISOString(),
      providerId: cause instanceof LlmUnavailableError ? cause.providerId : 'unknown',
      operation: options.operation,
      reason: cause instanceof Error ? cause.message : String(cause),
    });

    return options.fallback();
  }
}

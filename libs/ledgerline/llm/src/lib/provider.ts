/**
 * §2.4's provider interface, and the error every implementation fails with.
 *
 * ## Why this is a seam and not a function
 *
 * §2.4 gives three providers whose differences are not implementation detail:
 * one sends statement text to Anthropic, one keeps it on the machine, and one
 * refuses to do anything at all. `sendsDataOffMachine` is on the interface rather
 * than inferred by the UI because it is the fact §6.8's warning card and the
 * app-header indicator both read, and a provider that lied about it would put a
 * reassuring badge over a network call.
 *
 * ## `none` is an implementation, not a null
 *
 * §2.4 is explicit: "It is a real implementation, not a null, so the degradation
 * path is exercised rather than special-cased." Every consumer therefore has the
 * same shape whatever is configured — `llmAssist` catches, falls back, and records
 * — and the disabled case is the one the tests run by default rather than the one
 * nobody runs.
 */

/** §2.4's two capabilities. `json` is the schema-validated call; `complete` is raw
 *  text and is what §6.7's Q&A would use. */
export type LlmCapability = 'complete' | 'json';

export type LlmProviderId = 'claude-cli' | 'ollama' | 'none';

export interface LlmHealth {
  readonly ok: boolean;
  readonly detail: string;
  readonly model?: string;
}

export interface CompleteRequest {
  readonly prompt: string;
  /** Overrides the provider's configured default where the provider has one. */
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * A schema-validated call. The validator is supplied by the caller rather than a
 * schema library living in this lib: §2.2 lets `type:llm` depend on `type:domain`
 * and nothing else, and the shapes being validated belong to the features asking
 * for them.
 *
 * A validator returns the parsed value or throws. Throwing is what `llmAssist`
 * turns into a fallback, so a model that answers with prose where an object was
 * asked for degrades exactly like a model that was not running.
 */
export interface JsonRequest<T> {
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly validate: (value: unknown) => T;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  /** §2.4: "Drives the UI warning. True only for claude-cli." */
  readonly sendsDataOffMachine: boolean;
  capabilities(): LlmCapability[];
  health(): Promise<LlmHealth>;
  complete(request: CompleteRequest): Promise<string>;
  completeJson<T>(request: JsonRequest<T>): Promise<T>;
}

/**
 * The one failure type every provider raises.
 *
 * §2.4 names it for the CLI path — "a non-zero exit, malformed envelope, or
 * timeout all raise `LlmUnavailableError`" — and the other two use it for the same
 * reason: `llmAssist` decides what to do about a failed call, and it should not
 * have to tell a spawn failure from a fetch failure from a schema mismatch to know
 * that the answer is *use the deterministic path*.
 *
 * `cause` is kept because the Settings log shows the detail and a user debugging
 * a local Ollama install needs the real message, not "unavailable".
 */
export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';

  constructor(
    message: string,
    readonly providerId: LlmProviderId,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

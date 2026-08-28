/**
 * §2.4's redaction pass, and the hard filter that sits in front of it.
 *
 * "The redaction pass strips account numbers and last4 before any call — and also
 * **counterparty names**, which are the most sensitive strings on a statement and
 * are not account numbers. Descriptors matching the P2P prefix list [...] are
 * **never sent to a provider at all** [...] This is a hard filter, not a
 * redaction, because a partially-masked personal name is still a personal name."
 *
 * ## Two mechanisms, because they are two different claims
 *
 * **Redaction** says: this string may go, with the account numbers taken out of
 * it. **The hard filter** says: this string may not go at all. §2.4 separates them
 * deliberately, and the reason is in its last clause — masking `ZELLE PAYMENT TO
 * SARAH M` down to `ZELLE PAYMENT TO SARAH M` accomplishes nothing, because the
 * sensitive part is not shaped like an account number. There is no redaction of a
 * personal name that leaves anything worth sending.
 *
 * ## This does not decide what is P2P
 *
 * `normalize`'s `isP2PDescriptor` already does, at normalization time, and carries
 * the answer on the result — its own note explains why: "A privacy control that
 * has to be remembered at every call site is a privacy control that eventually is
 * not." Re-deriving the rule here would create a second implementation to keep in
 * step with §2.4's list, and the two would disagree the first time either moved.
 *
 * So this takes the decision as input and enforces it. `redactBatch` drops flagged
 * entries and reports how many it dropped, because a caller that silently sent
 * fewer descriptors than it thought is a caller that cannot tell a filtered batch
 * from an empty provider.
 */

/** What a caller hands over: the text, and the verdict `normalize` already made. */
export interface RedactionCandidate {
  readonly id: string;
  readonly text: string;
  /** From `normalize`'s `isP2PDescriptor`, decided at normalization time. */
  readonly isP2P: boolean;
}

export interface RedactionResult {
  readonly sendable: readonly { readonly id: string; readonly text: string }[];
  /** Ids withheld by the hard filter. Reported rather than dropped silently. */
  readonly withheldP2P: readonly string[];
}

/**
 * Digit runs long enough to be an account or card number.
 *
 * Four or more, which is deliberately lower than the six §4.1 stage 3 uses for
 * reference tails: a `last4` is exactly four, and §2.4 names it. The cost of the
 * lower bound is that a store number goes too, and a merchant name is not improved
 * by one — where the cost of the higher bound is mailing the last four digits of a
 * card. The asymmetry decides it.
 */
const DIGIT_RUN = /\d{4,}/g;

/** `XXXX1234`, `****5678`, `x-4821` — a masked number is still a number, and the
 *  unmasked tail of one is exactly what `last4` means. */
const MASKED_TAIL = /[X*x•·]{2,}[-\s]?\d+/g;

/** `ACCT 12345`, `CARD #4821`, `ACCOUNT NO 7261` — the digits are caught above, but
 *  the label plus a short run is not, and `ACCT 7261` is a last4 with a word in
 *  front of it. */
const LABELLED_ACCOUNT = /\b(?:ACCT|ACCOUNT|CARD|CTX|REF)\b\s*(?:NO|NUM|NUMBER|#)?\s*[-#:]?\s*\d+/gi;

export const REDACTED = '[redacted]';

/**
 * Strip account-shaped strings from one piece of text.
 *
 * Substitution rather than deletion, for §4.1 stage 1's reason in a different
 * setting: removing a run glues its neighbours together, and `SQ *BLUE BOTTLE 1234
 * PORTLAND` becoming `SQ *BLUE BOTTLEPORTLAND` would hand the model a merchant
 * that does not exist. A visible marker also tells a reader of the degraded-call
 * log what happened.
 */
export function redactText(text: string): string {
  return text
    .replace(LABELLED_ACCOUNT, REDACTED)
    .replace(MASKED_TAIL, REDACTED)
    .replace(DIGIT_RUN, REDACTED)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Apply the hard filter, then redact what survives.
 *
 * The order is the point and is not an optimisation: a P2P descriptor is never
 * redacted-then-sent, it is dropped. Running redaction first would produce a
 * masked personal name, which §2.4 rejects in as many words.
 */
export function redactBatch(candidates: readonly RedactionCandidate[]): RedactionResult {
  const sendable: { id: string; text: string }[] = [];
  const withheldP2P: string[] = [];

  for (const candidate of candidates) {
    if (candidate.isP2P) {
      withheldP2P.push(candidate.id);
      continue;
    }
    sendable.push({ id: candidate.id, text: redactText(candidate.text) });
  }

  return { sendable, withheldP2P };
}

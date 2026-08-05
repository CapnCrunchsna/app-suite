/**
 * The P2P counterparty filter (§2.4).
 *
 * "Descriptors matching the P2P prefix list [...] are **never sent to a provider at
 * all**: the counterparty is a person, not a merchant, and normalization has nothing to
 * gain from them. This is a hard filter, not a redaction, because a partially-masked
 * personal name is still a personal name."
 *
 * No LLM provider exists in this build — providers are v0.5. The classification is
 * computed here anyway, and carried on `NormalizeResult`, so that the batching code in
 * §4.2 filters on a flag that was decided at normalization time rather than
 * re-deriving the rule at the call site. A privacy control that has to be remembered at
 * every call site is a privacy control that eventually is not.
 */

import { P2P_PREFIXES } from './tables.js';

export interface P2PCheckInput {
  /** The descriptor after stage 1 only — uppercased, whitespace-collapsed, with
   *  punctuation still intact. The prefixes are identified by their punctuation, and
   *  stage 2 has by definition already stripped `PAYPAL *` by the time it runs. */
  readonly upperDescriptor: string;
  /** The cleaned merchant key that came out of the chain. */
  readonly merchantKey: string;
  /** Canonical merchant keys already known to the system. */
  readonly knownMerchantKeys?: ReadonlySet<string>;
}

export function isP2PDescriptor(input: P2PCheckInput): boolean {
  const upper = input.upperDescriptor;

  for (const prefix of P2P_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }

  // §2.4 singles out `PAYPAL *` "where the tail is not in the known-merchant table".
  // PayPal carries both real merchants (`PAYPAL *SPOTIFYUSA`) and payments to people,
  // so the prefix alone cannot decide. Unknown tails are treated as people, which is
  // the safe direction: the cost is one merchant that never gets an LLM-suggested
  // name, against the cost of mailing someone's name to a provider.
  if (upper.startsWith('PAYPAL *') || upper.startsWith('PP*')) {
    const known = input.knownMerchantKeys;
    if (!known || !known.has(input.merchantKey)) return true;
  }

  return false;
}

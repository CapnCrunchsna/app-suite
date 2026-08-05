/**
 * The maintained lookup tables the deterministic chain runs against (§4.1).
 *
 * These are **expected to grow**. That is the whole reason §4 opens by saying this
 * chain "is separate from `collapse_v1` (§3.3) and may change freely" — adding a
 * processor prefix here must never change a dedupe key, and it does not, because the
 * dedupe key never calls this code. See `collapse.ts` in `ledgerline-domain`.
 */

/**
 * Payment-processor prefixes, from §4.1 stage 2.
 *
 * "Notably these often *hide* the real merchant behind Square/Toast/PayPal — the rule
 * strips the prefix and keeps what follows." `SQ *BLUE BOTTLE` is Blue Bottle, not
 * Square, and grouping every Square-processed charge under one merchant would merge a
 * coffee shop with a barber.
 *
 * Ordered longest-first so `DEBIT CARD PURCHASE` is tried before any shorter prefix
 * that happens to be its own prefix.
 */
export const PROCESSOR_PREFIXES: readonly string[] = [
  'DEBIT CARD PURCHASE',
  'RECURRING PMT',
  'POS DEBIT',
  'ACH DEBIT',
  'PAYPAL *',
  'WWW.',
  'TST*',
  'SQ *',
  'PP*',
  'IN *',
  'SP ',
];

/** US state and territory codes, for the trailing-geography rule in §4.1 stage 4. */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
]);

/** Country codes seen trailing on card-network descriptors. */
export const COUNTRY_CODES: ReadonlySet<string> = new Set(['USA', 'US', 'CAN', 'GBR', 'MEX']);

/**
 * Descriptor prefixes whose tail is a **person, not a merchant** (§2.4).
 *
 * These are never sent to an LLM provider — a hard filter, not a redaction, "because a
 * partially-masked personal name is still a personal name." No provider exists in this
 * build; the classification is computed here so the seam is correct the day one is
 * added, rather than being retrofitted onto a call site that already leaked.
 */
export const P2P_PREFIXES: readonly string[] = [
  'ZELLE',
  'VENMO',
  'CASH APP',
  'SQUARE CASH',
  'CHECK #',
  'CHECK#',
];

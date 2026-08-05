/**
 * Format signatures — the `detect` stage of §2.5.
 *
 * "For CSV, hash the header row into a *format signature* and look up a
 * `format_profile`." A bank's export header is stable across months, so the signature
 * is what makes the second statement from an institution import without asking
 * anything. `format_profile.header_signature` is UNIQUE (§3.1).
 *
 * **This value gets persisted**, so `normalizeHeaderToken` is stable-by-contract, though in
 * a weaker sense than `collapseV1`: changing it orphans every stored profile, which then
 * stops matching its own bank's exports. That failure is recoverable — a signature is
 * regenerable from any statement, and `POST /api/format-profiles/match` (§2.3) exists to
 * re-offer a near match — so it does not need `collapse_v1`'s versioning ceremony. It does
 * need a migration that recomputes stored signatures, and an import that suddenly lands in
 * `needs_mapping` for every account is the symptom of having forgotten one.
 */

import { createHash } from 'node:crypto';

export interface HeaderSignature {
  /** sha256 of the normalized tokens, joined by `|`. */
  readonly signature: string;
  /** The normalized tokens themselves, kept for fuzzy matching and for showing the
   *  user *why* a profile did or did not match. */
  readonly tokens: readonly string[];
}

/**
 * Normalization is deliberately aggressive: case, surrounding whitespace, internal
 * whitespace runs and punctuation all carry no meaning in a column heading, and a bank
 * that changes `Transaction Date` to `Transaction date` has not changed its format.
 * What is *not* normalized away is word content or column order, because either of
 * those genuinely is a different format.
 */
export function normalizeHeaderToken(cell: string): string {
  return cell
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

export function headerSignature(headerCells: readonly string[]): HeaderSignature {
  const tokens = headerCells.map(normalizeHeaderToken);
  const signature = createHash('sha256').update(tokens.join('|'), 'utf8').digest('hex');
  return { signature, tokens };
}

/**
 * Jaccard similarity over header tokens, for the "this looks like your Chase profile,
 * confirm?" path — plan artifact question 2, whose recommendation is to fuzzy-match and
 * *confirm* rather than either auto-applying or falling all the way back to the mapping
 * UI. A one-column header change should cost one click; confirmation is what keeps a
 * wrong guess from silently mis-mapping an amount column, which is the failure that
 * poisons every downstream finding.
 *
 * Matching is not automatic anywhere in this lib. This function returns a number; the
 * decision belongs to the caller and, per that recommendation, ultimately to the user.
 */
export function signatureSimilarity(
  a: readonly string[],
  b: readonly string[]
): number {
  const setA = new Set(a.filter((t) => t !== ''));
  const setB = new Set(b.filter((t) => t !== ''));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;

  return intersection / (setA.size + setB.size - intersection);
}

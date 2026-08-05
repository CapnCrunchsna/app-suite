/**
 * `collapse_v1` — the frozen descriptor collapse that feeds the dedupe key (§3.3).
 *
 * ## Read this before editing
 *
 * This function is **frozen**. It is deliberately *not* the merchant normalization
 * chain in `ledgerline-normalize`, and the two must never be merged.
 *
 * The normalization chain is a maintained, growing prefix table (§4 says so
 * explicitly). If the dedupe key depended on it, every addition to that table would
 * change `description_normalized` for historical rows, change every `dedupe_key`, and
 * cause the next overlapping import to re-insert rows it should have merged —
 * silently doubling a month of spend, with no error anywhere. §3.3 calls this out as
 * "the correctness condition the design session left implicit, and the one most likely
 * to be violated by accident."
 *
 * Changing the behaviour below means shipping a `collapseV2` *beside* this function
 * and a migration that recomputes every key inside one transaction — never an edit in
 * place. `transaction.dedupe_key_version` records which collapse produced each key,
 * and imports refuse to run while the table holds mixed versions.
 */

/** Stamped onto every row as `transaction.dedupe_key_version` (§3.3). */
export const COLLAPSE_VERSION = 'collapse_v1';

/** Frozen at 40 characters by §3.3. */
export const COLLAPSE_MAX_LENGTH = 40;

/**
 * Spec §3.3, applied in exactly this order: uppercase; fold diacritics to their base
 * letter; **replace** every character outside `[A-Z0-9 ]` with a space; collapse
 * whitespace runs to a single space; trim; truncate to 40; trim again, in case the
 * truncation landed on a space.
 *
 * ## Why substitute rather than delete
 *
 * Punctuation in a statement descriptor is almost always a *separator*: `TST*THE PLANT
 * CAFE`, `AMAZON.COM`, `7-ELEVEN`, `AMAZON - PRIME`. Deleting it glues tokens together
 * (`TSTTHE PLANT CAFE`) and, where the separator was itself spaced, leaves a double
 * space behind (`AMAZON  PRIME`).
 *
 * Neither breaks the dedupe key — both are deterministic, which is the only property
 * the key strictly requires — but both make it weaker than it should be. The key exists
 * so that the same transaction arriving in two overlapping statements hashes the same
 * way, and banks are not consistent about punctuation between exports. Under
 * delete-semantics `AMAZON - PRIME` and `AMAZON PRIME` produce different keys and the
 * merge rule re-inserts a row it should have absorbed. Substituting makes them equal.
 *
 * Diacritic folding is here for the same reason: `parser-port.ts` falls back to
 * Windows-1252 for files that are not valid UTF-8, so an accented merchant name can
 * reach this function, and deleting the accent alone would split `MÜLLER` into
 * `M LLER`.
 *
 * ## On the version name
 *
 * This definition was revised on 2026-08-04 — after the parser was written, but before
 * the first import and therefore before any row had ever been keyed. There is no
 * earlier `collapse_v1` in any database to stay compatible with, so the name still
 * refers unambiguously to one definition.
 *
 * From the first stored row onward that stops being true. Any further change means
 * shipping `collapseV2` *beside* this function plus a migration that recomputes every
 * key inside one transaction — never an edit here.
 */
export function collapseV1(descriptionRaw: string): string {
  return descriptionRaw
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COLLAPSE_MAX_LENGTH)
    .trim();
}

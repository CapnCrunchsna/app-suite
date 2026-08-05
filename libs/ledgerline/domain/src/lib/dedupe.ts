/**
 * The row-identity key — layer two of §3.3's idempotent re-import.
 *
 * Layer one is file identity (`statement_import.file_sha256`), which catches
 * re-uploading the same file. This layer catches the harder case: statements overlap,
 * so a re-issued statement or a date-ranged export pulled twice with different
 * endpoints contains rows you already have, inside a file with a different hash.
 *
 * The key lives here in `domain` rather than in `normalize` for a reason that is
 * structural, not stylistic. §2.5 puts the dedupe stage in `data`, and §2.2's
 * `depConstraints` allow `type:data-access` to depend on `type:domain` and nothing
 * else — so `data` *cannot* reach the normalization chain even if someone wanted it
 * to. Keeping the frozen collapse and the key that uses it in `domain` makes the
 * separation §3.3 demands a consequence of the module graph rather than a convention
 * someone has to remember.
 */

import { createHash } from 'node:crypto';

import { COLLAPSE_VERSION, collapseV1 } from './collapse.js';

export interface DedupeKeyInput {
  readonly accountId: string;
  /** ISO `YYYY-MM-DD`. COALESCE(transaction_date, posted_date) — §7.1. */
  readonly effectiveDate: string;
  /** Signed integer cents, already in the house convention. */
  readonly amountCents: number;
  /** The verbatim statement descriptor, *before* any normalization. */
  readonly descriptionRaw: string;
}

/** Recorded as `transaction.dedupe_key_version` so a future `collapse_v2` migration
 *  can tell which rows still carry old keys (§3.3). */
export const DEDUPE_KEY_VERSION = COLLAPSE_VERSION;

/**
 * `sha256(account_id | effective_date | amount_cents | collapse_v1(description_raw))`
 * — §3.3, with `|` as a literal field separator.
 *
 * The serialization is part of the frozen contract, not an implementation detail: a
 * different join character or field order produces different keys for the same rows,
 * which is the same silent double-insert that changing `collapseV1` would cause.
 *
 * Note the key is **date-scoped**, which is what makes convergence hold. Two months of
 * the same $9.99 charge are two different keys, so a year-to-date export spanning
 * twelve monthly statements merges to zero inserts rather than colliding.
 */
export function dedupeKey(input: DedupeKeyInput): string {
  const material = [
    input.accountId,
    input.effectiveDate,
    String(input.amountCents),
    collapseV1(input.descriptionRaw),
  ].join('|');

  return createHash('sha256').update(material, 'utf8').digest('hex');
}

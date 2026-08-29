/**
 * The half of §2.6's scoring that one row can answer on its own.
 *
 * §2.6 scores a *pair* — two rows, an amount, a date gap — and that scoring lives
 * in `analyzers` where it belongs. Two of its six signals are different in kind:
 * they ask nothing about the counterpart. "Either side already belongs to a
 * `recurring_series` whose merchant is not a transfer-kind merchant" and "either
 * side's category `kind` is `spend` with a non-transfer canonical merchant" are
 * predicates over one transaction, applied to each side in turn.
 *
 * That matters because §6.3 puts a **manual** transfer toggle on every row, with
 * no counterpart and therefore no pair to score. The toggle is an override and
 * stays one — §4.3 makes a user's decision top precedence, and a row the user
 * says is a transfer is a transfer. But an override offered with no idea of how
 * implausible it is offers "not spending" beside an Amazon purchase in exactly
 * the tone it offers it beside a credit-card payment, and §2.6 already knows the
 * difference.
 *
 * So the predicate lives here, in the one lib both `analyzers` and `feature-shell`
 * may import (§2.2). Not copied into the UI: a second implementation of a scoring
 * rule is a second thing to keep in step with §2.6, and the copy would be the one
 * that silently stopped agreeing.
 */

/** `category.kind` (§3.1). */
export type CategoryKind = 'spend' | 'fee' | 'transfer' | 'income';

/** What one row contributes to §2.6's negative signals. Both fields are `null`
 *  where the row has no category or no canonical merchant — an unresolved
 *  descriptor is not evidence of anything either way. */
export interface TransferSignalRow {
  readonly categoryKind: CategoryKind | null;
  readonly merchantIsTransferKind: boolean | null;
}

/**
 * §2.6's second penalty, read literally: "**category `kind` is `spend`** with a
 * **non-transfer canonical merchant**".
 *
 * Both halves are required, so an unresolved descriptor sitting in a spend
 * category does not attract it — there is no canonical merchant there to vouch
 * that the money went to a real payee.
 */
export function isSpendAtRealMerchant(row: TransferSignalRow): boolean {
  return row.categoryKind === 'spend' && row.merchantIsTransferKind === false;
}

/**
 * Running-balance reconciliation: `balance[n] − balance[n−1] === amount[n]` (§6.1).
 *
 * This is the strongest validation available at parse time. A file that reconciles has
 * proved three things at once — the amount column really is the amount column, the
 * amount and balance columns agree, and no row was dropped or duplicated. §2.5 notes
 * that "a silently misparsed amount column poisons every downstream finding, and it is
 * very hard to notice after the fact"; a reconciliation failure is that same error,
 * caught on the import screen with the offending row pointed at.
 *
 * ## What it cannot prove, and why
 *
 * **The sign convention.** `signConvention: 'invert'` is applied to the balance as well
 * as the amount — it has to be, or the arithmetic would never hold for a credit-card
 * export — so both sides flip together and `(−b[n]) − (−b[n−1]) === −a[n]` reconciles
 * exactly as well as the correct orientation. A profile with `invert` set backwards
 * produces a perfectly reconciling file in which every number in the app has the wrong
 * sign, which is worse than not reconciling at all.
 *
 * `checkSignPlausibility` is the separate check for that. It is weaker — a heuristic on
 * one account type rather than an identity — but it is aimed at the one thing
 * reconciliation is structurally blind to.
 *
 * Row order is tested rather than assumed. Banks export newest-first about as often as
 * oldest-first, and a profile author should not have to know which — if the file
 * reconciles in either direction, that direction is reported.
 */

import type {
  AccountType,
  BalanceCheck,
  BalanceMismatch,
  ParseWarning,
  RawRow,
} from '@metrum/ledgerline-domain';

interface DirectionResult {
  readonly failures: BalanceMismatch[];
  readonly rowsChecked: number;
}

function checkChronological(rows: readonly RawRow[]): DirectionResult {
  const failures: BalanceMismatch[] = [];
  let rowsChecked = 0;

  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    if (previous.balanceCents === null || current.balanceCents === null) continue;

    rowsChecked += 1;
    const expected = current.balanceCents - previous.balanceCents;
    if (expected !== current.amountCents) {
      failures.push({
        rowIndex: current.rowIndex,
        expectedCents: expected,
        actualCents: current.amountCents,
        deltaCents: current.amountCents - expected,
      });
    }
  }

  return { failures, rowsChecked };
}

export function checkBalances(rows: readonly RawRow[]): BalanceCheck {
  const withBalance = rows.filter((r) => r.balanceCents !== null);

  if (withBalance.length < 2) {
    return {
      kind: 'unavailable',
      reason:
        withBalance.length === 0
          ? 'no balance column mapped, or no row carried a balance'
          : 'only one row carried a balance; at least two consecutive rows are needed',
    };
  }

  const ascending = checkChronological(rows);
  if (ascending.failures.length === 0 && ascending.rowsChecked > 0) {
    return { kind: 'reconciled', order: 'ascending', rowsChecked: ascending.rowsChecked };
  }

  const descending = checkChronological([...rows].reverse());
  if (descending.failures.length === 0 && descending.rowsChecked > 0) {
    return { kind: 'reconciled', order: 'descending', rowsChecked: descending.rowsChecked };
  }

  const best =
    descending.failures.length < ascending.failures.length
      ? { result: descending, order: 'descending' as const }
      : { result: ascending, order: 'ascending' as const };

  return {
    kind: 'mismatch',
    bestOrder: best.order,
    rowsChecked: best.result.rowsChecked,
    failureCount: best.result.failures.length,
    // Cap the listing, not the count. A profile with the wrong sign convention fails on
    // every row, and a thousand identical warnings communicate less than the first
    // handful — but the caller still needs to know it was every row, not ten.
    failures: best.result.failures.slice(0, 10),
  };
}

/**
 * The check reconciliation is blind to: is `signConvention` the right way round?
 *
 * There is exactly one unambiguous signal available, and only for deposit accounts. A
 * checking or savings balance is money you have, so it is normally positive. If the
 * parsed balances come out mostly negative, the profile is inverted — the account is
 * not overdrawn for a whole statement.
 *
 * Credit cards are deliberately excluded. A card's balance is a debt, sometimes printed
 * positive and sometimes negative depending on the institution, and a genuine credit
 * balance after a refund is legal — there is no orientation this function could assume
 * without inventing a convention the spec does not state. §3.1 fixes the sign of
 * `amount_cents`, not of `balance_cents`.
 *
 * A heuristic, so it warns rather than failing: a real account really can be overdrawn.
 */
export function checkSignPlausibility(
  rows: readonly RawRow[],
  accountTypeHint: AccountType | null
): ParseWarning | null {
  if (accountTypeHint !== 'checking' && accountTypeHint !== 'savings') return null;

  const balances = rows
    .map((r) => r.balanceCents)
    .filter((b): b is number => b !== null && b !== 0);
  if (balances.length < 3) return null;

  const negative = balances.filter((b) => b < 0).length;
  if (negative <= balances.length / 2) return null;

  return {
    kind: 'sign_convention_suspect',
    message:
      `${negative} of ${balances.length} balances on this ${accountTypeHint} account are negative. ` +
      `A deposit account is not overdrawn for a whole statement, so the profile's signConvention is ` +
      `probably backwards — which would invert every amount in the file while still reconciling.`,
  };
}

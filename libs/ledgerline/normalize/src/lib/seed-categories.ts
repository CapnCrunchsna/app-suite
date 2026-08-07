/**
 * A starter category set, in the same spirit — and with the same caveat — as
 * `SEED_ALIASES`.
 *
 * It is **not** a taxonomy. §3.1's `category.kind` CHECK enumerates the four kinds
 * the rest of the design reasons about (`spend`, `fee`, `transfer`, `income`) and
 * those four are load-bearing: §5.8 groups fees, §2.6 and §5.1 need `transfer` to
 * stay out of spend totals, and §5.10's category trends need *something* to trend.
 * The names under each kind are a starting point so §6.3's "assign category" has
 * something to assign before §4.2's LLM categorization exists, and so the
 * `category_source = 'user'` path is exercised by real data rather than only by
 * tests.
 *
 * Nothing derives thresholds or behaviour from these ids. §7.6 applies: they are
 * uncalibrated, and the first real statement corpus is what settles them.
 *
 * `overlap_group` is deliberately left unset. §5.4's duplicate-service detection
 * reads it, and guessing which services overlap before the analyzer exists would
 * be inventing the answer to that rule's hardest question.
 */

export interface SeedCategory {
  readonly id: string;
  readonly name: string;
  readonly kind: 'spend' | 'fee' | 'transfer' | 'income';
}

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  { id: 'groceries', name: 'Groceries', kind: 'spend' },
  { id: 'dining', name: 'Dining & Coffee', kind: 'spend' },
  { id: 'transport', name: 'Transport', kind: 'spend' },
  { id: 'shopping', name: 'Shopping', kind: 'spend' },
  { id: 'subscriptions', name: 'Subscriptions', kind: 'spend' },
  { id: 'utilities', name: 'Utilities', kind: 'spend' },
  { id: 'housing', name: 'Housing', kind: 'spend' },
  { id: 'health', name: 'Health', kind: 'spend' },
  { id: 'insurance', name: 'Insurance', kind: 'spend' },
  { id: 'entertainment', name: 'Entertainment', kind: 'spend' },
  { id: 'bank-fees', name: 'Bank Fees', kind: 'fee' },
  { id: 'interest', name: 'Interest', kind: 'fee' },
  { id: 'transfer', name: 'Transfer', kind: 'transfer' },
  { id: 'card-payment', name: 'Card Payment', kind: 'transfer' },
  { id: 'income', name: 'Income', kind: 'income' },
  { id: 'refund', name: 'Refund', kind: 'income' },
];

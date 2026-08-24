/**
 * A deliberately small seed alias set (`source = 'seed'`, §3.1's `merchant_alias`).
 *
 * These exist so the chain has something to resolve against out of the box and so the
 * precedence rules in §4.3 are exercised by real data rather than only by tests. It is
 * **not** an attempt at a merchant database — §4.1 step 7 is the designed answer for
 * everything not listed here, and the review queue plus §6.3's bulk "apply to all
 * matching" is how the real table gets built from actual statements.
 *
 * `is_known_subscription` on `merchant_canonical` (§3.1) is what §5.2 reads for its
 * confidence bonus; it is recorded here alongside each entry so the merchant rows can
 * be seeded from the same source when the schema lands. `default_category_id` is
 * carried the same way, and is the whole of §2.5's rule-based categorizer — see the
 * note on `SeedMerchant.defaultCategoryId`.
 */

import type { MerchantAlias } from './alias.js';

export interface SeedMerchant {
  readonly merchantId: string;
  readonly displayName: string;
  readonly isKnownSubscription: boolean;
  /**
   * `merchant_canonical.default_category_id` (§3.1) — and, through it, the whole
   * of §2.5's "**Category assigned by rule**, then optionally by LLM".
   *
   * The rule is one line long on purpose: *a resolved merchant's default category
   * is the transaction's category, recorded as `category_source = 'rule'`*. There
   * is no keyword table, no second chain, and nothing that could disagree with §4
   * about what a row's merchant is — the merchant chain already answers the hard
   * question, and a category is a property of the merchant it produced. §4.2's LLM
   * stage is what the ids below are *not* an attempt to be.
   *
   * An id from `SEED_CATEGORIES`, never a free string: `default_category_id` is a
   * real foreign key, and the composition root upserts the categories before the
   * merchants precisely so it resolves.
   *
   * §7.6 applies to every assignment here exactly as it does to the merchant set
   * itself — these are starting points, not a taxonomy, and the first real corpus
   * is what settles them. A user correction outranks all of it (§4.3).
   */
  readonly defaultCategoryId: string | null;
}

/**
 * The streaming four sit in `entertainment` rather than `subscriptions`, and the
 * split is deliberate. §5.10 excludes any category dominated >80% by a single
 * recurring series, so a catch-all `subscriptions` category would be excluded from
 * category trends about as often as it was populated — the trend would be the
 * subscription, which §5.2 and §5.5 already tell better. Splitting media from
 * tooling leaves both halves as things a spending trend can be *about*.
 */
export const SEED_MERCHANTS: readonly SeedMerchant[] = [
  { merchantId: 'netflix', displayName: 'Netflix', isKnownSubscription: true, defaultCategoryId: 'entertainment' },
  { merchantId: 'spotify', displayName: 'Spotify', isKnownSubscription: true, defaultCategoryId: 'entertainment' },
  { merchantId: 'hulu', displayName: 'Hulu', isKnownSubscription: true, defaultCategoryId: 'entertainment' },
  { merchantId: 'disney-plus', displayName: 'Disney+', isKnownSubscription: true, defaultCategoryId: 'entertainment' },
  { merchantId: 'amazon-prime', displayName: 'Amazon Prime', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'apple', displayName: 'Apple', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'google', displayName: 'Google', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'microsoft', displayName: 'Microsoft', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'dropbox', displayName: 'Dropbox', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'adobe', displayName: 'Adobe', isKnownSubscription: true, defaultCategoryId: 'subscriptions' },
  { merchantId: 'amazon', displayName: 'Amazon', isKnownSubscription: false, defaultCategoryId: 'shopping' },
  { merchantId: 'starbucks', displayName: 'Starbucks', isKnownSubscription: false, defaultCategoryId: 'dining' },
  { merchantId: 'uber', displayName: 'Uber', isKnownSubscription: false, defaultCategoryId: 'transport' },
  { merchantId: 'lyft', displayName: 'Lyft', isKnownSubscription: false, defaultCategoryId: 'transport' },
  { merchantId: 'costco', displayName: 'Costco', isKnownSubscription: false, defaultCategoryId: 'groceries' },
  { merchantId: 'target', displayName: 'Target', isKnownSubscription: false, defaultCategoryId: 'shopping' },
];

/**
 * Prefix aliases, because statement descriptors append store numbers, cities and
 * reference tails that stages 3–5 do not always fully remove. `NETFLIX` as a prefix
 * catches `NETFLIX COM` as well as bare `NETFLIX`.
 */
export const SEED_ALIASES: readonly MerchantAlias[] = [
  ['NETFLIX', 'netflix'],
  ['SPOTIFY', 'spotify'],
  ['HULU', 'hulu'],
  ['DISNEY PLUS', 'disney-plus'],
  ['DISNEYPLUS', 'disney-plus'],
  ['AMAZON PRIME', 'amazon-prime'],
  ['PRIME VIDEO', 'amazon-prime'],
  ['APPLE', 'apple'],
  ['ITUNES', 'apple'],
  ['GOOGLE', 'google'],
  ['MICROSOFT', 'microsoft'],
  ['MSFT', 'microsoft'],
  ['DROPBOX', 'dropbox'],
  ['ADOBE', 'adobe'],
  ['AMZN MKTP', 'amazon'],
  ['AMAZON MKTPL', 'amazon'],
  ['AMAZON COM', 'amazon'],
  ['STARBUCKS', 'starbucks'],
  ['UBER EATS', 'uber'],
  ['UBER TRIP', 'uber'],
  ['UBER', 'uber'],
  ['LYFT', 'lyft'],
  ['COSTCO', 'costco'],
  ['TARGET', 'target'],
].map(([aliasKey, merchantId]) => ({
  aliasKey,
  merchantId,
  matchType: 'prefix' as const,
  confidence: 1,
  source: 'seed' as const,
}));

/** Canonical keys, for the `PAYPAL *` branch of the P2P filter (§2.4). */
export const SEED_MERCHANT_KEYS: ReadonlySet<string> = new Set(
  SEED_ALIASES.map((alias) => alias.aliasKey)
);

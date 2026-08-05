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
 * be seeded from the same source when the schema lands.
 */

import type { MerchantAlias } from './alias.js';

export interface SeedMerchant {
  readonly merchantId: string;
  readonly displayName: string;
  readonly isKnownSubscription: boolean;
}

export const SEED_MERCHANTS: readonly SeedMerchant[] = [
  { merchantId: 'netflix', displayName: 'Netflix', isKnownSubscription: true },
  { merchantId: 'spotify', displayName: 'Spotify', isKnownSubscription: true },
  { merchantId: 'hulu', displayName: 'Hulu', isKnownSubscription: true },
  { merchantId: 'disney-plus', displayName: 'Disney+', isKnownSubscription: true },
  { merchantId: 'amazon-prime', displayName: 'Amazon Prime', isKnownSubscription: true },
  { merchantId: 'apple', displayName: 'Apple', isKnownSubscription: true },
  { merchantId: 'google', displayName: 'Google', isKnownSubscription: true },
  { merchantId: 'microsoft', displayName: 'Microsoft', isKnownSubscription: true },
  { merchantId: 'dropbox', displayName: 'Dropbox', isKnownSubscription: true },
  { merchantId: 'adobe', displayName: 'Adobe', isKnownSubscription: true },
  { merchantId: 'amazon', displayName: 'Amazon', isKnownSubscription: false },
  { merchantId: 'starbucks', displayName: 'Starbucks', isKnownSubscription: false },
  { merchantId: 'uber', displayName: 'Uber', isKnownSubscription: false },
  { merchantId: 'lyft', displayName: 'Lyft', isKnownSubscription: false },
  { merchantId: 'costco', displayName: 'Costco', isKnownSubscription: false },
  { merchantId: 'target', displayName: 'Target', isKnownSubscription: false },
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

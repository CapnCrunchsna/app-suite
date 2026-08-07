/**
 * The composition root (§2.2: "The only place the pure libs meet `data`").
 *
 * `parsing` produces `RawRow[]` and never touches the database. `normalize`
 * returns values and never writes. `data` is the only lib that knows a store
 * exists and cannot reach either of the other two — `type:data-access` may
 * depend on `type:domain` and nothing else. Everything therefore has to be wired
 * together *somewhere*, and this file is that somewhere; the lint rule in
 * `eslint.config.mjs` is what stops it from being anywhere else.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LedgerlineStore } from '@metrum/ledgerline-data';
import type { FormatProfileRecord } from '@metrum/ledgerline-data';
import { SEED_ALIASES, SEED_CATEGORIES, SEED_MERCHANTS } from '@metrum/ledgerline-normalize';
import { createNodeCsvParser, loadProfile } from '@metrum/ledgerline-parsing';
import type { ColumnRef, ColumnRole, FormatProfile, ParserPort } from '@metrum/ledgerline-parsing';

export interface LedgerlineContext {
  readonly store: LedgerlineStore;
  /** Registered in §2.5's priority order. Only the CSV implementation exists;
   *  `NodePdfParser` slots in ahead of nothing, which is the point of the port. */
  readonly parsers: readonly ParserPort[];
  readonly profileLoadErrors: readonly string[];
  close(): void;
}

export interface CreateContextOptions {
  readonly databaseFile: string;
  readonly profilesDir?: string | null;
}

export function createContext(options: CreateContextOptions): LedgerlineContext {
  const store = LedgerlineStore.open({ filename: options.databaseFile });

  seedMerchants(store);
  const profileLoadErrors = options.profilesDir ? seedProfiles(store, options.profilesDir) : [];

  // The resolver is injected rather than looked up, which is what keeps
  // `parsing` pure: profiles live in `format_profile` and `type:parsing` may not
  // reach `type:data-access`.
  const csvParser = createNodeCsvParser(({ signature }) => {
    const record = store.formatProfiles.findByHeaderSignature(signature.signature);
    return record ? toFormatProfile(record) : null;
  });

  return {
    store,
    parsers: [csvParser],
    profileLoadErrors,
    close: () => store.close(),
  };
}

/**
 * §4.1's alias table, seeded from `normalize`'s shipped set.
 *
 * `data` cannot import those constants, so the composition root carries them
 * across. The merchants keep their stable seed ids (`netflix`, `spotify`) —
 * that is what the alias rows reference, and what makes the seeding idempotent
 * across boots.
 */
function seedMerchants(store: LedgerlineStore): void {
  // Categories first: `merchant_canonical.default_category_id` and
  // `transaction.category_id` are both real foreign keys (§3.2), so nothing can
  // reference a category that has not been inserted yet.
  for (const category of SEED_CATEGORIES) {
    store.merchants.upsertCategory(category);
  }

  for (const merchant of SEED_MERCHANTS) {
    store.merchants.upsertSeed({
      id: merchant.merchantId,
      // The alias table matches on the normalized descriptor, so the canonical
      // name is the uppercase form the §4 chain produces, not the display name.
      canonicalName: merchant.displayName.toUpperCase(),
      displayName: merchant.displayName,
      isKnownSubscription: merchant.isKnownSubscription,
    });
  }

  for (const alias of SEED_ALIASES) {
    store.merchants.upsertAlias({
      aliasKey: alias.aliasKey,
      merchantId: alias.merchantId,
      matchType: alias.matchType,
      confidence: alias.confidence,
      source: alias.source,
    });
  }
}

/**
 * Load `profiles/*.json` into `format_profile`.
 *
 * Profiles are hand-written files until the in-app column mapper exists (§6.1),
 * and `loadProfile` refuses anything ambiguous. A bad profile is reported rather
 * than thrown: one malformed file should not stop the API from starting, or
 * every other bank becomes unimportable because of a typo in one.
 */
function seedProfiles(store: LedgerlineStore, profilesDir: string): string[] {
  const errors: string[] = [];
  let filenames: string[];

  try {
    filenames = readdirSync(profilesDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [`profiles directory ${profilesDir} could not be read`];
  }

  for (const filename of filenames) {
    const path = join(profilesDir, filename);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      errors.push(`${filename}: not valid JSON (${(cause as Error).message})`);
      continue;
    }

    const loaded = loadProfile(parsed);
    if (!loaded.ok) {
      errors.push(`${filename}: ${loaded.errors.join('; ')}`);
      continue;
    }

    store.formatProfiles.upsert({
      id: loaded.profile.id,
      institution: loaded.profile.institution,
      accountTypeHint: loaded.profile.accountTypeHint,
      headerSignature: loaded.profile.headerSignature,
      headerTokens: loaded.profile.headerTokens,
      hasHeader: loaded.profile.hasHeader,
      delimiter: loaded.profile.delimiter,
      skipLines: loaded.profile.skipLines,
      columnMapJson: JSON.stringify(loaded.profile.columnMap),
      dateFormat: loaded.profile.dateFormat,
      amountMode: loaded.profile.amountMode,
      signConvention: loaded.profile.signConvention,
      pendingValues: loaded.profile.pendingValues,
      currency: loaded.profile.currency,
      version: loaded.profile.version,
      source: loaded.profile.source,
    });
  }

  return errors;
}

/** `format_profile` row → the parser's value type. The only conversion in the
 *  system, and the reason `data` restates the profile shape rather than
 *  importing it. */
export function toFormatProfile(record: FormatProfileRecord): FormatProfile {
  return {
    id: record.id,
    institution: record.institution,
    accountTypeHint: record.accountTypeHint,
    headerSignature: record.headerSignature,
    headerTokens: record.headerTokens,
    hasHeader: record.hasHeader,
    delimiter: record.delimiter,
    skipLines: record.skipLines,
    dateFormat: record.dateFormat,
    amountMode: record.amountMode,
    signConvention: record.signConvention,
    columnMap: JSON.parse(record.columnMapJson) as Partial<Record<ColumnRole, ColumnRef>>,
    pendingValues: record.pendingValues,
    currency: record.currency,
    version: record.version,
    source: record.source,
  };
}

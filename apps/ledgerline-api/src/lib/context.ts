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

import { JobRunner } from './job-runner.js';

export interface LedgerlineContext {
  readonly store: LedgerlineStore;
  /** Registered in §2.5's priority order. Only the CSV implementation exists;
   *  `NodePdfParser` slots in ahead of nothing, which is the point of the port. */
  readonly parsers: readonly ParserPort[];
  /** §2.7's in-process consumer. Here rather than inside `store` because what a
   *  job *does* is run the §4 chain and the §5 rules, and `data` may reach
   *  neither (§2.2) — the queue is a table, the runner is composition. */
  readonly jobRunner: JobRunner;
  readonly profileLoadErrors: readonly string[];
  close(): void;
}

export interface CreateContextOptions {
  readonly databaseFile: string;
  readonly profilesDir?: string | null;
}

/**
 * Every row a fresh install starts with: §5's categories, §4's seed merchants and
 * aliases, and the shipped format profiles.
 *
 * Exported because `DELETE /api/data` (§6.8) has to put them back. A wipe that left
 * the app with no categories and no merchant aliases would not be a fresh install —
 * it would be a broken one, and the next import would build a provisional merchant
 * for every descriptor §4 already knows.
 */
export function seedReferenceData(
  store: LedgerlineStore,
  profilesDir: string | null,
): readonly string[] {
  seedMerchants(store);
  return profilesDir ? seedProfiles(store, profilesDir) : [];
}

export function createContext(options: CreateContextOptions): LedgerlineContext {
  const store = LedgerlineStore.open({ filename: options.databaseFile });

  const profileLoadErrors = seedReferenceData(store, options.profilesDir ?? null);

  // A job left `running` by a process that died is not running anywhere (§2.7:
  // the queue is a table, the runner is this process). Returning it to the queue
  // at boot is what makes an interrupted re-normalize finish instead of showing
  // a spinner nothing will ever advance.
  store.jobs.requeueStranded();

  // The resolver is injected rather than looked up, which is what keeps
  // `parsing` pure: profiles live in `format_profile` and `type:parsing` may not
  // reach `type:data-access`.
  const csvParser = createNodeCsvParser(({ signature }) => {
    const record = store.formatProfiles.findByHeaderSignature(signature.signature);
    return record ? toFormatProfile(record) : null;
  });

  // The runner takes the context it runs jobs against, and the context holds the
  // runner — a handler re-runs the whole §4 chain and the whole of §5, so it
  // needs everything. Built in two steps with the field mutable only here, which
  // is cheaper than a two-phase factory every caller would have to know about.
  const context: { -readonly [K in keyof LedgerlineContext]: LedgerlineContext[K] } = {
    store,
    parsers: [csvParser],
    jobRunner: undefined as unknown as JobRunner,
    profileLoadErrors,
    close: () => store.close(),
  };
  context.jobRunner = new JobRunner(context);

  return context;
}

/**
 * §4.1's alias table, seeded from `normalize`'s shipped set.
 *
 * `data` cannot import those constants, so the composition root carries them
 * across. The merchants keep their stable seed ids (`netflix`, `spotify`) —
 * that is what the alias rows reference, and what makes the seeding idempotent
 * across boots.
 */
export function seedMerchants(store: LedgerlineStore): void {
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
      // §2.5's `normalize` stage: "Category assigned by rule". The rule is the
      // merchant's own default, and this is the column that carries it — without
      // it `transaction.category_id` is never populated by anything and §5.10 has
      // nothing to trend (§9g, §9h).
      defaultCategoryId: merchant.defaultCategoryId,
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

  /**
   * The rows that were committed before the seed set had categories.
   *
   * §6.1 refuses a re-parse on a committed import, and rightly — but this is not
   * a re-parse. The categorizer is a property of the merchant, the merchant was
   * resolved when those rows landed, and the answer for a two-year-old row is the
   * same answer it would get today. Leaving them uncategorized would mean §5.10
   * trended only whatever was imported after this commit, and a coverage bar that
   * went green over months with no categories in them.
   *
   * At boot rather than behind an endpoint because it is idempotent and matches
   * nothing on the second call: `category_source IS NULL` excludes both the rows a
   * rule already did and the ones a human cleared on purpose. A backfill nobody
   * has to remember to run is one that has actually run. Recorded in §9h.
   */
  store.transactions.applyMerchantDefaultCategories();
}

/**
 * Load `profiles/*.json` into `format_profile`.
 *
 * Profiles are hand-written files until the in-app column mapper exists (§6.1),
 * and `loadProfile` refuses anything ambiguous. A bad profile is reported rather
 * than thrown: one malformed file should not stop the API from starting, or
 * every other bank becomes unimportable because of a typo in one.
 */
export function seedProfiles(store: LedgerlineStore, profilesDir: string): string[] {
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
      periodPattern: loaded.profile.periodPattern,
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
    periodPattern: record.periodPattern,
    amountMode: record.amountMode,
    signConvention: record.signConvention,
    columnMap: JSON.parse(record.columnMapJson) as Partial<Record<ColumnRole, ColumnRef>>,
    pendingValues: record.pendingValues,
    currency: record.currency,
    version: record.version,
    source: record.source,
  };
}

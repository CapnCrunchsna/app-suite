/**
 * §2.5's pipeline, wired end to end: `ingest → detect → parse → normalize →
 * dedupe → store`.
 *
 * Every stage below is owned by the lib §2.5 assigns it to. This file calls
 * them in order and hands the result to a repository — "libs compute; the app
 * persists" (§2.1). Nothing here reimplements a stage; where it looks like it
 * does, it is choosing between the values a stage returned.
 */

import { createHash } from 'node:crypto';

import { effectiveDate } from '@metrum/ledgerline-domain';
import type { BalanceCheck, ParseResult, ParseWarning, RawRow } from '@metrum/ledgerline-domain';
import type {
  CommitImportResult,
  CommitResolution,
  ImportPlan,
  IncomingRow,
  RawRowRecord,
  StatementImportRecord,
} from '@metrum/ledgerline-data';
import { normalizeBatch, SEED_MERCHANT_KEYS } from '@metrum/ledgerline-normalize';
import type { MerchantAlias } from '@metrum/ledgerline-normalize';
import {
  decodeStatementText,
  detectCsvFormat,
  selectParser,
  sniffFileKind,
} from '@metrum/ledgerline-parsing';

import { toFormatProfile } from './context.js';
import type { LedgerlineContext } from './context.js';
import { runTransferLinking } from './transfer-service.js';

export interface UploadedFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface AccountSuggestion {
  readonly accountId: string;
  readonly reason: string;
}

export interface StagedUpload {
  readonly import: StatementImportRecord;
  /** False when §3.3's layer one short-circuited a byte-identical re-upload. */
  readonly created: boolean;
  /** §6.1: the guess "must be confirmed", so it is returned rather than stored.
   *  `PATCH /api/imports/:id` setting `accountId` *is* the confirmation, and
   *  commit refuses without one. */
  readonly accountSuggestion: AccountSuggestion | null;
}

/** What the review screen reads (§6.1). */
export interface ImportReview {
  readonly import: StatementImportRecord;
  readonly accountSuggestion: AccountSuggestion | null;
  readonly warnings: readonly ParseWarning[];
  readonly balanceCheck: BalanceCheck;
  readonly rows: readonly ReviewRow[];
  readonly unparsedRows: readonly RawRowRecord[];
  readonly plan: ReviewPlan | null;
}

export interface ReviewRow {
  readonly rowIndex: number;
  readonly rawText: string;
  readonly row: RawRow;
  /** `insert` · `duplicate` (absorbed by the merge rule) · `near_duplicate`. */
  readonly disposition: 'insert' | 'duplicate' | 'near_duplicate';
}

export interface ReviewPlan {
  readonly willInsert: number;
  readonly alreadyPresent: number;
  readonly nearDuplicates: readonly {
    readonly rowIndex: number;
    readonly existingTransactionId: string;
    readonly existingEffectiveDate: string;
    readonly existingAmountCents: number;
    readonly existingDescriptionRaw: string;
    readonly existingIsPending: boolean;
    readonly dayGap: number;
    readonly amountDeltaCents: number;
    readonly pendingToPosted: boolean;
    readonly defaultResolution: 'replace' | 'keep_both' | 'skip';
  }[];
}

interface Diagnostics {
  readonly warnings: readonly ParseWarning[];
  readonly balanceCheck: BalanceCheck;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * §2.5's `ingest` and `detect` stages, then `parse` when a profile matched.
 *
 * The three outcomes are distinct on purpose. `needs_mapping` is a file this
 * app can read once a human maps its columns — §6.1's mapper. `failed` is a file
 * it cannot read at all. Collapsing them would put the mapping UI in front of a
 * PDF.
 */
export async function stageUpload(
  context: LedgerlineContext,
  file: UploadedFile,
): Promise<StagedUpload> {
  const fileSha256 = sha256(file.bytes);

  const existing = context.store.imports.findByFileSha256(fileSha256);
  if (existing) {
    return {
      import: existing,
      created: false,
      accountSuggestion: suggestAccount(context, existing.sourceFilename, null),
    };
  }

  const kind = sniffFileKind(file.bytes);
  if (kind !== 'csv') {
    return stageUnreadable(
      context,
      file,
      fileSha256,
      kind === 'pdf'
        ? 'PDF ingest is not built yet (roadmap v0.4). Export the statement as CSV.'
        : 'not a delimited text file',
    );
  }

  const text = decodeStatementText(file.bytes);
  const profiles = context.store.formatProfiles.list().map(toFormatProfile);
  const detection = detectCsvFormat(text, profiles);

  if (detection.kind === 'undetectable') {
    return stageUnreadable(context, file, fileSha256, detection.reason);
  }

  if (detection.kind === 'needs_mapping') {
    const staged = context.store.imports.stage({
      sourceFilename: file.filename,
      fileSha256,
      fileBytes: file.bytes,
      status: 'needs_mapping',
      errorDetail:
        `no format profile matches header signature ${detection.signature.signature.slice(0, 12)}… ` +
        `(columns: ${detection.signature.tokens.join(', ')})`,
      diagnosticsJson: JSON.stringify({
        suggestions: detection.suggestions.map((s) => ({
          profileId: s.profile.id,
          institution: s.profile.institution,
          similarity: s.similarity,
        })),
        sampleRows: detection.sampleRows,
        headerSignature: detection.signature.signature,
        headerTokens: detection.signature.tokens,
      }),
    });
    return {
      import: staged.import,
      created: staged.created,
      accountSuggestion: suggestAccount(context, file.filename, null),
    };
  }

  const selected = await selectParser(
    context.parsers,
    { filename: file.filename, sizeBytes: file.bytes.byteLength },
    file.bytes,
  );
  if (!selected) {
    return stageUnreadable(context, file, fileSha256, 'no registered parser claimed this file');
  }

  let parsed: ParseResult;
  try {
    parsed = await selected.parser.parse(
      { filename: file.filename, sizeBytes: file.bytes.byteLength },
      file.bytes,
    );
  } catch (cause) {
    return stageUnreadable(context, file, fileSha256, (cause as Error).message);
  }

  const staged = context.store.imports.stage({
    sourceFilename: file.filename,
    fileSha256,
    fileBytes: file.bytes,
    formatProfileId: parsed.profileId,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    rowsParsed: parsed.rows.length,
    status: 'staged',
    parser: parsed.parser,
    parserVersion: parsed.parserVersion,
    diagnosticsJson: JSON.stringify({
      warnings: parsed.warnings,
      balanceCheck: parsed.balanceCheck,
    } satisfies Diagnostics),
    rawRows: toStagedRawRows(parsed),
  });

  return {
    import: staged.import,
    created: staged.created,
    accountSuggestion: suggestAccount(context, file.filename, detection.profile.accountTypeHint),
  };
}

function stageUnreadable(
  context: LedgerlineContext,
  file: UploadedFile,
  fileSha256: string,
  reason: string,
): StagedUpload {
  const staged = context.store.imports.stage({
    sourceFilename: file.filename,
    fileSha256,
    fileBytes: file.bytes,
    status: 'failed',
    errorDetail: reason,
  });
  return { import: staged.import, created: staged.created, accountSuggestion: null };
}

/**
 * `raw_row` keeps both halves of the parse (§2.5). Rows that failed are stored
 * rather than dropped: §6.1's review screen shows "unparsed rows", and a parse
 * that silently discards what it could not read is exactly the misparse
 * review-before-commit exists to catch.
 */
function toStagedRawRows(parsed: ParseResult) {
  const ok = parsed.rows.map((row) => ({
    rowIndex: row.rowIndex,
    rawText: row.rawText,
    parsedJson: JSON.stringify(row),
    parseStatus: 'ok' as const,
    parseSource: row.parseSource,
  }));
  const failed = parsed.errors.map((row) => ({
    rowIndex: row.rowIndex,
    rawText: row.rawText,
    parsedJson: JSON.stringify({ errors: row.errors }),
    parseStatus: 'error' as const,
    parseSource: row.parseSource,
  }));
  return [...ok, ...failed].sort((a, b) => a.rowIndex - b.rowIndex);
}

/**
 * §6.1: "Account assignment is auto-guessed from the filename and statement
 * header and must be confirmed."
 *
 * Deliberately shallow — last4 in the filename, then a unique account of the
 * profile's hinted type. A guess that has to be confirmed can afford to be
 * wrong; the cost of being clever here is a confirmed-by-reflex assignment that
 * files a credit-card statement into a checking account.
 */
function suggestAccount(
  context: LedgerlineContext,
  filename: string,
  accountTypeHint: string | null,
): AccountSuggestion | null {
  const accounts = context.store.accounts.list().filter((account) => account.isActive);

  const byLast4 = accounts.find(
    (account) => account.last4 !== null && filename.includes(account.last4),
  );
  if (byLast4) {
    return { accountId: byLast4.id, reason: `filename contains last4 ${byLast4.last4}` };
  }

  const byName = accounts.find((account) =>
    filename.toLowerCase().includes(account.displayName.toLowerCase().split(' ')[0]),
  );
  if (byName) {
    return { accountId: byName.id, reason: `filename resembles "${byName.displayName}"` };
  }

  if (accountTypeHint) {
    const ofType = accounts.filter((account) => account.accountType === accountTypeHint);
    if (ofType.length === 1) {
      return { accountId: ofType[0].id, reason: `only ${accountTypeHint} account` };
    }
  }

  return null;
}

// ------------------------------------------------------------- normalize ---

/**
 * §2.5's `normalize` stage, then the shape `data`'s merge rule consumes.
 *
 * Two things are load-bearing here. The alias table is read from the store and
 * passed *in* — `normalize` "returns values, never writes" (§2.2). And
 * `descriptionRaw` is carried through untouched, because the dedupe key is
 * computed from the raw descriptor through the frozen `collapse_v1`, never from
 * the normalized form this function also produces (§3.3).
 */
export function buildIncomingRows(
  context: LedgerlineContext,
  importId: string,
): { rows: IncomingRow[]; unparsed: RawRowRecord[] } {
  const rawRows = context.store.imports.listRawRows(importId);
  const parsedRows = rawRows.filter((row) => row.parseStatus === 'ok' && row.parsedJson !== null);
  const unparsed = rawRows.filter((row) => row.parseStatus === 'error');

  const hydrated = parsedRows.map((record) => ({
    record,
    row: JSON.parse(record.parsedJson as string) as RawRow,
  }));

  const aliases: MerchantAlias[] = context.store.merchants.listAliases().map((alias) => ({
    aliasKey: alias.aliasKey,
    merchantId: alias.merchantId,
    matchType: alias.matchType,
    confidence: alias.confidence ?? 1,
    source: alias.source,
  }));

  const normalized = normalizeBatch(
    hydrated.map((entry) => entry.row.descriptionRaw),
    { aliases, knownMerchantKeys: SEED_MERCHANT_KEYS, trace: false },
  );

  const rows = hydrated.map((entry, index) => {
    const result = normalized[index];
    const merchantId = resolveMerchant(context, result.resolution);

    return {
      rowIndex: entry.row.rowIndex,
      rawRowId: entry.record.id,
      transactionDate: entry.row.transactionDate,
      postedDate: entry.row.postedDate,
      effectiveDate:
        effectiveDate(entry.row.transactionDate, entry.row.postedDate) ?? entry.row.effectiveDate,
      amountCents: entry.row.amountCents,
      balanceCents: entry.row.balanceCents,
      currency: entry.row.currency,
      descriptionRaw: entry.row.descriptionRaw,
      descriptionNormalized: result.descriptionNormalized,
      merchantId,
      isPending: entry.row.status === 'pending',
    } satisfies IncomingRow;
  });

  return { rows, unparsed };
}

/**
 * §4.1 step 7: an unresolved descriptor "becomes a provisional merchant, marked
 * `source = 'rule'`, and joins the review queue."
 *
 * The provisional merchant also gets an exact `rule` alias, so the next
 * statement carrying the same descriptor resolves through stage 6 instead of
 * creating a second provisional. §4.3's precedence keeps that alias below `seed`
 * and `user`, so a later correction still wins.
 */
function resolveMerchant(
  context: LedgerlineContext,
  resolution: { kind: 'alias'; merchantId: string } | { kind: 'provisional'; name: string },
): string | null {
  if (resolution.kind === 'alias') return resolution.merchantId;
  if (resolution.name.trim() === '') return null;

  const merchant = context.store.merchants.getOrCreateProvisional(resolution.name);
  context.store.merchants.upsertAlias({
    aliasKey: resolution.name,
    merchantId: merchant.id,
    matchType: 'exact',
    confidence: 1,
    source: 'rule',
  });
  return merchant.id;
}

// ---------------------------------------------------------------- review ---

export function reviewImport(context: LedgerlineContext, importId: string): ImportReview {
  const record = context.store.imports.getOrThrow(importId);
  const diagnostics = parseDiagnostics(record.diagnosticsJson);

  if (record.status === 'needs_mapping' || record.status === 'failed') {
    return {
      import: record,
      accountSuggestion: suggestAccount(context, record.sourceFilename, null),
      warnings: diagnostics.warnings,
      balanceCheck: diagnostics.balanceCheck,
      rows: [],
      unparsedRows: context.store.imports
        .listRawRows(importId)
        .filter((r) => r.parseStatus === 'error'),
      plan: null,
    };
  }

  const { rows, unparsed } = buildIncomingRows(context, importId);
  const accountId = record.accountId;
  const plan = accountId ? context.store.planImport(accountId, rows) : null;

  return {
    import: record,
    accountSuggestion: accountId ? null : suggestAccount(context, record.sourceFilename, null),
    warnings: diagnostics.warnings,
    balanceCheck: diagnostics.balanceCheck,
    rows: toReviewRows(context, importId, rows, plan),
    unparsedRows: unparsed,
    plan: plan ? toReviewPlan(plan) : null,
  };
}

function toReviewRows(
  context: LedgerlineContext,
  importId: string,
  rows: readonly IncomingRow[],
  plan: ImportPlan | null,
): ReviewRow[] {
  const rawText = new Map(
    context.store.imports.listRawRows(importId).map((row) => [row.rowIndex, row.rawText]),
  );
  const merged = new Set(plan?.merged.map((entry) => entry.rowIndex) ?? []);
  const near = new Set(plan?.nearDuplicates.map((entry) => entry.rowIndex) ?? []);

  return rows.map((row) => ({
    rowIndex: row.rowIndex,
    rawText: rawText.get(row.rowIndex) ?? '',
    row: {
      rowIndex: row.rowIndex,
      lineNumber: row.rowIndex,
      rawText: rawText.get(row.rowIndex) ?? '',
      transactionDate: row.transactionDate,
      postedDate: row.postedDate,
      effectiveDate: row.effectiveDate,
      descriptionRaw: row.descriptionRaw,
      amountCents: row.amountCents,
      balanceCents: row.balanceCents,
      status: row.isPending ? 'pending' : 'posted',
      currency: row.currency,
      parseStatus: 'ok',
      parseSource: 'csv',
    },
    disposition: merged.has(row.rowIndex)
      ? 'duplicate'
      : near.has(row.rowIndex)
        ? 'near_duplicate'
        : 'insert',
  }));
}

function toReviewPlan(plan: ImportPlan): ReviewPlan {
  return {
    willInsert: plan.inserts.length,
    alreadyPresent: plan.merged.length,
    nearDuplicates: plan.nearDuplicates.map((candidate) => ({
      rowIndex: candidate.rowIndex,
      existingTransactionId: candidate.existingTransactionId,
      existingEffectiveDate: candidate.existing.effectiveDate,
      existingAmountCents: candidate.existing.amountCents,
      existingDescriptionRaw: candidate.existing.descriptionRaw,
      existingIsPending: candidate.existing.isPending,
      dayGap: candidate.dayGap,
      amountDeltaCents: candidate.amountDeltaCents,
      pendingToPosted: candidate.pendingToPosted,
      defaultResolution: candidate.defaultResolution,
    })),
  };
}

/**
 * A file that was never parsed has an `unavailable` balance verdict, not a missing
 * one.
 *
 * `null` here would be a third state on top of §6.1's three, and the review screen
 * would have to invent a caption for it. "Unavailable, because the file has not been
 * parsed" is the same thing said in the vocabulary the check already has — and it is
 * what keeps `balanceCheck` non-nullable on the wire.
 */
const NOT_PARSED: BalanceCheck = {
  kind: 'unavailable',
  reason: 'the file has not been parsed yet, so there are no balances to reconcile',
};

function parseDiagnostics(json: string | null): Diagnostics {
  if (!json) return { warnings: [], balanceCheck: NOT_PARSED };
  try {
    const parsed = JSON.parse(json) as Partial<Diagnostics>;
    return { warnings: parsed.warnings ?? [], balanceCheck: parsed.balanceCheck ?? NOT_PARSED };
  } catch {
    return { warnings: [], balanceCheck: NOT_PARSED };
  }
}

// ---------------------------------------------------------------- commit ---

export class ImportNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportNotReadyError';
  }
}

export interface CommitRequest {
  readonly resolutions?: readonly CommitResolution[];
  readonly allowZeroAmountRows?: boolean;
}

export function commitStagedImport(
  context: LedgerlineContext,
  importId: string,
  request: CommitRequest,
): CommitImportResult {
  const record = context.store.imports.getOrThrow(importId);

  if (record.status === 'needs_mapping' || record.status === 'failed') {
    throw new ImportNotReadyError(
      `import ${importId} is ${record.status} and has no rows to commit`,
    );
  }
  if (!record.accountId) {
    throw new ImportNotReadyError(
      `import ${importId} has no account. PATCH /api/imports/${importId} with an accountId first — ` +
        `spec 6.1 requires the guessed account to be confirmed before commit.`,
    );
  }

  const { rows } = buildIncomingRows(context, importId);

  const committed = context.store.commitImport({
    importId,
    accountId: record.accountId,
    rows,
    resolutions: request.resolutions,
    allowZeroAmountRows: request.allowZeroAmountRows,
  });

  /**
   * §2.5's `link`, in the position that table puts it: after `store`, because a
   * cross-account counterpart has to be in the database before it can be matched
   * against, and before `analyze`, which is a separate job.
   *
   * Run on every commit rather than only on an analysis run, and the second
   * statement of a pair is why: importing a card statement is the moment last
   * month's checking payment stops being unexplained spending. Leaving it until
   * someone presses Run Analysis would mean the Transactions page shows a $500
   * purchase in between.
   *
   * Skipped on a re-commit that inserted nothing (`POST /commit` is idempotent
   * per §2.3) — there is no new row for a pass to find.
   */
  if (!committed.alreadyCommitted) runTransferLinking(context);

  return committed;
}

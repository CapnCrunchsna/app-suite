/**
 * The response shapes, declared once and registered as shared schemas.
 *
 * Two things follow from `app.addSchema` rather than an inline object per route,
 * and both matter more than the deduplication does.
 *
 * **Fastify serializes responses against the declared schema.** An undeclared
 * field is dropped at runtime, so a schema here is not documentation that can
 * drift from the handler — it is the wire format. `errors.ts` already says this
 * about status codes; it is equally true of every field below.
 *
 * **`@fastify/swagger` lifts a `$id` into `components.schemas` and rewrites the
 * `$ref`s.** That is what makes the generated client (§2.2) emit a named
 * `Transaction` interface instead of the same anonymous object literal inlined at
 * nine call sites. The generator has no naming heuristics of its own on purpose:
 * the names in the client are the names declared here, so a rename is a
 * deliberate contract change visible in `openapi.json`'s diff.
 *
 * Referenced as `{ $ref: 'Name#' }` — Fastify's shared-schema form, which both
 * the serializer and the OpenAPI emitter resolve.
 */

import type { FastifyInstance } from 'fastify';

/**
 * The one enum below that is imported rather than restated.
 *
 * Every other list here is a wire contract this file owns. This one is a *type* in
 * `@metrum/ledgerline-llm` — `LlmProviderId` — and `llm-service.ts` switches on it
 * to decide which class to construct. A restated copy that fell out of step would
 * not fail a type check; it would accept a provider id at the route boundary that
 * the factory then silently resolved to `NoneProvider`.
 */
import { LLM_PROVIDER_IDS } from '../llm-service.js';

export { LLM_PROVIDER_IDS };

export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card'] as const;
export const CATEGORY_KINDS = ['spend', 'fee', 'transfer', 'income'] as const;
/** Migration 009. Two, not `PROVENANCE_SOURCES`' four: only the shipped set and a
 *  person write categories — spec 9x forbids the model from creating one. */
export const CATEGORY_SOURCES = ['seed', 'user'] as const;
export const PROVENANCE_SOURCES = ['seed', 'rule', 'llm', 'user'] as const;
export const IMPORT_STATUSES = [
  'uploaded',
  'needs_mapping',
  'staged',
  'committed',
  'failed',
] as const;
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
/** §5.1's bands. `suppressed` is a band a finding can be *scored* into and is
 *  therefore never emitted — it is here because the column can hold it, not
 *  because a card can show it. */
export const FINDING_BANDS = ['high', 'medium', 'low', 'suppressed'] as const;
/** §5.1's run lifecycle, distinct from the user's own verdict below. */
export const FINDING_STATUSES = ['active', 'resolved', 'suppressed'] as const;
export const FINDING_USER_STATUSES = ['acknowledged', 'snoozed', 'dismissed'] as const;
export const IMPACT_KINDS = ['savings', 'visibility'] as const;
export const DISMISSAL_SCOPES = ['merchant_rule', 'rule'] as const;
/** §3.1's `transfer_link.state`. `auto` and `proposed` belong to the run;
 *  `confirmed` and `rejected` are the user's and no run overwrites them. */
export const TRANSFER_LINK_STATES = ['proposed', 'confirmed', 'rejected', 'auto'] as const;
/** §2.6's two passes. `partial` never auto-links, whatever it scores. */
export const TRANSFER_MATCH_KINDS = ['one_to_one', 'partial'] as const;
/** §6.2's coverage bar. `partial` is a month a statement touches but does not
 *  provably span — see `CoverageMonth`. */
export const COVERAGE_STATES = ['covered', 'partial', 'missing'] as const;
export const ROW_STATUSES = ['posted', 'pending'] as const;
export const PARSE_SOURCES = ['csv', 'pdf', 'llm'] as const;
export const PARSE_STATUSES = ['ok', 'error'] as const;
export const DISPOSITIONS = ['insert', 'duplicate', 'near_duplicate'] as const;
export const RESOLUTIONS = ['replace', 'keep_both', 'skip'] as const;
export const AMOUNT_MODES = ['single', 'debit_credit'] as const;
export const SIGN_CONVENTIONS = ['as_is', 'invert'] as const;
/** `recurring_series.status` and its `user_status` override (§3.1, §6.5). */
export const SERIES_STATUSES = ['active', 'lapsed', 'cancelled'] as const;
export const COLUMN_ROLES = [
  'transactionDate',
  'postedDate',
  'description',
  'amount',
  'debit',
  'credit',
  'balance',
  'status',
] as const;
export const PARSE_WARNING_KINDS = [
  'zero_amount',
  'pending_row',
  'balance_mismatch',
  'balance_unavailable',
  'unparsed_row',
  'duplicate_in_file',
  'empty_description',
  'header_only',
  'signature_mismatch',
  'sign_convention_suspect',
  'declared_period_unreadable',
  'rows_outside_period',
  'profile_warning',
] as const;
export const BALANCE_CHECK_KINDS = ['unavailable', 'reconciled', 'mismatch'] as const;

/** A reference to a shared schema by `$id`. */
export const ref = (id: string) => ({ $ref: `${id}#` }) as const;

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;

/**
 * Mark every property required.
 *
 * Applied to **response** schemas only, and it is a statement of fact about them:
 * these describe rows, and a row always has all of its columns. A nullable column
 * is `T | null`, which is a value — not an absent field.
 *
 * It matters because it is what the generated client's types are read off. Without
 * it, JSON Schema's default makes every property optional and the client hands the
 * UI `amountCents?: number`, so every arithmetic and formatting call site has to
 * defend against an `undefined` that the wire format never produces. Request
 * schemas are deliberately *not* wrapped: a patch body with three of four fields
 * is the normal case there.
 */
function allRequired<T extends { readonly properties: Record<string, unknown> }>(
  schema: T,
): T & { required: string[] } {
  return { ...schema, required: Object.keys(schema.properties) };
}

/**
 * The same object shape, inlined and allowed to be `null`.
 *
 * A `$ref` cannot be nullable on its own — expressing that needs
 * `anyOf: [{ $ref }, { type: 'null' }]`, and both `fast-json-stringify` and the
 * client generator deliberately handle a narrower subset than that. So a nullable
 * field carries its shape inline while the shared `$id` version stays registered:
 * that costs a duplicated shape in `openapi.json` and buys a named interface in the
 * client, which is what lets a caller write `AccountSuggestion | null`.
 *
 * The `$id` is stripped because a schema may only be registered under one.
 */
function nullableObject<T extends { readonly properties: Record<string, unknown> }>(
  schema: T & { readonly $id?: string },
): Record<string, unknown> {
  const { $id: _registeredSeparately, ...rest } = schema;
  return {
    ...rest,
    type: ['object', 'null'],
    required: Object.keys(schema.properties),
  };
}

const apiError = {
  $id: 'ApiError',
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Stable machine-readable code' },
    message: { type: 'string' },
    rowIndexes: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Present on `zero_amount_rows`: the rows that parsed to $0.00.',
    },
    /**
     * Present on `category_in_use`: what refused the delete.
     *
     * Inline rather than a `$ref` to `CategoryUsage`, because `ApiError` is
     * registered first and a shared schema cannot reference one declared after it.
     * The prose message says the same thing; this is for the caller that wants to
     * branch rather than read.
     */
    categoryUsage: {
      type: 'object',
      properties: {
        transactions: { type: 'integer' },
        merchants: { type: 'integer' },
        children: { type: 'integer' },
      },
    },
  },
} as const;

const account = {
  $id: 'Account',
  type: 'object',
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    institution: nullableString,
    accountType: { type: 'string', enum: ACCOUNT_TYPES },
    last4: nullableString,
    currency: { type: 'string' },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/**
 * `transaction` (§3.1), whole.
 *
 * `amountCents` and `balanceCents` are `integer` and there is deliberately no
 * rendered-string sibling: §7.3 keeps money as integer cents end to end, and a
 * formatted field on the wire is an invitation to parse it back.
 *
 * `dedupeKey` and `dedupeKeyVersion` travel to the client as **provenance to
 * display**, never as input (§7.5). §3.3 freezes the key; the row expander shows
 * which version a row carries, and nothing above this line recomputes it.
 */
const transaction = {
  $id: 'Transaction',
  type: 'object',
  properties: {
    id: { type: 'string' },
    accountId: { type: 'string' },
    rawRowId: nullableString,
    /** Display and statement reconciliation only — never cadence (§7.1). */
    postedDate: nullableString,
    transactionDate: nullableString,
    /** `COALESCE(transaction_date, posted_date)`. The only date that orders or
     *  groups anything (§7.1). */
    effectiveDate: { type: 'string' },
    amountCents: { type: 'integer' },
    balanceCents: nullableInteger,
    currency: { type: 'string' },
    descriptionRaw: { type: 'string' },
    descriptionNormalized: { type: 'string' },
    merchantId: nullableString,
    categoryId: nullableString,
    categorySource: {
      type: ['string', 'null'],
      enum: [...PROVENANCE_SOURCES, null],
    },
    isPending: { type: 'boolean' },
    isInternalTransfer: { type: 'boolean' },
    transferPairId: nullableString,
    refundPairId: nullableString,
    isExcluded: { type: 'boolean' },
    allowsZeroAmount: { type: 'boolean' },
    dedupeKey: { type: 'string' },
    dedupeKeyVersion: { type: 'string' },
    occurrenceIndex: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const transactionSearchRow = {
  $id: 'TransactionSearchRow',
  type: 'object',
  properties: {
    transaction: ref('Transaction'),
    /** §2.3: "Includes `hasFinding` via `finding_evidence`." */
    hasFinding: { type: 'boolean' },
  },
} as const;

const transactionPage = {
  $id: 'TransactionPage',
  type: 'object',
  properties: {
    rows: { type: 'array', items: ref('TransactionSearchRow') },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const;

const statementImport = {
  $id: 'StatementImport',
  type: 'object',
  properties: {
    id: { type: 'string' },
    accountId: nullableString,
    sourceFilename: { type: 'string' },
    fileSha256: { type: 'string' },
    fileSizeBytes: { type: 'integer' },
    formatProfileId: nullableString,
    periodStart: nullableString,
    periodEnd: nullableString,
    rowsParsed: { type: 'integer' },
    rowsInserted: { type: 'integer' },
    rowsDuplicate: { type: 'integer' },
    status: { type: 'string', enum: IMPORT_STATUSES },
    parser: nullableString,
    parserVersion: nullableString,
    errorDetail: nullableString,
    diagnosticsJson: nullableString,
    importedAt: nullableString,
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const transactionSourceLine = {
  $id: 'TransactionSourceLine',
  type: 'object',
  properties: {
    importId: { type: 'string' },
    sourceFilename: { type: 'string' },
    rawText: nullableString,
  },
} as const;

// ------------------------------------------- the import review surface (§6.1) ---
// Everything below describes what a reviewer has to see before committing. §2.5
// makes review-before-commit the rule that stops a misparse reaching a finding, so
// these are the shapes that rule is enforced through.

/** §6.1: "Account assignment is auto-guessed from the filename and statement
 *  header and must be confirmed." Returned rather than stored, because a guess
 *  that has been written down is a guess that will be confirmed by reflex. */
const accountSuggestion = {
  $id: 'AccountSuggestion',
  type: 'object',
  properties: {
    accountId: { type: 'string' },
    reason: { type: 'string' },
  },
} as const;

/** One parsed data row, in house conventions. Every bank's disagreement about sign,
 *  date order and amount columns has already been absorbed by the profile. */
const rawRow = {
  $id: 'RawRow',
  type: 'object',
  properties: {
    /** Ordinal among the file's data rows. */
    rowIndex: { type: 'integer' },
    /** 1-based physical line, which is what a human can go and look at — a preamble
     *  and a header row make it differ from `rowIndex`. */
    lineNumber: { type: 'integer' },
    rawText: { type: 'string' },
    transactionDate: nullableString,
    postedDate: nullableString,
    effectiveDate: { type: 'string' },
    descriptionRaw: { type: 'string' },
    amountCents: { type: 'integer' },
    balanceCents: nullableInteger,
    status: { type: 'string', enum: ROW_STATUSES },
    currency: { type: 'string' },
    parseStatus: { type: 'string', enum: PARSE_STATUSES },
    parseSource: { type: 'string', enum: PARSE_SOURCES },
  },
} as const;

/** A stored `raw_row`. Lines that failed to parse are kept rather than dropped
 *  (§2.5) and reach the warning strip through here. */
const rawRowRecord = {
  $id: 'RawRowRecord',
  type: 'object',
  properties: {
    id: { type: 'string' },
    importId: { type: 'string' },
    rowIndex: { type: 'integer' },
    rawText: { type: 'string' },
    /** The serialized `RawRow`, or `{ errors: [...] }` for a failed line. */
    parsedJson: nullableString,
    parseStatus: { type: 'string', enum: PARSE_STATUSES },
    parseSource: { type: 'string', enum: PARSE_SOURCES },
  },
} as const;

const parseWarning = {
  $id: 'ParseWarning',
  type: 'object',
  properties: {
    kind: { type: 'string', enum: PARSE_WARNING_KINDS },
    message: { type: 'string' },
    rowIndex: { type: 'integer' },
    lineNumber: { type: 'integer' },
  },
  // `rowIndex` and `lineNumber` are genuinely absent on a file-level warning, so
  // this one is not wrapped in `allRequired`.
  required: ['kind', 'message'],
} as const;

const balanceMismatch = {
  $id: 'BalanceMismatch',
  type: 'object',
  properties: {
    rowIndex: { type: 'integer' },
    expectedCents: { type: 'integer' },
    actualCents: { type: 'integer' },
    deltaCents: { type: 'integer' },
  },
} as const;

/**
 * §6.1's balance verdict: `balance[n] − balance[n−1] === amount[n]` across the file.
 *
 * A **flattened union**, discriminated on `kind`, rather than a `oneOf` of three
 * shapes. Two reasons, and neither is laziness. `fast-json-stringify` resolves a
 * `oneOf` by trying each branch, and a branch mis-selected at serialization time
 * drops fields silently — the one failure mode this whole review screen exists to
 * prevent. And `tools/generate-api-client.mjs` deliberately handles only the schema
 * subset Fastify emits, so a `oneOf` would reach the client as `unknown`.
 *
 * The optional fields here are therefore *accurate*, not a concession: `reason`
 * really is absent unless the check was unavailable, and `failures` really is absent
 * unless it mismatched. Callers branch on `kind`, which is always present.
 *
 * Note what a reconciliation does **not** prove: `signConvention: 'invert'` flips
 * the balance alongside the amount, so a profile with the convention backwards
 * reconciles perfectly. `sign_convention_suspect` is the separate warning for that.
 */
const balanceCheck = {
  $id: 'BalanceCheck',
  type: 'object',
  properties: {
    kind: { type: 'string', enum: BALANCE_CHECK_KINDS },
    /** `unavailable` only — usually "no balance column mapped". */
    reason: { type: 'string' },
    /** `reconciled` only. Banks export newest-first about as often as oldest-first,
     *  so both directions are tried and the winner is reported. */
    order: { type: 'string', enum: ['ascending', 'descending'] },
    rowsChecked: { type: 'integer' },
    /** `mismatch` only. */
    bestOrder: { type: 'string', enum: ['ascending', 'descending'] },
    /** Carried separately from `failures.length`, which is capped: a wrong sign
     *  convention fails on every row, and reporting the cap would say "10 of 500
     *  rows disagree" about a file where all 500 did. */
    failureCount: { type: 'integer' },
    failures: { type: 'array', items: ref('BalanceMismatch') },
  },
  required: ['kind'],
} as const;

/**
 * One row as the reviewer sees it.
 *
 * `disposition` is the merge rule's verdict *before* anything is written:
 * `duplicate` is a row §3.3's multiset merge will absorb, `near_duplicate` is one
 * that needs the three-way choice below, `insert` is new.
 */
const reviewRow = {
  $id: 'ReviewRow',
  type: 'object',
  properties: {
    rowIndex: { type: 'integer' },
    rawText: { type: 'string' },
    row: ref('RawRow'),
    disposition: { type: 'string', enum: DISPOSITIONS },
  },
} as const;

/**
 * §6.1: near-duplicates "shown as an explicit three-way choice against the row they
 * resemble" — so the candidate carries the existing row's own values, not just its
 * id. A choice between two transactions that the UI has to go and fetch separately
 * is a choice made against a spinner.
 */
const nearDuplicateCandidate = {
  $id: 'NearDuplicateCandidate',
  type: 'object',
  properties: {
    rowIndex: { type: 'integer' },
    existingTransactionId: { type: 'string' },
    existingEffectiveDate: { type: 'string' },
    existingAmountCents: { type: 'integer' },
    existingDescriptionRaw: { type: 'string' },
    existingIsPending: { type: 'boolean' },
    dayGap: { type: 'integer' },
    amountDeltaCents: { type: 'integer' },
    /** The §3.3 case where a pending authorization is superseded by the posted row
     *  that settled it. `replace` is the default only here. */
    pendingToPosted: { type: 'boolean' },
    defaultResolution: { type: 'string', enum: RESOLUTIONS },
  },
} as const;

/** §6.1's "18 of 52 rows already present", computed against the store as it is
 *  right now and with nothing written. */
const reviewPlan = {
  $id: 'ReviewPlan',
  type: 'object',
  properties: {
    willInsert: { type: 'integer' },
    alreadyPresent: { type: 'integer' },
    nearDuplicates: { type: 'array', items: ref('NearDuplicateCandidate') },
  },
} as const;

const importReview = {
  $id: 'ImportReview',
  type: 'object',
  properties: {
    import: ref('StatementImport'),
    /** Null once an account has been confirmed — there is nothing left to guess. */
    accountSuggestion: nullableObject(accountSuggestion),
    warnings: { type: 'array', items: ref('ParseWarning') },
    balanceCheck: ref('BalanceCheck'),
    rows: { type: 'array', items: ref('ReviewRow') },
    unparsedRows: { type: 'array', items: ref('RawRowRecord') },
    /** Null until an account is confirmed: the merge rule is per-account, so there
     *  is no plan to compute before then. */
    plan: nullableObject(reviewPlan),
  },
} as const;

const stagedUpload = {
  $id: 'StagedUpload',
  type: 'object',
  properties: {
    import: ref('StatementImport'),
    /** False when §3.3's layer one short-circuited a byte-identical re-upload. */
    created: { type: 'boolean' },
    accountSuggestion: nullableObject(accountSuggestion),
  },
} as const;

const uploadResult = {
  $id: 'UploadResult',
  type: 'object',
  properties: {
    imports: { type: 'array', items: ref('StagedUpload') },
  },
} as const;

const commitResult = {
  $id: 'CommitResult',
  type: 'object',
  properties: {
    importId: { type: 'string' },
    rowsParsed: { type: 'integer' },
    rowsInserted: { type: 'integer' },
    rowsDuplicate: { type: 'integer' },
    rowsMerged: { type: 'integer' },
    rowsSkippedAsNearDuplicate: { type: 'integer' },
    /** Rows the reviewer dropped outright (§9ah) — an in-file duplicate they said
     *  was not real. Counted apart from `rowsDuplicate`, which is §3.3's "already
     *  present" and would otherwise claim the account held a row it never did. */
    rowsDropped: { type: 'integer' },
    rowsReplaced: { type: 'integer' },
    refundPairsLinked: { type: 'integer' },
    insertedTransactionIds: { type: 'array', items: { type: 'string' } },
    /** True when this import was already committed; the numbers are the ones the
     *  first commit produced. `POST /commit` is idempotent (§2.3). */
    alreadyCommitted: { type: 'boolean' },
  },
} as const;

const deleteImportResult = {
  $id: 'DeleteImportResult',
  type: 'object',
  properties: {
    deletedTransactionIds: { type: 'array', items: { type: 'string' } },
    /** Kept because another overlapping import still sources them (§3.3). */
    retainedTransactionIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

// ----------------------------------------- format profiles / column mapper ---

/** Where a column lives: by header name when the file has one, by zero-based index
 *  when it does not. Name matching uses the signature's normalization, so
 *  "Transaction Date" and "transaction date" are the same column. */
const columnRef = {
  $id: 'ColumnRef',
  type: 'object',
  properties: {
    by: { type: 'string', enum: ['header', 'index'] },
    name: { type: 'string' },
    index: { type: 'integer' },
  },
  required: ['by'],
} as const;

const columnMap = {
  $id: 'ColumnMap',
  type: 'object',
  properties: Object.fromEntries(COLUMN_ROLES.map((role) => [role, ref('ColumnRef')])),
} as const;

/**
 * `format_profile` (§3.1) — the column mapping that turns one bank's CSV into house
 * conventions, and the thing §6.1's mapper produces.
 *
 * `headerSignature` is UNIQUE per §3.1 and is the whole point: saving one means "the
 * next statement from that bank imports without asking".
 */
const formatProfile = {
  $id: 'FormatProfile',
  type: 'object',
  properties: {
    id: { type: 'string' },
    institution: { type: 'string' },
    accountTypeHint: { type: ['string', 'null'], enum: [...ACCOUNT_TYPES, null] },
    headerSignature: { type: 'string' },
    headerTokens: { type: 'array', items: { type: 'string' } },
    hasHeader: { type: 'boolean' },
    delimiter: { type: 'string' },
    /** Preamble lines dropped before the header. Bank exports open with account
     *  numbers and address blocks more often than not. */
    skipLines: { type: 'integer' },
    dateFormat: { type: 'string' },
    /** Regex with two capture groups — start, then end — read against the preamble
     *  lines `skipLines` names. `null` for an export that declares no period, which
     *  is most of them; the period then falls back to row dates (§7.2, §9h). */
    periodPattern: nullableString,
    amountMode: { type: 'string', enum: AMOUNT_MODES },
    signConvention: { type: 'string', enum: SIGN_CONVENTIONS },
    columnMap: ref('ColumnMap'),
    /** Values in the status column meaning "not settled" (§2.5). */
    pendingValues: { type: 'array', items: { type: 'string' } },
    currency: { type: 'string' },
    version: { type: 'integer' },
    source: { type: 'string', enum: ['seed', 'user'] },
  },
} as const;

/**
 * The mapper's draft, before it is a profile. Everything the reviewer can set; the
 * header signature and tokens come from the file, not from them.
 *
 * **No `default` on any field, deliberately.** Fastify applies schema defaults to the
 * request body, which makes an omitted field indistinguishable from a deliberate one
 * by the time a handler sees it — so `delimiter` defaulting to `,` silently overrode
 * the semicolon detection had found, and `skipLines` defaulting to `0` overrode a
 * detected two-line preamble. Both produced a mapping that pointed at the file's
 * title row and an error message blaming the column names. Every fallback lives in
 * `toCandidate` instead, where it can prefer what was detected over what was
 * assumed.
 */
const formatProfileDraft = {
  $id: 'FormatProfileDraft',
  type: 'object',
  required: ['institution', 'dateFormat', 'columnMap'],
  properties: {
    /** Omit to have one derived from the institution. Supply it to update an
     *  existing profile in place. */
    id: { type: 'string' },
    institution: { type: 'string', minLength: 1 },
    accountTypeHint: { type: ['string', 'null'], enum: [...ACCOUNT_TYPES, null] },
    hasHeader: { type: 'boolean' },
    /** Omit to use the delimiter detection found. */
    delimiter: { type: 'string', minLength: 1, maxLength: 1 },
    /** Preamble rows before the header. Omit to use the detected count — banks put
     *  address blocks and account numbers up there and nobody should count them by
     *  eye. */
    skipLines: { type: 'integer', minimum: 0 },
    dateFormat: { type: 'string', minLength: 1 },
    /** Omitted keeps whatever the profile being updated already had; `null` clears
     *  it. The mapper has no control for this yet, and an omitted field silently
     *  meaning "clear" would drop a working profile's period on the next save. */
    periodPattern: { type: ['string', 'null'] },
    amountMode: { type: 'string', enum: AMOUNT_MODES },
    signConvention: { type: 'string', enum: SIGN_CONVENTIONS },
    columnMap: ref('ColumnMap'),
    pendingValues: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * What a preview answers: would this draft parse the file, and into what.
 *
 * `validateProfile`'s own errors and warnings, unedited — that function refuses
 * anything ambiguous eagerly and explains why, and re-wording its messages in the
 * UI would mean two descriptions of one rule. The sample rows are what the parser
 * actually produced, which is the only honest form a "live preview" can take.
 */
const formatProfilePreview = {
  $id: 'FormatProfilePreview',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    errors: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    /** Empty when `ok` is false — there is nothing to show for a draft that cannot
     *  parse, and a partial preview reads as a partial success. */
    rows: { type: 'array', items: ref('RawRow') },
    /** Lines the draft could not read, with the parser's reasons. */
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rowIndex: { type: 'integer' },
          lineNumber: { type: 'integer' },
          rawText: { type: 'string' },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    parseWarnings: { type: 'array', items: ref('ParseWarning') },
    balanceCheck: ref('BalanceCheck'),
    /** The signature this draft would be saved under, from the file's own header. */
    headerSignature: { type: 'string' },
    headerTokens: { type: 'array', items: { type: 'string' } },
    /**
     * What detection found, so the mapper pre-fills rather than asking.
     *
     * These are returned on every preview including a refused one, which is the
     * point: the grid has to stay populated while the mapping is still wrong, and a
     * reviewer should never be made to guess a delimiter or a preamble length the
     * detector already worked out.
     */
    detectedDelimiter: { type: 'string' },
    detectedSkipLines: { type: 'integer' },
    /** The first data rows as raw cells — the mapper's grid, and what its per-column
     *  dropdowns are chosen against. Wrapped in an object because a bare array of
     *  arrays has nowhere to hang a per-row field later. */
    sampleRows: {
      type: 'array',
      items: {
        type: 'object',
        properties: { cells: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
} as const;

/**
 * §6.3's row expander: "the verbatim statement line and the imports that cover
 * it".
 *
 * `rawText` is the row's own line, as the bank printed it — never trimmed or
 * re-encoded on the way through (§2.5). `sources` is the finer point §3.1's
 * `transaction_source.raw_row_id` was added for: a row carried by two overlapping
 * statements is a *different printed line* in each, so the expander can show
 * which statement each came from.
 */
const transactionDetail = {
  $id: 'TransactionDetail',
  type: 'object',
  properties: {
    transaction: ref('Transaction'),
    coveringImports: { type: 'array', items: ref('StatementImport') },
    rawText: nullableString,
    sources: { type: 'array', items: ref('TransactionSourceLine') },
  },
} as const;

const merchant = {
  $id: 'Merchant',
  type: 'object',
  properties: {
    id: { type: 'string' },
    canonicalName: { type: 'string' },
    displayName: { type: 'string' },
    website: nullableString,
    defaultCategoryId: nullableString,
    isKnownSubscription: { type: 'boolean' },
    isTransferKind: { type: 'boolean' },
    overlapGroup: nullableString,
    /** §4.3's precedence, and §7.5's rule about it: this reaches the UI as
     *  something to show, never as something an analyzer branches on. */
    source: { type: 'string', enum: PROVENANCE_SOURCES },
  },
} as const;

/**
 * A merchant as §4.1 step 7's review queue needs it — the record plus the two
 * facts a person needs to decide: how much history rides on it, and how the bank
 * actually spelled it.
 */
const reviewMerchant = {
  $id: 'ReviewMerchant',
  type: 'object',
  properties: {
    merchant: ref('Merchant'),
    transactionCount: { type: 'integer' },
    /** A few real spellings, so the card can justify itself rather than asking the
     *  user to take a similarity score on faith. */
    sampleDescriptors: { type: 'array', items: { type: 'string' } },
  },
} as const;

const mergeCandidate = {
  $id: 'MergeCandidate',
  type: 'object',
  properties: {
    /** The default survivor. The UI may flip it; nothing is decided here. */
    keep: ref('ReviewMerchant'),
    merge: ref('ReviewMerchant'),
    similarity: { type: 'number' },
  },
} as const;

const merchantReviewQueue = {
  $id: 'MerchantReviewQueue',
  type: 'object',
  properties: {
    mergeCandidates: { type: 'array', items: ref('MergeCandidate') },
    /** §4.1 step 7's provisional merchants — resolved by rule, never confirmed. */
    provisional: { type: 'array', items: ref('ReviewMerchant') },
    /**
     * §2.3's "sub-floor LLM proposals", plus everything §4.2's settled-series
     * exception withheld at any confidence. Empty with the provider set to `none`,
     * which is the default and is not a failure — `llmProposalsUnavailableReason`
     * says which of the two an empty list means.
     */
    llmProposals: { type: 'array', items: ref('LlmProposal') },
    llmProposalsUnavailableReason: nullableString,
  },
} as const;

const merchantMergeResult = {
  $id: 'MerchantMergeResult',
  type: 'object',
  properties: {
    /** The surviving merchant. */
    merchantId: { type: 'string' },
    /** Descriptor spellings that now resolve to it, as `user` aliases (§4.3). */
    aliasKeysWritten: { type: 'array', items: { type: 'string' } },
    /** Rows the re-normalize job will move. Reported from the dry count rather
     *  than from the job, because the job is asynchronous and the user is owed a
     *  number now — the same argument §6.3 makes about its bulk count. */
    transactionsAffected: { type: 'integer' },
    jobId: { type: 'string' },
    /** §2.7's coalescing: a second merge while one is queued merges into it. */
    coalesced: { type: 'boolean' },
  },
} as const;

/**
 * `POST /api/merchants/aliases` (§2.3).
 *
 * The same facts the merge result carries, minus `transactionsAffected`: a merge
 * knows how many rows it is about to move because it counted the losing
 * merchant's, and an alias written against a spelling that may not be in the
 * ledger yet does not. A zero there would read as "nothing happened" rather than
 * "nothing yet".
 */
const merchantAliasResult = {
  $id: 'MerchantAliasResult',
  type: 'object',
  properties: {
    merchantId: { type: 'string' },
    /** The keys actually written — blank ones are dropped, so this can be shorter
     *  than what was sent. */
    aliasKeysWritten: { type: 'array', items: { type: 'string' } },
    jobId: { type: 'string' },
    /** §2.7's coalescing: a second write while one is queued merges into it. */
    coalesced: { type: 'boolean' },
  },
} as const;

const category = {
  $id: 'Category',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    parentId: nullableString,
    kind: { type: 'string', enum: CATEGORY_KINDS },
    /** Spec 5.4's curated group. Two categories sharing one is the claim "these
     *  describe the same spending", and it is the whole input to that rule's
     *  category-overlap half. */
    overlapGroup: nullableString,
    /** Migration 009. `seed` is the shipped taxonomy, `user` a row spec 6.8's editor
     *  created or touched — and which the boot re-seed may therefore not overwrite.
     *  Shown, never branched on (spec 7.5). */
    source: { type: 'string', enum: CATEGORY_SOURCES },
  },
} as const;

/**
 * One category and what points at it — spec 6.8's editor read.
 *
 * Separate from `Category` rather than folded into it, because `GET /api/categories`
 * is spec 6.3's dropdown and a dropdown does not need three `COUNT(*)`s per entry on
 * every page load. The counts exist for one screen and are read by that screen.
 */
const categoryUsage = {
  $id: 'CategoryUsage',
  type: 'object',
  properties: {
    category: ref('Category'),
    /** Every row holding the foreign key, excluded and internal-transfer rows
     *  included: spec 3.2's RESTRICT does not care which ones the UI hides. */
    transactions: { type: 'integer' },
    merchants: { type: 'integer' },
    children: { type: 'integer' },
    /** Whether `DELETE` would succeed without a `reassignTo`. Computed here rather
     *  than by the caller summing three numbers, so the page and the constraint
     *  cannot disagree about what "in use" means. */
    deletable: { type: 'boolean' },
  },
} as const;

/**
 * What a `PATCH` did, in the terms spec 6.8 says a kind change has to be reported in.
 *
 * A rename is CRUD. A **kind** change re-partitions the analyzers: spec 5.8's fee
 * rollup and spec 6.6's Insights select `kind = 'fee'`, and spec 5.10 trends only
 * `kind = 'spend'`. Changing one silently moves every charge in the category between
 * those, so the write says how many and which rules see them next run.
 */
const categoryUpdate = {
  $id: 'CategoryUpdate',
  type: 'object',
  properties: {
    category: ref('Category'),
    /** Null when the kind did not move. */
    kindChangedFrom: nullableString,
    /** Rows that change partition — 0 unless the kind moved. */
    transactionsRepartitioned: { type: 'integer' },
    /** Rule ids whose input this change alters, for the next analysis run. Empty
     *  when nothing analytical moved. */
    rulesAffected: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** What a delete moved before it deleted (spec 2.3, spec 6.8). */
const categoryDeleteResult = {
  $id: 'CategoryDeleteResult',
  type: 'object',
  properties: {
    deletedId: { type: 'string' },
    /** The category the rows were moved to, or null when there were none to move. */
    reassignedTo: nullableString,
    transactionsMoved: { type: 'integer' },
    merchantsMoved: { type: 'integer' },
    /** Subcategories promoted to the top level — see `reassignCategory`. */
    childrenPromoted: { type: 'integer' },
  },
} as const;

// --------------------------------------------------- findings (§5.1, §6.4) ---

/**
 * §5.1's finding, plus the two things only a read can know.
 *
 * `status` is the run lifecycle — `active`, `resolved` when a previous run
 * produced it and this one did not, `suppressed` when a standing `dismissal_rule`
 * covers it. `userStatus` is the separate per-finding verdict from
 * `finding_state`, and the two are independent by §3.1's design: a finding can be
 * dismissed and then resolve, or be resolved and still carry the dismissal that
 * will apply if it comes back.
 *
 * `detail` is a free-shaped object because each rule's payload is its own — a
 * price step, a duplicate set, a trial's corroboration. `additionalProperties`
 * is on for that reason, and it is the one place in this file where the schema
 * deliberately does not pin the wire format: pinning it would mean re-declaring
 * five rules' detail shapes here and re-declaring them again for §5.8–§5.11.
 */
const finding = {
  $id: 'Finding',
  type: 'object',
  properties: {
    id: { type: 'string' },
    ruleId: { type: 'string' },
    ruleVersion: { type: 'string' },
    /** §7.4: the thresholds this finding was computed under. */
    configHash: { type: 'string' },
    /** `rule_id + subject_type + subject_id` — what the upsert keys on (§5.1). */
    naturalKey: { type: 'string' },
    subjectType: { type: 'string' },
    subjectId: { type: 'string' },
    title: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
    confidence: { type: 'number' },
    band: { type: 'string', enum: FINDING_BANDS },
    /** §5.1 and §7.3: only `savings` sums into a headline. */
    impactKind: { type: 'string', enum: IMPACT_KINDS },
    impactMonthlyCents: { type: 'integer' },
    impactAnnualCents: { type: 'integer' },
    /** §7.5: shown as a badge, never branched on by a rule. */
    llmDependent: { type: 'boolean' },
    evidenceHash: { type: 'string' },
    /** §5.1's explicit evidence, from `finding_evidence`. */
    evidenceTransactionIds: { type: 'array', items: { type: 'string' } },
    /** Never re-stamped by a re-run: the age of the problem, not of the row. */
    firstDetectedAt: { type: 'string' },
    status: { type: 'string', enum: FINDING_STATUSES },
    userStatus: { type: ['string', 'null'], enum: [...FINDING_USER_STATUSES, null] },
    /** Spec 7.6's judgement on this finding, or null if nobody has given one
     *  (spec 9z). Distinct from `userStatus`, which is about wanting to see it. */
    verdict: { type: ['string', 'null'], enum: ['correct', 'incorrect', 'unsure', null] },
    /** True when the evidence has moved since that judgement — the same staleness
     *  test spec 5.1 applies to a dismissal. */
    verdictStale: { type: 'boolean' },
    snoozeUntil: nullableString,
    /** §5.1: the evidence hash moved since the dismissal — "changed since you
     *  dismissed this". */
    changedSinceDismissal: { type: 'boolean' },
    /** §5.1's other resurfacing reason: a threshold changed under it. */
    reEvaluated: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const findingPage = {
  $id: 'FindingPage',
  type: 'object',
  properties: {
    rows: { type: 'array', items: ref('Finding') },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const;

/** §6.4's first headline number, from `recurring_series`. */
const subscriptionTotals = {
  $id: 'SubscriptionTotals',
  type: 'object',
  properties: {
    activeCount: { type: 'integer' },
    lapsedCount: { type: 'integer' },
    /** `amountCentsCurrent × cadencesPerYear`, rounded once. What the ledger sorts on. */
    monthlyCents: { type: 'integer' },
    annualCents: { type: 'integer' },
  },
} as const;

/**
 * §6.4's top strip: "active subscriptions and their monthly/annual total, **total
 * flagged annual savings** (`impact_kind = savings` only — see §5.1), and
 * unreviewed finding count."
 *
 * There is deliberately no field totalling everything. §7.3: "Two findings may
 * never claim the same dollars as `savings`", and the counterpart to that rule is
 * that visibility findings never join the sum at all — a wire field holding the
 * combined number would be one `+` away from being rendered.
 */
const findingsSummary = {
  $id: 'FindingsSummary',
  type: 'object',
  properties: {
    subscriptions: ref('SubscriptionTotals'),
    savingsAnnualCents: { type: 'integer' },
    savingsMonthlyCents: { type: 'integer' },
    activeFindingCount: { type: 'integer' },
    /** No `finding_state` row at all — never acknowledged, snoozed or dismissed. */
    unreviewedCount: { type: 'integer' },
    countsByRule: { type: 'object', additionalProperties: { type: 'integer' } },
    countsByBand: { type: 'object', additionalProperties: { type: 'integer' } },
    lastRunAt: nullableString,
    lastRunConfigHash: nullableString,
    lastRunSnapshotRows: nullableInteger,
    /** §7.4: the hash a run started *now* would record. Differs from
     *  `lastRunConfigHash` exactly when Settings has moved a threshold since. */
    configHash: { type: 'string' },
  },
} as const;

/** §5.1's standing dismissals — the two scopes that are not per-finding (§3.1). */
const dismissalRule = {
  $id: 'DismissalRule',
  type: 'object',
  properties: {
    id: { type: 'string' },
    scope: { type: 'string', enum: DISMISSAL_SCOPES },
    ruleId: { type: 'string' },
    /** Null for `rule` scope, and §3.1's CHECK constraint enforces the pairing. */
    merchantId: nullableString,
    reason: nullableString,
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

// ------------------------------------------------------ settings (§6.8, §7.4) ---

/**
 * One tunable number or switch from spec 7.4's config object.
 *
 * Derived by walking the shipped defaults rather than declared, so a threshold added
 * to spec 5 appears here without a second list to update — see `routes/settings.ts`.
 */
/**
 * What spec 6.6's numbers were computed over, said out loud.
 *
 * Spec 7.2 requires it — "reports the window it used" — and spec 6.6's hatching
 * depends on it: a reader looking at eleven solid bars and one hatched one needs to
 * know the totals exclude the hatched one, or the chart is saying something false
 * about a month they can see.
 */
const coverageWindow = {
  $id: 'CoverageWindow',
  type: 'object',
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    coveredMonths: { type: 'integer' },
    uncoveredMonths: { type: 'array', items: { type: 'string' } },
  },
} as const;

const categorySlice = {
  $id: 'CategorySlice',
  type: 'object',
  properties: {
    category: { type: 'string' },
    amountCents: { type: 'integer' },
  },
} as const;

const categoryMonth = {
  $id: 'CategoryMonth',
  type: 'object',
  properties: {
    month: { type: 'string' },
    /** Spec 7.2's answer for *every* account in scope, not any one of them. A false
     *  here is what spec 6.6 renders hatched. */
    covered: { type: 'boolean' },
    totalCents: { type: 'integer' },
    slices: { type: 'array', items: ref('CategorySlice') },
  },
} as const;

const categoryInsight = {
  $id: 'CategoryInsight',
  type: 'object',
  properties: {
    months: { type: 'array', items: ref('CategoryMonth') },
    /** Every category in the window, so a stacked chart assigns one colour per
     *  series rather than re-keying per month. */
    categories: { type: 'array', items: { type: 'string' } },
    window: ref('CoverageWindow'),
  },
} as const;

const mover = {
  $id: 'Mover',
  type: 'object',
  properties: {
    category: { type: 'string' },
    fromCents: { type: 'integer' },
    toCents: { type: 'integer' },
    deltaCents: { type: 'integer' },
    /** Null where the earlier month was zero: a rise from nothing has no
     *  percentage, and ∞ or 100% would both be a number that means neither. */
    percent: { type: ['number', 'null'] },
  },
} as const;

const moversInsight = {
  $id: 'MoversInsight',
  type: 'object',
  properties: {
    /** The last two *covered* months, or null when there are fewer than two. */
    fromMonth: nullableString,
    toMonth: nullableString,
    risers: { type: 'array', items: ref('Mover') },
    fallers: { type: 'array', items: ref('Mover') },
    window: ref('CoverageWindow'),
  },
} as const;

const feeMerchant = {
  $id: 'FeeMerchant',
  type: 'object',
  properties: {
    label: { type: 'string' },
    amountCents: { type: 'integer' },
    count: { type: 'integer' },
  },
} as const;

const feeAccount = {
  $id: 'FeeAccount',
  type: 'object',
  properties: {
    accountId: { type: 'string' },
    displayName: { type: 'string' },
    totalCents: { type: 'integer' },
    count: { type: 'integer' },
    byMerchant: { type: 'array', items: ref('FeeMerchant') },
  },
} as const;

const feesInsight = {
  $id: 'FeesInsight',
  type: 'object',
  properties: {
    accounts: { type: 'array', items: ref('FeeAccount') },
    totalCents: { type: 'integer' },
    window: ref('CoverageWindow'),
  },
} as const;

/** One row of spec 5.9's or spec 5.11's answer, as spec 6.6 lists it. */
const ruleBackedRow = {
  $id: 'RuleBackedRow',
  type: 'object',
  properties: {
    findingId: { type: 'string' },
    title: { type: 'string' },
    subjectId: { type: 'string' },
    band: { type: 'string', enum: FINDING_BANDS },
    impactAnnualCents: { type: 'integer' },
    impactMonthlyCents: { type: 'integer' },
    detail: { type: 'object', additionalProperties: true },
  },
} as const;

const ruleBackedInsight = {
  $id: 'RuleBackedInsight',
  type: 'object',
  properties: {
    rows: { type: 'array', items: ref('RuleBackedRow') },
    /** Set when no analysis has finished, so the page can say "run one" rather than
     *  "there are none" — two very different statements about an empty list. */
    unavailableReason: nullableString,
  },
} as const;

/**
 * Spec 7.6's ground truth for one row (spec 9ab).
 *
 * Every assertion is nullable and the null means "nobody said", not "no". An
 * unlabelled row and a row labelled "not a fee" are different facts, and the recall
 * figures on `Calibration` are only meaningful because the schema can tell them
 * apart.
 */
const transactionLabel = {
  $id: 'TransactionLabel',
  type: 'object',
  properties: {
    id: { type: 'string' },
    transactionId: { type: 'string' },
    expectedMerchantId: nullableString,
    isRecurring: { type: ['boolean', 'null'] },
    isFee: { type: ['boolean', 'null'] },
    isTransfer: { type: ['boolean', 'null'] },
    isOutlier: { type: ['boolean', 'null'] },
    note: nullableString,
    /** What spec 4.1's chain concluded when the judgement was made — the other half
     *  of every normalization comparison. */
    chainMerchantId: nullableString,
    chainDescriptionNormalized: { type: 'string' },
    /** `review` is the deliberate pass; `correction` is the side effect of a spec
     *  4.3 merchant edit. Separated because corrections are by definition the rows
     *  the chain got wrong. */
    origin: { type: 'string', enum: ['review', 'correction'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const calibrationProgress = {
  $id: 'CalibrationProgress',
  type: 'object',
  properties: {
    labelled: { type: 'integer' },
    fromReview: { type: 'integer' },
    fromCorrection: { type: 'integer' },
    total: { type: 'integer' },
  },
} as const;

const normalizationSplit = {
  $id: 'NormalizationSplit',
  type: 'object',
  properties: {
    compared: { type: 'integer' },
    agreed: { type: 'integer' },
  },
} as const;

const normalizationCalibration = {
  $id: 'NormalizationCalibration',
  type: 'object',
  properties: {
    compared: { type: 'integer' },
    agreed: { type: 'integer' },
    disagreed: { type: 'integer' },
    fromReview: ref('NormalizationSplit'),
    fromCorrection: ref('NormalizationSplit'),
  },
} as const;

/** One rule, judged from both directions (spec 9ab). */
const ruleCalibration = {
  $id: 'RuleCalibration',
  type: 'object',
  properties: {
    ruleId: { type: 'string' },
    /** Precision, from spec 9z's finding labels. */
    judgedCorrect: { type: 'integer' },
    judgedIncorrect: { type: 'integer' },
    /** Recall, from spec 9ab's transaction labels. `expected` counts only rows
     *  where somebody asserted — a null flag is not evidence either way. */
    expected: { type: 'integer' },
    found: { type: 'integer' },
    missed: { type: 'integer' },
    falsePositives: { type: 'integer' },
  },
} as const;

const calibrationReport = {
  $id: 'Calibration',
  type: 'object',
  properties: {
    progress: ref('CalibrationProgress'),
    normalization: ref('NormalizationCalibration'),
    rules: { type: 'array', items: ref('RuleCalibration') },
    /** The judgements themselves — the pass reads them back to show what it has
     *  already said, and one request keeps them in step with the progress. */
    labels: { type: 'array', items: ref('TransactionLabel') },
    /** Set when no analysis has finished: every recall figure compares a label to
     *  what the rules concluded, and "everything was missed" would be a lie about
     *  the rules rather than a fact about the corpus. */
    unavailableReason: nullableString,
  },
} as const;

const settingThreshold = {
  $id: 'SettingThreshold',
  type: 'object',
  properties: {
    /** The config key holding it: `recurrence`, `trend`, `global`… */
    section: { type: 'string' },
    key: { type: 'string' },
    kind: { type: 'string', enum: ['number', 'boolean'] },
    /** What spec 5 ships. Shown beside the current value so a tuned threshold is
     *  legible as tuned, and resettable. */
    defaultValue: { type: ['number', 'boolean'] },
    value: { type: ['number', 'boolean'] },
    overridden: { type: 'boolean' },
  },
} as const;

/** A config field this page deliberately will not edit, and why. */
const settingUnsettable = {
  $id: 'SettingUnsettable',
  type: 'object',
  properties: {
    section: { type: 'string' },
    key: { type: 'string' },
    reason: { type: 'string' },
  },
} as const;

/**
 * One spec 5 rule, its switch, and what turning it off would disturb.
 *
 * `duplicate.v1` appears twice: spec 5.4 is two rules sharing one id and one
 * `config_hash`, "separately toggleable in Settings" in that section's own words.
 * `enabledKey` is which boolean in `section` carries this row's switch.
 */
/**
 * §7.6's corpus for one rule, as §6.8 shows it beside that rule's thresholds.
 *
 * Precision only, and the field names say so: there is no `missed` here because
 * nothing in the app can show a reader what the rules failed to find. Recall needs
 * the hand-built corpus §7.6 describes; this is the half that can be collected from
 * use (spec 9z).
 */
const ruleAccuracy = {
  $id: 'RuleAccuracy',
  type: 'object',
  properties: {
    ruleId: { type: 'string' },
    correct: { type: 'integer' },
    incorrect: { type: 'integer' },
    unsure: { type: 'integer' },
    /** Judgements whose evidence has moved since. Excluded from the others and
     *  counted here, so an accuracy figure resting on two current labels cannot
     *  read as one resting on forty. */
    stale: { type: 'integer' },
  },
} as const;

const settingRule = {
  $id: 'SettingRule',
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    specRef: { type: 'string' },
    section: { type: 'string' },
    enabledKey: { type: 'string' },
    enabled: { type: 'boolean' },
    activeFindings: { type: 'integer' },
    /** Spec 7.6's corpus for this rule. */
    labelled: ref('RuleAccuracy'),
    /** What spec 6.8's re-evaluation warning is warning about — a count, so the
     *  warning is a statement rather than a disclaimer. */
    dismissedFindings: { type: 'integer' },
  },
} as const;

/**
 * Spec 6.8's LLM provider section, as the page reads it.
 *
 * `sendsDataOffMachine` comes off the built provider rather than being inferred
 * from the id, for the reason `provider.ts` gives: it is the fact the warning card
 * and the header indicator both read, and a UI that derived it would be a second
 * implementation to keep in step with spec 2.4.
 *
 * `redaction` and `redactionLocked` are two fields because they are two facts —
 * what the user chose, and whether the choice is available. Spec 6.8 makes
 * redaction "not disableable while `claude-cli` is selected", and a single boolean
 * would force the page to re-derive the clamp.
 */
const llmSettings = {
  $id: 'LlmSettings',
  type: 'object',
  properties: {
    providerId: { type: 'string', enum: LLM_PROVIDER_IDS },
    /** Null means the provider's own default rather than a model this app named. */
    model: nullableString,
    redaction: { type: 'boolean' },
    redactionLocked: { type: 'boolean' },
    /** Spec 2.4: "Drives the UI warning. True only for claude-cli." */
    sendsDataOffMachine: { type: 'boolean' },
    /** Spec 2.4's cache, so spec 6.8 can say whether it is doing anything. */
    cachedResponses: { type: 'integer' },
    degradedCallCount: { type: 'integer' },
  },
} as const;

/** Spec 2.4's `health()`, over HTTP — spec 6.8's Test Connection button. */
const llmHealth = {
  $id: 'LlmHealth',
  type: 'object',
  properties: {
    providerId: { type: 'string', enum: LLM_PROVIDER_IDS },
    ok: { type: 'boolean' },
    /** The provider's own sentence, which names the fix where it can — Ollama's
     *  health says `ollama pull <model>` rather than "model not found". */
    detail: { type: 'string' },
    model: nullableString,
    sendsDataOffMachine: { type: 'boolean' },
    capabilities: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** One entry in spec 6.8's degraded-LLM-call log. */
const degradedCall = {
  $id: 'DegradedCall',
  type: 'object',
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    provider: { type: 'string' },
    /** The caller's words, not a stack frame (spec 2.4). */
    operation: { type: 'string' },
    reason: { type: 'string' },
  },
} as const;

const degradedCallLog = {
  $id: 'DegradedCallLog',
  type: 'object',
  properties: {
    entries: { type: 'array', items: ref('DegradedCall') },
    /** The list is capped; this is not. A run of failures is the signal, so the
     *  page must be able to say "50 of 412" rather than implying 50 is all. */
    total: { type: 'integer' },
  },
} as const;

/**
 * A spec 4.2 proposal that did not apply, and why.
 *
 * `pending` is the sub-floor case; `blocked` is the settled-series exception, which
 * withholds "at any confidence". They are one list with two reasons rather than two
 * lists, because a person reviewing them takes the same action either way — and the
 * reason is the thing that has to differ, since raising a threshold would release
 * one and not the other.
 */
const llmProposal = {
  $id: 'LlmProposal',
  type: 'object',
  properties: {
    id: { type: 'string' },
    /** The normalized descriptor, which is also the alias key it would write. */
    descriptor: { type: 'string' },
    merchantName: { type: 'string' },
    /** Spec 4.2 asks the model for one; nothing applies it yet — see spec 9s. */
    categoryName: nullableString,
    confidence: { type: 'number' },
    status: { type: 'string', enum: ['pending', 'applied', 'blocked', 'rejected'] },
    blockedReason: nullableString,
    provider: { type: 'string' },
    model: { type: 'string' },
  },
} as const;

/** What one spec 4.2 run did. */
const llmProposalRun = {
  $id: 'LlmProposalRun',
  type: 'object',
  properties: {
    providerId: { type: 'string' },
    model: { type: 'string' },
    descriptorsConsidered: { type: 'integer' },
    /** Spec 2.4's P2P hard filter, counted rather than silent. */
    withheldP2P: { type: 'integer' },
    batches: { type: 'integer' },
    proposalsReceived: { type: 'integer' },
    applied: { type: 'integer' },
    queuedForReview: { type: 'integer' },
    /** True when every batch fell back — the provider did nothing, which looks
     *  identical to "had nothing to add" in the counts alone. */
    degraded: { type: 'boolean' },
    /** Spec 4.3's re-normalize, when anything applied. Null when nothing did. */
    jobId: nullableString,
  },
} as const;

/**
 * One row of an Ask answer’s table (spec 6.7).
 *
 * Flat on purpose: spec 6.7 requires every answer to render "the underlying table or
 * chart", and one shape for all six queries is what lets the page render any of them
 * without a component per query. A field a given query has no notion of is null.
 */
const askRow = {
  $id: 'AskRow',
  type: 'object',
  properties: {
    label: { type: 'string' },
    amountCents: nullableInteger,
    count: nullableInteger,
    date: nullableString,
    /** Present for row-level queries, so spec 6.7’s "view the rows" can link. */
    transactionId: nullableString,
  },
} as const;

const askResult = {
  $id: 'AskResult',
  type: 'object',
  properties: {
    question: { type: 'string' },
    /** Spec 6.7: every answer "names the query it ran". */
    queryDescription: nullableString,
    queryName: nullableString,
    rows: { type: 'array', items: ref('AskRow') },
    rowCount: { type: 'integer' },
    totalCents: { type: 'integer' },
    /** Null when the model was unreachable, when its prose failed spec 6.7’s numeric
     *  check, or when the query returned nothing — the table is shown either way. */
    answer: nullableString,
    withheldReason: nullableString,
    /** Spec 2.4’s hard filter, counted rather than silent. */
    withheldP2P: { type: 'integer' },
    providerId: { type: 'string' },
  },
} as const;
const settings = {
  $id: 'Settings',
  type: 'object',
  properties: {
    /** Spec 7.4: what `analysis_run` records and `finding.rule_version` incorporates. */
    configHash: { type: 'string' },
    rules: { type: 'array', items: ref('SettingRule') },
    thresholds: { type: 'array', items: ref('SettingThreshold') },
    unsettable: { type: 'array', items: ref('SettingUnsettable') },
    /** Spec 6.8's LLM provider section. A separate settings key from the analyzer
     *  config, so choosing a provider does not move `config_hash` — see
     *  `llm-service.ts`. */
    llm: ref('LlmSettings'),
    databaseFile: { type: 'string' },
    backupDir: { type: 'string' },
  },
} as const;

const settingsUpdate = {
  $id: 'SettingsUpdate',
  type: 'object',
  properties: {
    settings: ref('Settings'),
    configHashChanged: { type: 'boolean' },
    /** Dismissed findings belonging to rules whose own section changed. Spec 5.1
     *  re-evaluates them on the next run. */
    dismissalsAffected: { type: 'integer' },
  },
} as const;

const wipeResult = {
  $id: 'WipeResult',
  type: 'object',
  properties: {
    /** Written immediately before the delete. Null only for an in-memory instance,
     *  which has nothing on disk to copy. */
    backupPath: { type: ['string', 'null'] },
    rowsDeleted: { type: 'integer' },
    deletedByTable: { type: 'object', additionalProperties: { type: 'integer' } },
  },
} as const;

// ---------------------------------------------- series / subscriptions (§6.5) ---

/** §5.3's ordered charge list, as stored by the run that fitted the series (§9i). */
const seriesCharge = {
  $id: 'SeriesCharge',
  type: 'object',
  properties: {
    transactionId: { type: 'string' },
    /** Signed, as stored — negative is money leaving (spec 3.1). */
    amountCents: { type: 'integer' },
    effectiveDate: { type: 'string' },
  },
} as const;

/** §5.5's price steps. Magnitudes, not signed amounts — a price is a positive number. */
const seriesPriceStep = {
  $id: 'SeriesPriceStep',
  type: 'object',
  properties: {
    at: { type: 'string', description: 'Effective date of the first charge at the new price' },
    fromCents: { type: 'integer' },
    toCents: { type: 'integer' },
    deltaCents: { type: 'integer', description: 'Positive for an increase' },
    occurrencesAtNewPrice: { type: 'integer' },
    /** Spec 5.5: an unconfirmed step is shown at reduced confidence and labelled
     *  "one charge at the new price" rather than withheld. */
    confirmed: { type: 'boolean' },
  },
} as const;

/**
 * One recurring series — `recurring_series` (spec 3.1), as spec 6.5's page reads it.
 *
 * `monthlyCents`, `annualCents` and `totalPaidCents` are computed here rather than in
 * the page, because spec 5.2 pins the reason: "`cadences_per_year` is stored on the
 * series, not recomputed per rule, so spec 5.5's `delta × cadences_per_year` and the
 * Subscriptions page's annual totals cannot disagree." A client-side multiplication
 * would be a second place that arithmetic lives.
 *
 * `effectiveStatus` is `COALESCE(user_status, status)` — spec 6.5's "a manual status
 * always beats the computed one", resolved once so the page and spec 6.4's headline
 * cannot disagree either.
 */
const series = {
  $id: 'Series',
  type: 'object',
  properties: {
    id: { type: 'string' },
    merchantId: { type: 'string' },
    accountId: { type: 'string' },
    /** Fractional: spec 5.2's table is monthly = 30.44 days, weekly = 7. */
    cadenceDays: { type: ['number', 'null'] },
    cadenceLabel: nullableString,
    cadencesPerYear: { type: ['number', 'null'] },
    /** A magnitude: spec 5.2 derives it as the median of the current price step.
     *  `charges[].amountCents` is the signed one — see `SeriesCharge`. */
    amountCentsCurrent: nullableInteger,
    amountCentsFirst: nullableInteger,
    firstSeen: nullableString,
    lastSeen: nullableString,
    /** Spec 5.2 measures liveness against the account's own coverage end, never the
     *  wall clock — so this can legitimately be in the past. */
    nextExpected: nullableString,
    occurrenceCount: { type: 'integer' },
    /** What spec 5.2 computed. */
    status: { type: 'string', enum: SERIES_STATUSES },
    /** Spec 6.5's manual override, or null when the user has not set one. */
    userStatus: { type: ['string', 'null'], enum: [...SERIES_STATUSES, null] },
    /** The one the page and every total use. */
    effectiveStatus: { type: 'string', enum: SERIES_STATUSES },
    cancellationUrl: nullableString,
    notes: nullableString,
    regularity: { type: ['number', 'null'] },
    confidence: { type: ['number', 'null'] },
    monthlyCents: { type: 'integer' },
    annualCents: { type: 'integer' },
    /** Spec 6.5's "total paid to date" — the sum of the charges actually observed,
     *  not the annualized rate. */
    totalPaidCents: { type: 'integer' },
    charges: { type: 'array', items: ref('SeriesCharge') },
    priceSteps: { type: 'array', items: ref('SeriesPriceStep') },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/**
 * Spec 6.5's three user-owned fields.
 *
 * No `default` on any of them, for the reason stated above `formatProfileDraft`:
 * Fastify applies schema defaults to the body, which makes an omitted field
 * indistinguishable from a deliberate one — and here that difference is the whole
 * point. Omitting `userStatus` leaves the override alone; sending `null` clears it and
 * hands the series back to spec 5.2's computed status.
 */
const seriesPatch = {
  $id: 'SeriesPatch',
  type: 'object',
  properties: {
    userStatus: { type: ['string', 'null'], enum: [...SERIES_STATUSES, null] },
    /** Rendered as a link by spec 6.5's drawer, so the route refuses any scheme other
     *  than http/https — a stored `javascript:` URL would otherwise be one click from
     *  running inside the page. */
    cancellationUrl: nullableString,
    notes: nullableString,
  },
} as const;

// ------------------------------------------------- accounts (§6.2, §7.2) ---

/** One committed import's span. §7.2 makes coverage a fact about *statements*,
 *  so the import that proves a month is named alongside it. */
const coveragePeriod = {
  $id: 'CoveragePeriod',
  type: 'object',
  properties: {
    importId: { type: 'string' },
    sourceFilename: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
  },
} as const;

/**
 * One cell of §6.2's coverage bar.
 *
 * Three states, and `partial` is no longer the common case. A profile that
 * carries a `periodPattern` reads the period the statement *declares*, so an
 * ordinary January statement running the 3rd to the 30th now spans January and
 * goes green (§9h). `partial` stays because a statement genuinely covering half a
 * month is still a real thing — a mid-cycle export, or a bank whose preamble this
 * app cannot read yet — and it is precisely what spec 5.10 and 5.11 refuse to
 * compute over.
 */
const coverageMonth = {
  $id: 'CoverageMonth',
  type: 'object',
  properties: {
    month: { type: 'string', description: '`YYYY-MM`' },
    state: { type: 'string', enum: COVERAGE_STATES },
    /** Spec 7.2, unweakened: a *single* committed import spans the whole month.
     *  Two half-month statements leave the middle unproven. */
    covered: { type: 'boolean' },
    /** A covered month with no rows and an uncovered month with no rows look
     *  identical without this, and they are the two cases the bar exists to
     *  tell apart. */
    transactionCount: { type: 'integer' },
  },
} as const;

/**
 * §6.2's coverage bar, and the precondition for trusting anything on §6.4.
 *
 * "Gaps are visible at a glance, which matters because most findings degrade
 * quietly with missing months and because §5.10 and §5.11 refuse to compute over
 * partial months at all."
 */
const accountCoverage = {
  $id: 'AccountCoverage',
  type: 'object',
  properties: {
    accountId: { type: 'string' },
    periods: { type: 'array', items: ref('CoveragePeriod') },
    /** Contiguous from the first month with a statement or a row to the last, so
     *  a gap is an empty cell rather than an absent one. */
    months: { type: 'array', items: ref('CoverageMonth') },
    coverageStart: nullableString,
    /** §7.2's reference point for every liveness and lapse test in §5. */
    coverageEnd: nullableString,
    /** Months inside the span with no statement touching them at all. */
    gapMonths: { type: 'array', items: { type: 'string' } },
    /** Months a statement touches but does not provably span. */
    partialMonths: { type: 'array', items: { type: 'string' } },
    transactionCount: { type: 'integer' },
    /** §2.6's "What this cannot do": transfer-shaped debits in this account whose
     *  counterpart is not in the system, and which therefore count as spend. */
    unmatchedTransferCount: { type: 'integer' },
  },
} as const;

const accountMergeResult = {
  $id: 'AccountMergeResult',
  type: 'object',
  properties: {
    targetAccountId: { type: 'string' },
    sourceAccountId: { type: 'string' },
    transactionsMoved: { type: 'integer' },
    importsMoved: { type: 'integer' },
    /** §3.2's `UNIQUE (account_id, dedupe_key, occurrence_index)` forces a
     *  renumber where both accounts held the same row. */
    occurrencesRenumbered: { type: 'integer' },
    seriesMoved: { type: 'integer' },
    evidenceMoved: { type: 'integer' },
    /** Links whose two sides now sit in one account, and are therefore not
     *  transfers at all. */
    selfLinksRemoved: { type: 'integer' },
  },
} as const;

// ------------------------------------------- internal transfers (§2.6, §6.2) ---

/** One line of §6.2's "the score's reasons". */
const transferReason = {
  $id: 'TransferReason',
  type: 'object',
  properties: {
    signal: { type: 'string', description: 'Stable code from spec 2.6’s scoring table' },
    points: { type: 'integer' },
    detail: { type: 'string' },
  },
} as const;

/**
 * A transfer link as §6.2's queue reads it.
 *
 * Both rows travel with it rather than as ids to fetch: §6.2 asks for "proposed
 * pairs with **both rows**, the score's reasons, and the dollar effect of
 * confirming", and a queue whose rows arrive one round trip later is a queue
 * confirmed against a spinner.
 *
 * `debits` is an array because §2.6's partial-payment pass matches one credit
 * against up to three debits. `id` names the whole group; confirming or rejecting
 * acts on all of it.
 */
const transferLink = {
  $id: 'TransferLink',
  type: 'object',
  properties: {
    id: { type: 'string' },
    state: { type: 'string', enum: TRANSFER_LINK_STATES },
    /** `one_to_one`, or `partial` for spec 2.6’s second pass — which always
     *  proposes and never auto-links. */
    kind: { type: 'string', enum: TRANSFER_MATCH_KINDS },
    score: { type: 'integer' },
    reasons: { type: 'array', items: ref('TransferReason') },
    debits: { type: 'array', items: ref('Transaction') },
    credit: ref('Transaction'),
    debitAccount: nullableObject(account),
    creditAccount: nullableObject(account),
    /** Magnitude of the money that moved, in integer cents (spec 7.3). */
    amountCents: { type: 'integer' },
    /**
     * §6.2's "dollar effect of confirming": the debit total, which is what stops
     * counting as spending. Not the debit plus the credit — that is the same
     * money twice.
     */
    spendReductionCents: { type: 'integer' },
    /** Days from the debit to the credit. Negative means the credit landed
     *  first, which spec 2.6 allows one day of. */
    dayGapDays: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/** What a link pass did. `proposed` is the number the user has to act on: spec
 *  2.6 leaves a proposal counted as spend until it is confirmed. */
const transferProposeResult = {
  $id: 'TransferProposeResult',
  type: 'object',
  properties: {
    autoLinked: { type: 'integer' },
    proposed: { type: 'integer' },
    ignored: { type: 'integer' },
    inserted: { type: 'integer' },
    updated: { type: 'integer' },
    withdrawn: { type: 'integer' },
    flagged: { type: 'integer' },
    unflagged: { type: 'integer' },
  },
} as const;

/** §2.7's queue row. `GET /api/jobs/:id` is what the UI polls while the
 *  in-process runner works through it. */
const job = {
  $id: 'Job',
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    state: { type: 'string', enum: JOB_STATES },
    progress: { type: 'integer' },
    message: nullableString,
    resultJson: nullableString,
    finishedAt: nullableString,
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/**
 * The filter half of a bulk request — §6.3's selection, expressed the same way
 * `GET /api/transactions` expresses it.
 *
 * Deliberately the same field names as the query string, because they have to
 * mean the same thing: the dry-run count the user is shown comes from this
 * object, and the apply that follows sends the object back unchanged.
 */
const transactionFilter = {
  $id: 'TransactionFilter',
  type: 'object',
  properties: {
    /** Exactly these rows, by surrogate id. An empty array matches nothing —
     *  the one list filter here for which empty is a selection rather than a
     *  missing one. */
    ids: { type: 'array', items: { type: 'string' } },
    accountIds: { type: 'array', items: { type: 'string' } },
    merchantIds: { type: 'array', items: { type: 'string' } },
    categoryIds: { type: 'array', items: { type: 'string' } },
    /** Exact match on `description_normalized` — what "apply to all 47 matching
     *  descriptors" selects on. */
    descriptorsNormalized: { type: 'array', items: { type: 'string' } },
    from: { type: 'string' },
    to: { type: 'string' },
    minAmountCents: { type: 'integer' },
    maxAmountCents: { type: 'integer' },
    isPending: { type: 'boolean' },
    hasFinding: { type: 'boolean' },
    includeInternalTransfers: { type: 'boolean' },
    includeExcluded: { type: 'boolean' },
    q: { type: 'string' },
  },
} as const;

/** The change half. One change applied to a filter-matched set (§2.3). */
const transactionBulkChange = {
  $id: 'TransactionBulkChange',
  type: 'object',
  properties: {
    merchantId: nullableString,
    categoryId: nullableString,
    isInternalTransfer: { type: 'boolean' },
    isExcluded: { type: 'boolean' },
  },
} as const;

/**
 * What a bulk request answers with.
 *
 * `matchCount` is populated on both paths; on `?dryRun=true` it is the *only*
 * populated field, which is §2.3's "returns the match count only".
 */
const transactionBulkResult = {
  $id: 'TransactionBulkResult',
  type: 'object',
  properties: {
    dryRun: { type: 'boolean' },
    matchCount: { type: 'integer' },
    updated: { type: 'integer' },
    /** Set when a merchant assignment wrote a `user` alias (§4.3). */
    aliasKeysWritten: { type: 'array', items: { type: 'string' } },
    /** §2.7's coalesced job, when the change enqueued one. */
    renormalizeJobId: nullableString,
    renormalizeJobCoalesced: { type: 'boolean' },
  },
} as const;

const SHARED = [
  // `ApiError` is a response but not a row: `rowIndexes` really is absent on
  // every error except `zero_amount_rows`, so it stays optional.
  apiError,
  allRequired(account),
  allRequired(transaction),
  allRequired(transactionSearchRow),
  allRequired(transactionPage),
  allRequired(statementImport),
  allRequired(transactionSourceLine),
  allRequired(transactionDetail),
  allRequired(merchant),
  allRequired(reviewMerchant),
  allRequired(mergeCandidate),
  allRequired(merchantReviewQueue),
  allRequired(merchantMergeResult),
  allRequired(merchantAliasResult),
  allRequired(category),
  // §6.8's editor. `Category` first — the three below all $ref it.
  allRequired(categoryUsage),
  allRequired(categoryUpdate),
  allRequired(categoryDeleteResult),
  allRequired(job),

  // §5.1 and §6.4. `finding.detail` is the one free-shaped field on the wire and
  // stays required: every finding has a payload, even when it is `{}`.
  allRequired(finding),
  allRequired(findingPage),
  allRequired(subscriptionTotals),
  allRequired(findingsSummary),
  allRequired(dismissalRule),

  // §6.2's two halves: the coverage bar and the Possible Transfers queue.
  allRequired(coveragePeriod),
  allRequired(coverageMonth),
  allRequired(accountCoverage),
  allRequired(accountMergeResult),
  allRequired(transferReason),
  allRequired(transferLink),
  allRequired(transferProposeResult),

  // Both halves of a bulk request. Every field optional, by design.
  transactionFilter,
  transactionBulkChange,
  allRequired(transactionBulkResult),

  // §6.1's review surface. `parseWarning` and `balanceCheck` declare their own
  // `required` because their optional fields are genuinely absent depending on
  // what happened, not merely undeclared.
  allRequired(accountSuggestion),
  allRequired(rawRow),
  allRequired(rawRowRecord),
  parseWarning,
  allRequired(balanceMismatch),
  balanceCheck,
  allRequired(reviewRow),
  allRequired(nearDuplicateCandidate),
  allRequired(reviewPlan),
  allRequired(importReview),
  allRequired(stagedUpload),
  allRequired(uploadResult),
  allRequired(commitResult),
  allRequired(deleteImportResult),

  // The mapper. `columnRef` and `columnMap` are partial by nature — a role that is
  // not mapped is an absent key, which is what `Partial<Record<ColumnRole, ...>>`
  // means in `parsing`. `formatProfileDraft` is a request body.
  // §6.8's config surface. `unsettable` and `deletedByTable` are open maps by
  // nature, so they declare their own shapes above.
  // §6.6 (§9aa). `CoverageWindow` before the three that $ref it.
  allRequired(coverageWindow),
  allRequired(categorySlice),
  allRequired(categoryMonth),
  allRequired(categoryInsight),
  allRequired(mover),
  allRequired(moversInsight),
  allRequired(feeMerchant),
  allRequired(feeAccount),
  allRequired(feesInsight),
  allRequired(ruleBackedRow),
  allRequired(ruleBackedInsight),
  // §7.6’s corpus (§9ab).
  allRequired(transactionLabel),
  allRequired(calibrationProgress),
  allRequired(normalizationSplit),
  allRequired(normalizationCalibration),
  allRequired(ruleCalibration),
  allRequired(calibrationReport),
  allRequired(settingThreshold),
  allRequired(settingUnsettable),
  allRequired(ruleAccuracy),
  allRequired(settingRule),
  // §6.8's LLM provider, Redaction, and the degraded-call log in Data. Before
  // `settings`, which `$ref`s the first of them.
  allRequired(llmSettings),
  allRequired(llmHealth),
  allRequired(degradedCall),
  allRequired(degradedCallLog),
  allRequired(llmProposal),
  allRequired(llmProposalRun),
  allRequired(askRow),
  allRequired(askResult),
  allRequired(settings),
  allRequired(settingsUpdate),
  allRequired(wipeResult),

  // §6.5's ledger. `seriesPatch` is a request body, so it stays partial.
  allRequired(seriesCharge),
  allRequired(seriesPriceStep),
  allRequired(series),
  seriesPatch,

  columnRef,
  columnMap,
  allRequired(formatProfile),
  formatProfileDraft,
  allRequired(formatProfilePreview),
];

/**
 * Register every shared schema. Must run before the routes that `$ref` them —
 * Fastify resolves shared schemas at route-registration time, not at request
 * time, so a late `addSchema` is a boot-time failure rather than a silent one.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  for (const schema of SHARED) {
    app.addSchema(schema);
  }
}

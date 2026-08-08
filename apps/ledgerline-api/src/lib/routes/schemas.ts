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

export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card'] as const;
export const CATEGORY_KINDS = ['spend', 'fee', 'transfer', 'income'] as const;
export const PROVENANCE_SOURCES = ['seed', 'rule', 'llm', 'user'] as const;
export const IMPORT_STATUSES = [
  'uploaded',
  'needs_mapping',
  'staged',
  'committed',
  'failed',
] as const;
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const ROW_STATUSES = ['posted', 'pending'] as const;
export const PARSE_SOURCES = ['csv', 'pdf', 'llm'] as const;
export const PARSE_STATUSES = ['ok', 'error'] as const;
export const DISPOSITIONS = ['insert', 'duplicate', 'near_duplicate'] as const;
export const RESOLUTIONS = ['replace', 'keep_both', 'skip'] as const;
export const AMOUNT_MODES = ['single', 'debit_credit'] as const;
export const SIGN_CONVENTIONS = ['as_is', 'invert'] as const;
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

const category = {
  $id: 'Category',
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    parentId: nullableString,
    kind: { type: 'string', enum: CATEGORY_KINDS },
    overlapGroup: nullableString,
  },
} as const;

/** §2.7's queue row. The runner is separate work; this is what
 *  `GET /api/jobs/:id` reports while the UI polls. */
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
  allRequired(category),
  allRequired(job),
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

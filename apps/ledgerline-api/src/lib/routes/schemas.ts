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

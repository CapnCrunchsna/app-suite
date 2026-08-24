/**
 * `/api/format-profiles` — §2.3's profile endpoints, and the three calls §6.1's
 * column mapper is built out of.
 *
 * ## Why `preview` exists at all
 *
 * §6.1 asks the mapper for "a date-format picker with a live preview". The code that
 * knows how `01/02/2026` reads under `MM/DD/YYYY` lives in `type:parsing`, and §2.2
 * forbids `type:feature` from depending on it. So the choice is an endpoint or a
 * second date parser in the UI — and a preview computed by a different parser than
 * the importer is a preview that can lie. This route runs the real one, over the
 * file's real bytes, and returns what it produced.
 *
 * Not in §2.3's table; recorded as an addition in §9a.
 *
 * ## Why the signature comes from the file, never from the request
 *
 * `format_profile.header_signature` is UNIQUE (§3.1) and is what makes "the next
 * statement from that bank imports without asking" true. A client-supplied signature
 * could be keyed to something the statement does not contain, and the profile would
 * then never match again — a bug that only shows up on the *next* import, weeks
 * later. Both routes below therefore take an `importId` and derive the signature from
 * the stored bytes. A profile built without a file in hand is what `profiles/*.json`
 * is for.
 */

import type { FastifyInstance } from 'fastify';

import type { AccountType } from '@metrum/ledgerline-domain';
import {
  ProfileApplicationError,
  decodeStatementText,
  detectCsvFormat,
  parseCsvWithProfile,
  validateProfile,
} from '@metrum/ledgerline-parsing';
import type { ColumnRef, ColumnRole, FormatProfile } from '@metrum/ledgerline-parsing';

import { errorResponses } from './errors.js';
import { ref } from './schemas.js';
import { toFormatProfile } from '../context.js';
import type { LedgerlineContext } from '../context.js';

/** How many parsed rows a preview returns. Enough to see the shape of the file and
 *  to catch a date read the wrong way round; not so many that the mapper is a
 *  second copy of the review table. */
const PREVIEW_ROWS = 12;

interface FormatProfileDraft {
  id?: string;
  institution: string;
  accountTypeHint?: AccountType | null;
  hasHeader?: boolean;
  delimiter?: string;
  skipLines?: number;
  dateFormat: string;
  /** Omitted means "keep whatever the profile being updated already had"; an
   *  explicit `null` clears it. See `toCandidate`. */
  periodPattern?: string | null;
  amountMode?: 'single' | 'debit_credit';
  signConvention?: 'as_is' | 'invert';
  columnMap: Partial<Record<ColumnRole, ColumnRef>>;
  pendingValues?: string[];
}

interface DraftBody {
  importId: string;
  draft: FormatProfileDraft;
}

/** A readable, stable id from an institution name. */
function slug(institution: string): string {
  return (
    institution
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'profile'
  );
}

interface FileShape {
  readonly text: string;
  readonly headerSignature: string;
  readonly headerTokens: readonly string[];
  readonly delimiter: string;
  readonly skipLines: number;
  /** The first data rows as raw cells, for the mapper's grid. */
  readonly sampleRows: readonly (readonly string[])[];
}

/**
 * What the file itself says about its own shape.
 *
 * Re-detected from the stored bytes rather than read out of `diagnosticsJson`,
 * because a re-parse under a different profile rewrites those diagnostics and the
 * signature has to stay a property of the file.
 */
function readFileShape(
  context: LedgerlineContext,
  importId: string,
): { ok: true; shape: FileShape } | { ok: false; reason: string } {
  const text = decodeStatementText(context.store.imports.readFileBytes(importId));
  const profiles = context.store.formatProfiles.list().map(toFormatProfile);
  const detection = detectCsvFormat(text, profiles);

  if (detection.kind === 'undetectable') {
    return { ok: false, reason: detection.reason };
  }

  return {
    ok: true,
    shape: {
      text,
      headerSignature: detection.signature.signature,
      headerTokens: detection.signature.tokens,
      delimiter: detection.delimiter,
      // A matched detection has no `skipLines` of its own — the profile that matched
      // carries it. Only `needs_mapping` reports one, which is the case the mapper
      // is open for.
      skipLines:
        detection.kind === 'needs_mapping' ? detection.skipLines : detection.profile.skipLines,
      sampleRows: detection.kind === 'needs_mapping' ? detection.sampleRows : [],
    },
  };
}

/**
 * The draft, plus what the file supplies, as the profile the parser takes.
 *
 * `carriedPeriodPattern` is the one field the mapper has no control for yet
 * (§9h). Letting an omitted field mean "null" would quietly delete a working
 * profile's declared period the first time anyone re-saved its column mapping —
 * and the symptom would be months going grey on §6.2's bar weeks later, with the
 * mapping edit long forgotten. Omitted keeps; an explicit `null` clears.
 */
function toCandidate(
  draft: FormatProfileDraft,
  shape: FileShape,
  id: string,
  carriedPeriodPattern: string | null = null,
): FormatProfile {
  return {
    id,
    institution: draft.institution,
    accountTypeHint: draft.accountTypeHint ?? null,
    headerSignature: shape.headerSignature,
    headerTokens: shape.headerTokens,
    hasHeader: draft.hasHeader ?? true,
    delimiter: draft.delimiter ?? shape.delimiter,
    skipLines: draft.skipLines ?? shape.skipLines,
    dateFormat: draft.dateFormat,
    periodPattern:
      draft.periodPattern === undefined ? carriedPeriodPattern : draft.periodPattern,
    amountMode: draft.amountMode ?? 'single',
    signConvention: draft.signConvention ?? 'as_is',
    columnMap: draft.columnMap,
    pendingValues: draft.pendingValues ?? [],
    currency: 'USD',
    version: 1,
    source: 'user',
  };
}

const draftBody = {
  type: 'object',
  required: ['importId', 'draft'],
  properties: {
    importId: { type: 'string' },
    draft: ref('FormatProfileDraft'),
  },
} as const;

export function registerFormatProfileRoutes(
  app: FastifyInstance,
  context: LedgerlineContext,
): void {
  app.get(
    '/api/format-profiles',
    {
      schema: {
        summary: 'Column-mapping profiles, keyed on header signature',
        operationId: 'listFormatProfiles',
        description:
          'Both shipped (`source: "seed"`) and mapper-created (`source: "user"`) profiles. ' +
          'The mapper lists them so a near-miss can be copied rather than rebuilt (spec 6.1).',
        tags: ['imports'],
        response: {
          200: { type: 'array', items: ref('FormatProfile') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.formatProfiles.list().map(toFormatProfile),
  );

  /**
   * Parse a draft against a staged file and report what happened. Writes nothing.
   *
   * `validateProfile`'s errors and warnings are passed through unedited. That
   * function refuses anything ambiguous eagerly and explains why — including that a
   * missing balance column costs the reconciliation check, which §6.1 calls the
   * strongest signal that the amount column and sign convention are right. Rewording
   * those in the UI would mean two descriptions of one rule, drifting apart.
   */
  app.post<{ Body: DraftBody & { limit?: number } }>(
    '/api/format-profiles/preview',
    {
      schema: {
        summary: 'Parse a candidate mapping without saving it',
        operationId: 'previewFormatProfile',
        description:
          'Runs the real parser over the import’s stored bytes, so spec 6.1’s live preview shows ' +
          'what the importer would actually produce rather than a second opinion about it. ' +
          'Nothing is written — not the profile, not the rows.',
        tags: ['imports'],
        body: {
          ...draftBody,
          properties: {
            ...draftBody.properties,
            limit: { type: 'integer', minimum: 1, maximum: 100, default: PREVIEW_ROWS },
          },
        },
        response: { 200: ref('FormatProfilePreview'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { importId, draft } = request.body;
      const limit = request.body.limit ?? PREVIEW_ROWS;

      const record = context.store.imports.get(importId);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      }

      const read = readFileShape(context, importId);
      if (!read.ok) {
        return reply.code(422).send({ error: 'undetectable', message: read.reason });
      }

      const candidate = toCandidate(
        draft,
        read.shape,
        draft.id ?? 'preview',
        context.store.formatProfiles.findByHeaderSignature(read.shape.headerSignature)
          ?.periodPattern ?? null,
      );

      /** Everything the mapper needs about the file, regardless of how the draft
       *  fared — the grid stays populated while the mapping is still wrong. */
      const detected = {
        headerSignature: read.shape.headerSignature,
        headerTokens: read.shape.headerTokens,
        detectedDelimiter: read.shape.delimiter,
        detectedSkipLines: read.shape.skipLines,
        sampleRows: read.shape.sampleRows.map((cells) => ({ cells })),
      };

      const refused = (errors: readonly string[], warnings: readonly string[], reason: string) => ({
        ok: false,
        errors,
        warnings,
        rows: [],
        failures: [],
        parseWarnings: [],
        balanceCheck: { kind: 'unavailable', reason },
        ...detected,
      });

      // A draft that cannot parse gets its reasons and no rows. A partial preview
      // beside a list of errors reads as a partial success, which is the wrong
      // impression to give about a mapping that would drop half the file.
      const validation = validateProfile(candidate);
      if (!validation.ok) {
        return refused(
          validation.errors,
          validation.warnings,
          'the draft mapping is not usable yet, so nothing was parsed',
        );
      }

      let parsed;
      try {
        parsed = parseCsvWithProfile({ text: read.shape.text, profile: candidate });
      } catch (cause) {
        /**
         * A mapping that names columns this file does not have.
         *
         * `validateProfile` cannot catch it — it checks a profile in isolation, and
         * whether `"Fecha"` exists is a fact about the file. This is also the single
         * most likely state while someone is *building* a mapping, so it is a
         * reported outcome rather than a 500, and the parser's own message is passed
         * through because it already lists both what was asked for and what the file
         * actually has.
         */
        if (cause instanceof ProfileApplicationError) {
          return refused(
            [cause.message],
            validation.warnings,
            'the draft mapping does not fit this file, so nothing was parsed',
          );
        }
        throw cause;
      }

      return {
        ok: true,
        errors: [],
        warnings: validation.warnings,
        rows: parsed.rows.slice(0, limit),
        failures: parsed.errors.slice(0, limit).map((row) => ({
          rowIndex: row.rowIndex,
          lineNumber: row.lineNumber,
          rawText: row.rawText,
          errors: row.errors,
        })),
        parseWarnings: parsed.warnings,
        balanceCheck: parsed.balanceCheck,
        ...detected,
      };
    },
  );

  /**
   * Save the draft as a `format_profile` (§6.1: "the next statement from that bank
   * imports without asking").
   *
   * Refuses an invalid draft rather than storing it. A stored profile that cannot
   * parse is worse than no profile: `detect` would match it on signature and every
   * future statement from that bank would fail against it instead of reaching the
   * mapper.
   *
   * Saving does **not** re-parse the import. `PATCH /api/imports/:id` with the new
   * `formatProfileId` already does exactly that, and keeping the two separate means
   * the re-parse path has one implementation rather than two.
   */
  app.post<{ Body: DraftBody }>(
    '/api/format-profiles',
    {
      schema: {
        summary: 'Save a column mapping as a reusable profile',
        operationId: 'createFormatProfile',
        description:
          'Keyed on the header signature read from the import’s own bytes, never from the ' +
          'request. An existing profile for that signature is updated in place with its version ' +
          'bumped — `header_signature` is UNIQUE (spec 3.1), so a second row for one signature ' +
          'is not a thing that can exist. Re-parse the import with ' +
          '`PATCH /api/imports/:id { formatProfileId }`.',
        tags: ['imports'],
        body: draftBody,
        response: { 201: ref('FormatProfile'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { importId, draft } = request.body;

      const record = context.store.imports.get(importId);
      if (!record) {
        return reply.code(404).send({ error: 'not_found', message: 'no such import' });
      }

      const read = readFileShape(context, importId);
      if (!read.ok) {
        return reply.code(422).send({ error: 'undetectable', message: read.reason });
      }

      // The signature already has a profile: update that one. Inserting a second
      // would violate §3.1's UNIQUE index, and "update the profile for this bank's
      // export format" is what the reviewer means anyway.
      const existing = context.store.formatProfiles.findByHeaderSignature(
        read.shape.headerSignature,
      );
      const id =
        draft.id ??
        existing?.id ??
        `${slug(draft.institution)}-${read.shape.headerSignature.slice(0, 8)}`;

      const candidate = toCandidate(draft, read.shape, id, existing?.periodPattern ?? null);
      const validation = validateProfile(candidate);

      if (!validation.ok) {
        return reply.code(422).send({
          error: 'invalid_profile',
          message: validation.errors.join('; '),
        });
      }

      // Prove it against the file before storing it. A profile that validates in
      // isolation can still name columns this statement does not have, and storing
      // that one is the trap described at the top of this file: `detect` matches it
      // on signature and every future statement from the bank fails against it
      // instead of reaching the mapper.
      try {
        parseCsvWithProfile({ text: read.shape.text, profile: candidate });
      } catch (cause) {
        if (cause instanceof ProfileApplicationError) {
          return reply.code(422).send({ error: 'invalid_profile', message: cause.message });
        }
        throw cause;
      }

      const saved = context.store.formatProfiles.upsert({
        id,
        institution: candidate.institution,
        accountTypeHint: candidate.accountTypeHint,
        headerSignature: candidate.headerSignature,
        headerTokens: candidate.headerTokens,
        hasHeader: candidate.hasHeader,
        delimiter: candidate.delimiter,
        skipLines: candidate.skipLines,
        columnMapJson: JSON.stringify(candidate.columnMap),
        dateFormat: candidate.dateFormat,
        periodPattern: candidate.periodPattern,
        amountMode: candidate.amountMode,
        signConvention: candidate.signConvention,
        pendingValues: candidate.pendingValues,
        currency: candidate.currency,
        version: (existing?.version ?? 0) + 1,
        source: 'user',
      });

      return reply.code(201).send(toFormatProfile(saved));
    },
  );
}

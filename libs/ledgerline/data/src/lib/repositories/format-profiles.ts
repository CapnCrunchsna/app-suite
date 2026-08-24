/**
 * Format profiles (§3.1 `format_profile`), keyed on header signature.
 *
 * The columns mirror `FormatProfile` in `ledgerline-parsing` field for field, so
 * persisting one the CLI produced is a column-for-column write
 * (docs/statement-parsing.md §4). This lib does not import that type — a
 * `type:data-access` lib may only depend on `type:domain` (§2.2) — so the shape
 * is restated here and the composition root does the one-line conversion.
 */

import type { AccountType, Currency } from '@metrum/ledgerline-domain';

import { newStamp, asInt } from './stamp.js';
import type { Clock } from '../clock.js';
import type { Database } from '../database.js';
import { toFormatProfile } from '../records.js';
import type { FormatProfileRecord, FormatProfileRow } from '../records.js';

export interface FormatProfileInput {
  /** Profiles ship with stable ids (`northgate-checking-v1`), which is what
   *  `--profile` and `statement_import.format_profile_id` refer to. */
  readonly id: string;
  readonly institution: string;
  readonly accountTypeHint: AccountType | null;
  readonly headerSignature: string;
  readonly headerTokens: readonly string[];
  readonly hasHeader: boolean;
  readonly delimiter: string;
  readonly skipLines: number;
  readonly columnMapJson: string;
  readonly dateFormat: string;
  /** The regex that reads the bank's declared statement period out of the
   *  preamble; `null` for an export that declares none (§9h). */
  readonly periodPattern: string | null;
  readonly amountMode: 'single' | 'debit_credit';
  readonly signConvention: 'as_is' | 'invert';
  readonly pendingValues: readonly string[];
  readonly currency: Currency;
  readonly version: number;
  readonly source: 'seed' | 'user';
}

const SELECT = `SELECT id, institution, account_type_hint, header_signature, header_tokens_json,
                       has_header, delimiter, skip_lines, column_map_json, date_format,
                       period_pattern, amount_mode, sign_convention, pending_values_json,
                       currency, version, source
                  FROM format_profile`;

export class FormatProfileRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock
  ) {}

  upsert(input: FormatProfileInput): FormatProfileRecord {
    const stamp = newStamp(this.clock);
    this.db
      .prepare(
        `INSERT INTO format_profile
           (id, institution, account_type_hint, header_signature, header_tokens_json, has_header,
            delimiter, skip_lines, column_map_json, date_format, period_pattern, amount_mode,
            sign_convention, pending_values_json, currency, version, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           institution = excluded.institution,
           account_type_hint = excluded.account_type_hint,
           header_signature = excluded.header_signature,
           header_tokens_json = excluded.header_tokens_json,
           has_header = excluded.has_header,
           delimiter = excluded.delimiter,
           skip_lines = excluded.skip_lines,
           column_map_json = excluded.column_map_json,
           date_format = excluded.date_format,
           period_pattern = excluded.period_pattern,
           amount_mode = excluded.amount_mode,
           sign_convention = excluded.sign_convention,
           pending_values_json = excluded.pending_values_json,
           currency = excluded.currency,
           version = excluded.version,
           source = excluded.source,
           updated_at = excluded.updated_at`
      )
      .run(
        input.id,
        input.institution,
        input.accountTypeHint,
        input.headerSignature,
        JSON.stringify(input.headerTokens),
        asInt(input.hasHeader),
        input.delimiter,
        input.skipLines,
        input.columnMapJson,
        input.dateFormat,
        input.periodPattern,
        input.amountMode,
        input.signConvention,
        JSON.stringify(input.pendingValues),
        input.currency,
        input.version,
        input.source,
        stamp.createdAt,
        stamp.updatedAt
      );
    return this.get(input.id) as FormatProfileRecord;
  }

  get(id: string): FormatProfileRecord | null {
    const row = this.db.prepare<[string], FormatProfileRow>(`${SELECT} WHERE id = ?`).get(id);
    return row ? toFormatProfile(row) : null;
  }

  /** §2.5's `detect` stage: "hash the header row into a *format signature* and
   *  look up a `format_profile`". */
  findByHeaderSignature(headerSignature: string): FormatProfileRecord | null {
    const row = this.db
      .prepare<[string], FormatProfileRow>(`${SELECT} WHERE header_signature = ?`)
      .get(headerSignature);
    return row ? toFormatProfile(row) : null;
  }

  list(): FormatProfileRecord[] {
    return this.db
      .prepare<[], FormatProfileRow>(`${SELECT} ORDER BY institution, id`)
      .all()
      .map(toFormatProfile);
  }
}

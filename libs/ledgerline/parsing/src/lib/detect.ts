/**
 * The `detect` stage of §2.5.
 *
 * "Sniff PDF vs CSV. For CSV, hash the header row into a *format signature* and look up
 * a `format_profile`. [...] Unmatched CSV → `needs_mapping`, which surfaces the mapping
 * UI."
 *
 * Detection never guesses a column map. An unrecognized header produces
 * `needs_mapping` plus ranked *suggestions* for the user to confirm — never an applied
 * profile. Plan question 2 settles this: "confirmation keeps a wrong guess from
 * silently mis-mapping an amount column, which is the failure that poisons every
 * downstream finding."
 */

import { guessDelimiter, isBlankRecord, parseCsv, findHeaderIndex } from './csv-reader.js';
import { headerSignature, signatureSimilarity } from './format-signature.js';
import type { HeaderSignature } from './format-signature.js';
import type { FormatProfile } from './format-profile.js';

export type FileKind = 'pdf' | 'csv' | 'unknown';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function sniffFileKind(bytes: Uint8Array): FileKind {
  if (bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b)) {
    return 'pdf';
  }

  // A NUL byte in the first block means binary, and nothing this pipeline reads is
  // binary except a PDF. Checking a prefix rather than the whole file keeps this cheap
  // on a large statement.
  const probe = bytes.subarray(0, 8192);
  for (const byte of probe) {
    if (byte === 0x00) return 'unknown';
  }

  return probe.length > 0 ? 'csv' : 'unknown';
}

/**
 * Similarity floor below which a known profile is not even offered as a suggestion.
 *
 * **Uncalibrated.** Per §7.6 every threshold in this project is a designed number until
 * it has been run against real statements. 0.5 means "at least half the header tokens
 * are shared", which is roughly a one-or-two-column change on a six-column export. It
 * only gates what gets *offered* to the user, never what gets applied, so being wrong
 * here costs a suggestion rather than a mis-parse.
 */
export const SIGNATURE_SUGGESTION_FLOOR = 0.5;

export interface ProfileSuggestion {
  readonly profile: FormatProfile;
  readonly similarity: number;
}

export type CsvDetection =
  | {
      readonly kind: 'matched';
      readonly profile: FormatProfile;
      readonly signature: HeaderSignature;
      readonly headerLineNumber: number;
      readonly delimiter: string;
    }
  | {
      readonly kind: 'needs_mapping';
      readonly signature: HeaderSignature;
      readonly suggestions: readonly ProfileSuggestion[];
      readonly headerLineNumber: number;
      readonly delimiter: string;
      readonly skipLines: number;
      readonly sampleRows: readonly (readonly string[])[];
    }
  | { readonly kind: 'undetectable'; readonly reason: string };

export function detectCsvFormat(
  text: string,
  profiles: readonly FormatProfile[]
): CsvDetection {
  const guess = guessDelimiter(text);
  if (!guess) {
    return {
      kind: 'undetectable',
      reason: 'no delimiter produced a consistent column count — this may not be a delimited file',
    };
  }

  const records = parseCsv(text, guess.delimiter).filter((r) => !isBlankRecord(r));
  const headerIndex = findHeaderIndex(records);
  if (headerIndex === -1) {
    return {
      kind: 'undetectable',
      reason: 'no row looks like a header — every candidate row is predominantly numeric',
    };
  }

  const headerRecord = records[headerIndex];
  const signature = headerSignature(headerRecord.cells);

  const exact = profiles.find((p) => p.headerSignature === signature.signature);
  if (exact) {
    return {
      kind: 'matched',
      profile: exact,
      signature,
      headerLineNumber: headerRecord.lineNumber,
      delimiter: guess.delimiter,
    };
  }

  const suggestions = profiles
    .map((profile) => ({
      profile,
      similarity: signatureSimilarity(signature.tokens, profile.headerTokens),
    }))
    .filter((s) => s.similarity >= SIGNATURE_SUGGESTION_FLOOR)
    .sort((a, b) => b.similarity - a.similarity);

  return {
    kind: 'needs_mapping',
    signature,
    suggestions,
    headerLineNumber: headerRecord.lineNumber,
    delimiter: guess.delimiter,
    skipLines: headerIndex,
    sampleRows: records.slice(headerIndex + 1, headerIndex + 6).map((r) => r.cells),
  };
}

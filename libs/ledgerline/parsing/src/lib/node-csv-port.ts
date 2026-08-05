/**
 * `NodeCsvParser` as a registered `ParserPort` (§2.5).
 *
 * The port's `parse(file, bytes)` takes no profile, because by the time it runs the
 * `detect` stage has already resolved one. The resolver is injected rather than looked
 * up, which is what keeps this lib pure: profiles live in the database (§3.1's
 * `format_profile`), and `type:parsing` may not reach `type:data-access` (§2.2). The
 * composition root supplies a function that reads them.
 */

import { detectCsvFormat, sniffFileKind } from './detect.js';
import type { HeaderSignature } from './format-signature.js';
import type { FormatProfile } from './format-profile.js';
import { NODE_CSV_PARSER_ID, parseCsvWithProfile, ProfileApplicationError } from './node-csv-parser.js';
import { decodeStatementText } from './parser-port.js';
import type { FileMeta, ParserPort } from './parser-port.js';

export interface CsvProfileResolverInput {
  readonly file: FileMeta;
  readonly text: string;
  readonly signature: HeaderSignature;
}

export type CsvProfileResolver = (input: CsvProfileResolverInput) => FormatProfile | null;

export function createNodeCsvParser(resolveProfile: CsvProfileResolver): ParserPort {
  return {
    id: NODE_CSV_PARSER_ID,

    async canParse(_file: FileMeta, sample: Uint8Array): Promise<number> {
      if (sniffFileKind(sample) !== 'csv') return 0;

      const detection = detectCsvFormat(decodeStatementText(sample), []);
      // A recognizable delimited file with a locatable header is a strong claim; one
      // that needs mapping is still this parser's job, but the caller must be able to
      // prefer a more specific parser, so the confidences stay well apart.
      return detection.kind === 'undetectable' ? 0.1 : 0.6;
    },

    async parse(file: FileMeta, bytes: Uint8Array) {
      const text = decodeStatementText(bytes);
      const detection = detectCsvFormat(text, []);

      if (detection.kind === 'undetectable') {
        throw new ProfileApplicationError(`${file.filename}: ${detection.reason}`);
      }

      const profile = resolveProfile({ file, text, signature: detection.signature });
      if (!profile) {
        throw new ProfileApplicationError(
          `${file.filename}: no format profile matches header signature ${detection.signature.signature.slice(0, 12)}… ` +
            `(columns: ${detection.signature.tokens.join(', ')}). This is the needs_mapping case in §2.5.`
        );
      }

      return parseCsvWithProfile({ text, profile });
    },
  };
}

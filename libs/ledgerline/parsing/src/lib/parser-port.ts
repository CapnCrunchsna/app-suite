/**
 * The `ParserPort` seam (§2.5).
 *
 * "Implementations register in priority order: `NodeCsvParser`, `NodePdfParser`,
 * `PythonParserClient`, `LlmAssistedParser`. The port exists from the PDF phase even if
 * only the Node implementations are built, so adding Python later is a registration,
 * not a refactor."
 *
 * ## Two deliberate deviations from the spec's literal signature
 *
 * 1. **`parse` returns `ParseResult`, not `RawRow[]`.** The spec types it as
 *    `Promise<RawRow[]>`, but §2.5 and §6.1 both require things a bare row array
 *    cannot carry: the review screen shows "unparsed rows, dates outside the detected
 *    period, pending rows, and a balance that doesn't reconcile", and
 *    `statement_import` (§3.1) stores `rows_parsed`, `parser`, `parser_version` and
 *    `error_detail`. Returning only the rows that succeeded would discard exactly the
 *    rows the reviewer needs to see. This is a spec correction, noted in
 *    docs/statement-parsing.md.
 * 2. **`Uint8Array` rather than `Buffer`.** A `Buffer` is a `Uint8Array`, so every
 *    caller still works, and the pure lib avoids naming a Node-only runtime type.
 */

import type { ParseResult } from '@metrum/ledgerline-domain';

export interface FileMeta {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
}

export interface ParserPort {
  readonly id: string;
  /** Confidence in `0..1` that this parser can handle the file. The registry picks the
   *  highest; ties break on registration order. */
  canParse(file: FileMeta, sample: Uint8Array): Promise<number>;
  parse(file: FileMeta, bytes: Uint8Array): Promise<ParseResult>;
}

/**
 * Try the registered parsers in priority order and return the most confident.
 *
 * A confidence of 0 means "not mine". Returning `null` rather than throwing lets the
 * caller distinguish "no parser recognized this file" — which §2.5 turns into
 * `needs_mapping` and the mapping UI — from "the parser recognized it and failed",
 * which is an error the user cannot fix by supplying a column map.
 */
export async function selectParser(
  parsers: readonly ParserPort[],
  file: FileMeta,
  sample: Uint8Array
): Promise<{ parser: ParserPort; confidence: number } | null> {
  let best: { parser: ParserPort; confidence: number } | null = null;

  for (const parser of parsers) {
    const confidence = await parser.canParse(file, sample);
    if (confidence > 0 && (best === null || confidence > best.confidence)) {
      best = { parser, confidence };
    }
  }

  return best;
}

/**
 * Decode statement bytes to text.
 *
 * Bank exports are usually UTF-8 but not reliably: Windows-1252 still appears, and it
 * differs from UTF-8 exactly on the bytes that encode the curly apostrophes and
 * accented characters that show up in merchant names. Decoding those as UTF-8 yields
 * U+FFFD, which would then be stripped by `collapseV1` — silently changing a dedupe
 * key. Strict UTF-8 first, fall back on failure.
 */
export function decodeStatementText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

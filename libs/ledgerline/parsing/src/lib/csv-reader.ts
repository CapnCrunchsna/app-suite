/**
 * An RFC 4180 CSV reader, written here rather than pulled from npm.
 *
 * Two reasons. `ledgerline-parsing` is a pure lib under §2.2 and every dependency it
 * takes is a dependency the whole ingest path inherits; and the one thing this reader
 * must do that general-purpose readers do not is preserve the **verbatim source line**
 * for every record, because §2.5 stores it in `raw_row.raw_text` and §6.1 shows it on
 * the review screen when a parse looks wrong. Reconstructing that from parsed cells
 * loses exactly the information the reviewer needs.
 */

export interface CsvRecord {
  /** Field values, unquoted and unescaped. */
  readonly cells: readonly string[];
  /** The record exactly as it appeared in the file, newline excluded. */
  readonly rawText: string;
  /** 1-based physical line where this record starts. */
  readonly lineNumber: number;
}

export const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

/**
 * Scan `text` into records. Handles quoted fields containing the delimiter, embedded
 * newlines, doubled quotes as a literal quote, CRLF/LF/CR line endings, and a leading
 * byte-order mark.
 */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  const records: CsvRecord[] = [];

  let i = 0;
  let line = 1;

  while (i < n) {
    const recordStart = i;
    const recordLine = line;
    const cells: string[] = [];
    let cell = '';
    let inQuotes = false;
    let atRecordEnd = false;

    while (i < n && !atRecordEnd) {
      const ch = src[i];

      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else {
            inQuotes = false;
            i += 1;
          }
        } else {
          if (ch === '\n') line += 1;
          cell += ch;
          i += 1;
        }
        continue;
      }

      if (ch === '"' && cell === '') {
        inQuotes = true;
        i += 1;
      } else if (ch === delimiter) {
        cells.push(cell);
        cell = '';
        i += 1;
      } else if (ch === '\r' || ch === '\n') {
        atRecordEnd = true;
      } else {
        cell += ch;
        i += 1;
      }
    }

    cells.push(cell);
    const rawText = src.slice(recordStart, i);

    if (i < n && src[i] === '\r') i += 1;
    if (i < n && src[i] === '\n') i += 1;
    line += 1;

    records.push({ cells, rawText, lineNumber: recordLine });
  }

  return records;
}

/** A record that is entirely empty — a blank line, or the artefact of a trailing
 *  newline. Dropped before mapping, but the original `lineNumber` survives on the
 *  records that remain so diagnostics still point at the right line of the file. */
export function isBlankRecord(record: CsvRecord): boolean {
  return record.cells.every((c) => c.trim() === '');
}

export interface DelimiterGuess {
  readonly delimiter: Delimiter;
  readonly fieldCount: number;
  readonly confidence: number;
}

/**
 * Guess the delimiter by consistency rather than by frequency.
 *
 * Counting occurrences picks `,` for any file containing dollar amounts with thousands
 * separators inside quoted fields. What actually identifies a delimiter is that it
 * yields the *same* field count on nearly every line, so each candidate is scored by
 * the fraction of non-blank records that agree with its modal field count.
 */
export function guessDelimiter(text: string, sampleLines = 25): DelimiterGuess | null {
  let best: DelimiterGuess | null = null;

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const records = parseCsv(text, delimiter)
      .filter((r) => !isBlankRecord(r))
      .slice(0, sampleLines);
    if (records.length === 0) continue;

    const counts = new Map<number, number>();
    for (const r of records) {
      counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);
    }

    let modalCount = 0;
    let modalFrequency = 0;
    for (const [fieldCount, frequency] of counts) {
      if (frequency > modalFrequency || (frequency === modalFrequency && fieldCount > modalCount)) {
        modalCount = fieldCount;
        modalFrequency = frequency;
      }
    }

    if (modalCount < 2) continue;

    const confidence = modalFrequency / records.length;
    if (
      best === null ||
      confidence > best.confidence ||
      (confidence === best.confidence && modalCount > best.fieldCount)
    ) {
      best = { delimiter, fieldCount: modalCount, confidence };
    }
  }

  return best;
}

/**
 * Find the header row.
 *
 * Bank exports routinely open with a preamble — an account number, an address block, a
 * date range, a blank line — before the real header. A profile can state `skipLines`
 * outright; this is the fallback used when detecting an *unknown* format, where the
 * signature cannot be computed until the header is located.
 *
 * The header is taken to be the first record that has the modal field count and whose
 * cells are predominantly non-numeric — a data row in a statement always carries at
 * least a date and an amount.
 */
export function findHeaderIndex(records: readonly CsvRecord[]): number {
  // Single-cell records are preamble prose: the delimiter never appeared on that line.
  // They are excluded from the mode, because a five-line address block above a
  // three-row statement would otherwise outvote the actual table and "detect" the
  // bank's name as the header.
  const usable = records.filter((r) => !isBlankRecord(r) && r.cells.length >= 2);
  if (usable.length === 0) return -1;

  const counts = new Map<number, number>();
  for (const r of usable) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);

  let modal = 0;
  let modalFrequency = 0;
  for (const [fieldCount, frequency] of counts) {
    // Ties break toward the wider row: a header plus data rows share a width that
    // stray preamble lines only coincidentally match.
    if (frequency > modalFrequency || (frequency === modalFrequency && fieldCount > modal)) {
      modal = fieldCount;
      modalFrequency = frequency;
    }
  }

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (isBlankRecord(r) || r.cells.length !== modal) continue;

    const nonEmpty = r.cells.filter((c) => c.trim() !== '');
    if (nonEmpty.length === 0) continue;

    const numericish = nonEmpty.filter((c) => /^[-+$(]?[\d.,/\\-]+\)?$/.test(c.trim()));
    if (numericish.length / nonEmpty.length < 0.5) return i;
  }

  return -1;
}

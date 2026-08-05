import { describe, expect, it } from 'vitest';

import { findHeaderIndex, guessDelimiter, isBlankRecord, parseCsv } from './csv-reader.js';

describe('parseCsv', () => {
  it('splits simple rows', () => {
    const records = parseCsv('a,b,c\n1,2,3\n', ',');
    expect(records).toHaveLength(2);
    expect(records[0].cells).toEqual(['a', 'b', 'c']);
    expect(records[1].cells).toEqual(['1', '2', '3']);
  });

  it('does not emit a phantom record for a trailing newline', () => {
    expect(parseCsv('a,b\n', ',')).toHaveLength(1);
    expect(parseCsv('a,b', ',')).toHaveLength(1);
  });

  it('keeps a delimiter inside a quoted field', () => {
    const [record] = parseCsv('"TRADER JOES #0198, PORTLAND OR",-87.34\n', ',');
    expect(record.cells).toEqual(['TRADER JOES #0198, PORTLAND OR', '-87.34']);
  });

  it('unescapes doubled quotes', () => {
    const [record] = parseCsv('"SHE SAID ""HI""",1\n', ',');
    expect(record.cells).toEqual(['SHE SAID "HI"', '1']);
  });

  it('keeps a newline inside a quoted field and counts lines correctly after it', () => {
    const records = parseCsv('"line one\nline two",1\nnext,2\n', ',');
    expect(records[0].cells[0]).toBe('line one\nline two');
    expect(records[1].lineNumber).toBe(3);
  });

  it('handles CRLF and a lone CR', () => {
    expect(parseCsv('a,b\r\nc,d\r\n', ',').map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,b\rc,d', ',')).toHaveLength(2);
  });

  it('strips a leading byte-order mark', () => {
    const [record] = parseCsv('﻿Date,Amount\n', ',');
    expect(record.cells[0]).toBe('Date');
  });

  /**
   * §2.5 stores this verbatim in `raw_row.raw_text`, and §6.1 shows it on the review
   * screen when a parse looks wrong. Reconstructing it from the parsed cells would lose
   * exactly the quoting that made the row suspicious.
   */
  it('preserves the source line verbatim, quoting included', () => {
    const source = '01/28/2026,"TRADER JOES #0198, PORTLAND OR",-87.34';
    const [record] = parseCsv(`${source}\n`, ',');
    expect(record.rawText).toBe(source);
  });

  it('reports 1-based line numbers', () => {
    const records = parseCsv('a\nb\nc\n', ',');
    expect(records.map((r) => r.lineNumber)).toEqual([1, 2, 3]);
  });

  it('supports non-comma delimiters', () => {
    expect(parseCsv('a;b;c\n', ';')[0].cells).toEqual(['a', 'b', 'c']);
    expect(parseCsv('a\tb\n', '\t')[0].cells).toEqual(['a', 'b']);
  });
});

describe('isBlankRecord', () => {
  it('recognizes empty and whitespace-only records', () => {
    expect(isBlankRecord(parseCsv('\n', ',')[0])).toBe(true);
    expect(isBlankRecord(parseCsv('  ,  \n', ',')[0])).toBe(true);
    expect(isBlankRecord(parseCsv('a,\n', ',')[0])).toBe(false);
  });
});

describe('guessDelimiter', () => {
  it('picks the delimiter that yields a consistent column count', () => {
    expect(guessDelimiter('a,b,c\n1,2,3\n4,5,6\n')?.delimiter).toBe(',');
    expect(guessDelimiter('a;b;c\n1;2;3\n4;5;6\n')?.delimiter).toBe(';');
    expect(guessDelimiter('a\tb\tc\n1\t2\t3\n')?.delimiter).toBe('\t');
  });

  /**
   * Frequency alone picks the comma for any file with grouped thousands. Consistency
   * is what actually identifies a delimiter.
   */
  it('is not fooled by commas inside quoted amounts', () => {
    const text = 'Date;Description;Amount\n01/09/2026;"PAYROLL, MERIDIAN LLC";"3,200.00"\n01/10/2026;"RENT, JANUARY";"1,500.00"\n';
    expect(guessDelimiter(text)?.delimiter).toBe(';');
  });

  it('returns null when nothing produces columns', () => {
    expect(guessDelimiter('just one long line of prose\nand another\n')).toBeNull();
  });
});

describe('findHeaderIndex', () => {
  it('skips a preamble and finds the header row', () => {
    const text = [
      'Northgate Bank',
      'Account: *****4821',
      'Statement Period: 01/01/2026 - 01/31/2026',
      'Date,Description,Amount,Running Balance,Status',
      '01/03/2026,COFFEE,-18.75,2481.25,Posted',
      '01/05/2026,NETFLIX,-15.49,2465.76,Posted',
    ].join('\n');

    const records = parseCsv(text, ',').filter((r) => !isBlankRecord(r));
    expect(findHeaderIndex(records)).toBe(3);
  });

  it('returns -1 when every candidate row is numeric', () => {
    const records = parseCsv('1,2,3\n4,5,6\n', ',');
    expect(findHeaderIndex(records)).toBe(-1);
  });
});

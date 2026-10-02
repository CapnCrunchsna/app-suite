import type { AccountType } from './fees';

/**
 * A tolerant reader for brokerage "positions" CSV exports.
 *
 * Exports differ per brokerage, but all of them have a symbol column and a
 * current-value column under some name, often below a few preamble lines and
 * above a footer of disclaimers. This finds the header row, reads those columns,
 * and drops every other column on the floor — account numbers included. Nothing
 * this returns can carry one, and nothing is stored but what it returns.
 *
 * Expense ratio and stock share are never in an export; the user fills them in.
 */
export interface ParsedHolding {
  readonly ticker: string;
  readonly description: string;
  readonly value: number;
  readonly accountType: AccountType | null;
}

export interface ParseResult {
  readonly holdings: ParsedHolding[];
  /** Data rows that were not a position (totals, pending activity, footers). */
  readonly skipped: number;
  readonly error: string | null;
}

export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** "$1,234.56" → 1234.56; "(12.00)" → -12; "--" or "" → NaN. */
export function parseMoney(raw: string): number {
  const s = raw.replace(/[$,\s]/g, '');
  if (s === '' || /^-+$/.test(s)) return NaN;
  const negative = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ''));
  return negative ? -n : n;
}

export function guessAccountType(label: string): AccountType | null {
  const s = label.toLowerCase();
  if (/roth/.test(s)) return 'roth';
  if (/401\s*\(?k|403\s*\(?b|457/.test(s)) return '401k';
  if (/\bira\b|rollover|traditional|sep\b|simple/.test(s)) return 'ira';
  if (/individual|joint|brokerage|taxable|trust/.test(s)) return 'taxable';
  return null;
}

const SYMBOL = ['symbol', 'ticker', 'symbol/cusip'];
const VALUE = ['current value', 'market value', 'value', 'mkt val (market value)', 'marketvalue', 'mkt val'];
const DESCRIPTION = ['description', 'name', 'security', 'security description', 'investment name'];

function columnOf(header: string[], names: string[]): number {
  return header.findIndex((h) => names.includes(h));
}

/** An account *name* column, never an account *number* one. */
function accountColumn(header: string[]): number {
  return header.findIndex((h) => /account/.test(h) && !/number|no\.?$|#|id$/.test(h));
}

const TICKER = /^[A-Z0-9][A-Z0-9.\-/]{0,9}$/;

export function parseHoldingsCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const headerIndex = lines.findIndex((l) => {
    const cells = splitCsvLine(l).map((c) => c.toLowerCase());
    return columnOf(cells, SYMBOL) >= 0 && columnOf(cells, VALUE) >= 0;
  });
  if (headerIndex < 0) {
    return {
      holdings: [],
      skipped: 0,
      error: 'No header row with both a symbol column and a current/market value column was found.',
    };
  }

  const header = splitCsvLine(lines[headerIndex]).map((c) => c.toLowerCase());
  const sym = columnOf(header, SYMBOL);
  const val = columnOf(header, VALUE);
  const desc = columnOf(header, DESCRIPTION);
  const acct = accountColumn(header);

  const holdings: ParsedHolding[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitCsvLine(line);
    // Brokerages mark money-market sweep positions with asterisks (SPAXX**).
    const ticker = (cells[sym] ?? '').replace(/\*+$/, '').toUpperCase();
    const value = parseMoney(cells[val] ?? '');
    if (!TICKER.test(ticker) || !Number.isFinite(value) || value <= 0) {
      skipped++;
      continue;
    }
    holdings.push({
      ticker,
      description: desc >= 0 ? (cells[desc] ?? '') : '',
      value,
      accountType: acct >= 0 ? guessAccountType(cells[acct] ?? '') : null,
    });
  }
  return { holdings, skipped, error: null };
}

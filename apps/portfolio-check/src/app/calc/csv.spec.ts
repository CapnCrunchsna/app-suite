import { guessAccountType, parseHoldingsCsv, parseMoney, splitCsvLine } from './csv';

describe('csv helpers', () => {
  it('splits quoted cells with commas and escaped quotes', () => {
    expect(splitCsvLine('a,"b, c","say ""hi""",')).toEqual(['a', 'b, c', 'say "hi"', '']);
  });

  it('reads money the way statements print it', () => {
    expect(parseMoney('$1,234.56')).toBeCloseTo(1234.56);
    expect(parseMoney('(12.00)')).toBe(-12);
    expect(Number.isNaN(parseMoney('--'))).toBe(true);
  });

  it('guesses account types from account names', () => {
    expect(guessAccountType('ROTH IRA')).toBe('roth');
    expect(guessAccountType('Rollover IRA')).toBe('ira');
    expect(guessAccountType('Company 401(k)')).toBe('401k');
    expect(guessAccountType('Individual - TOD')).toBe('taxable');
    expect(guessAccountType('X12345678')).toBeNull();
  });
});

describe('parseHoldingsCsv', () => {
  // Shaped like a typical positions export: preamble, header, rows, totals, footer.
  const csv = [
    'Positions as of 09/30/2026',
    '',
    'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value',
    'X11111111,Individual,GRWA,"Sample Growth Fund, Class A",100,$50.00,"$5,000.00"',
    'X11111111,Individual,CASHX**,Money market,1,$1.00,$250.00',
    '222222222,ROTH IRA,LGCP,Large Cap,10,$100.00,"$1,000.00"',
    '222222222,ROTH IRA,Pending Activity,,,,$40.00',
    ',,,,,Total,"$6,290.00"',
    '"Data and information provided is for informational purposes only."',
  ].join('\r\n');

  it('keeps positions and drops totals, pending rows and footers', () => {
    const result = parseHoldingsCsv(csv);
    expect(result.error).toBeNull();
    expect(result.holdings.map((h) => h.ticker)).toEqual(['GRWA', 'CASHX', 'LGCP']);
    expect(result.holdings[0]).toEqual({
      ticker: 'GRWA',
      description: 'Sample Growth Fund, Class A',
      value: 5_000,
      accountType: 'taxable',
    });
    expect(result.holdings[2].accountType).toBe('roth');
    expect(result.skipped).toBe(3);
  });

  it('never carries the account number anywhere in its output', () => {
    const text = JSON.stringify(parseHoldingsCsv(csv));
    expect(text).not.toContain('X11111111');
    expect(text).not.toContain('222222222');
  });

  it('explains when it cannot find the columns', () => {
    expect(parseHoldingsCsv('foo,bar\n1,2').error).toMatch(/symbol/);
  });
});

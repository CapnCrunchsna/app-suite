import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectCsvFormat } from './detect.js';
import type { FormatProfile } from './format-profile.js';
import { validateProfile } from './format-profile.js';
import { parseCsvWithProfile, ProfileApplicationError } from './node-csv-parser.js';
import { loadProfile } from './profile-io.js';

const root = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

const readFixture = (name: string): string =>
  readFileSync(root(`fixtures/statements/${name}`), 'utf8');

const readProfile = (name: string): FormatProfile => {
  const result = loadProfile(JSON.parse(readFileSync(root(`profiles/${name}`), 'utf8')));
  if (!result.ok) throw new Error(`profile ${name} is invalid: ${result.errors.join('; ')}`);
  return result.profile;
};

const NORTHGATE = readProfile('northgate-checking.json');
const CARDINAL = readProfile('cardinal-card.json');
const HARBOR = readProfile('harbor-savings.json');

const CHECKING_CSV = readFixture('northgate-checking-2026-01.csv');
const CARD_CSV = readFixture('cardinal-card-2026-01.csv');
const SAVINGS_CSV = readFixture('harbor-savings-2026-01.csv');

describe('northgate checking — single signed amount column, preamble, status column', () => {
  const result = parseCsvWithProfile({ text: CHECKING_CSV, profile: NORTHGATE });

  it('skips the preamble and parses every data row', () => {
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(12);
  });

  it('produces ISO dates and an effective date', () => {
    expect(result.rows[0].transactionDate).toBe('2026-01-03');
    expect(result.rows[0].effectiveDate).toBe('2026-01-03');
    expect(result.periodStart).toBe('2026-01-03');
    expect(result.periodEnd).toBe('2026-01-30');
  });

  it('keeps outflows negative and inflows positive', () => {
    expect(result.rows[0].amountCents).toBe(-1875);
    expect(result.rows[3].amountCents).toBe(320000); // "3,200.00" payroll deposit
  });

  it('reads a quoted description containing a comma', () => {
    const traderJoes = result.rows.find((r) => r.descriptionRaw.startsWith('TRADER JOES'));
    expect(traderJoes?.descriptionRaw).toBe('TRADER JOES #0198, PORTLAND OR');
    expect(traderJoes?.amountCents).toBe(-8734);
  });

  it('flags the pending row and no other', () => {
    const pending = result.rows.filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].descriptionRaw).toContain('UBER TRIP');
  });

  /** The strongest parse-time validation there is (§6.1): a file that reconciles has
   *  proved the amount column and the sign convention are both right. */
  it('reconciles the running balance', () => {
    expect(result.balanceCheck).toMatchObject({ kind: 'reconciled', order: 'ascending' });
  });

  it('preserves the verbatim source line on every row', () => {
    expect(result.rows[0].rawText).toContain('POS DEBIT SQ *BLUE BOTTLE COFFE');
    expect(result.rows[0].lineNumber).toBe(6); // 3 preamble lines, a blank, then the header
  });

  it('records the parser and profile that produced it', () => {
    expect(result.parser).toBe('node-csv');
    expect(result.profileId).toBe('northgate-checking-v1');
  });
});

describe('cardinal card — the bank prints charges positive, so the profile inverts', () => {
  const result = parseCsvWithProfile({ text: CARD_CSV, profile: CARDINAL });

  it('parses every row', () => {
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(8);
  });

  /**
   * §3.1: negative means money leaving the account "applied uniformly across checking
   * and credit cards, with the per-profile mapping absorbing each bank's disagreement
   * about this". The file says `15.49` for a purchase; the house says `-1549`.
   */
  it('turns a positively-printed purchase into a negative amount', () => {
    const netflix = result.rows.find((r) => r.descriptionRaw.startsWith('NETFLIX'));
    expect(netflix?.amountCents).toBe(-1549);
  });

  it('turns a negatively-printed payment into a positive amount', () => {
    const payment = result.rows.find((r) => r.descriptionRaw.startsWith('PAYMENT THANK YOU'));
    expect(payment?.amountCents).toBe(50000);
  });

  it('prefers the transaction date over the post date', () => {
    expect(result.rows[0].transactionDate).toBe('2026-01-02');
    expect(result.rows[0].postedDate).toBe('2026-01-03');
    expect(result.rows[0].effectiveDate).toBe('2026-01-02');
  });

  /** §5.6's card-validation authorization. Stored, but surfaced — §3.2 allows $0 only
   *  here, and a mismapped column is the far more common cause. */
  it('keeps a $0.00 authorization and warns about it', () => {
    const trial = result.rows.find((r) => r.descriptionRaw.includes('TRIAL PERIOD'));
    expect(trial?.amountCents).toBe(0);
    expect(result.warnings.some((w) => w.kind === 'zero_amount')).toBe(true);
  });

  it('says why it could not reconcile balances', () => {
    expect(result.balanceCheck.kind).toBe('unavailable');
    expect(result.warnings.some((w) => w.kind === 'balance_unavailable')).toBe(true);
  });
});

describe('harbor savings — separate debit and credit columns', () => {
  const result = parseCsvWithProfile({ text: SAVINGS_CSV, profile: HARBOR });

  it('parses every row', () => {
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(5);
  });

  it('reads a quoted "MMM D, YYYY" date', () => {
    expect(result.rows[0].postedDate).toBe('2026-01-03');
  });

  /** This file has no transaction-date column, so §7.1's COALESCE falls through. */
  it('falls back to the posted date for the effective date', () => {
    expect(result.rows[0].transactionDate).toBeNull();
    expect(result.rows[0].effectiveDate).toBe('2026-01-03');
  });

  it('makes debits negative and credits positive', () => {
    expect(result.rows[0].amountCents).toBe(-1200); // maintenance fee
    expect(result.rows[1].amountCents).toBe(45000); // mobile deposit
    expect(result.rows[3].amountCents).toBe(342); // interest earned
  });

  it('reconciles the running balance', () => {
    expect(result.balanceCheck).toMatchObject({ kind: 'reconciled' });
  });
});

/**
 * The property the whole profile layer exists to produce, checked across two banks that
 * disagree in the file and agree after parsing.
 *
 * §2.6 pairs a debit in one account against a credit in another. That only works if
 * both sides landed in one convention — which is exactly what would silently break if a
 * profile's `signConvention` were wrong, and what nothing downstream could detect.
 */
describe('sign convention holds across account types', () => {
  it('pairs the checking debit with the credit-card payment, equal and opposite', () => {
    const checking = parseCsvWithProfile({ text: CHECKING_CSV, profile: NORTHGATE });
    const card = parseCsvWithProfile({ text: CARD_CSV, profile: CARDINAL });

    const debit = checking.rows.find((r) => r.descriptionRaw.includes('ONLINE PMT CARDINAL CARD'));
    const credit = card.rows.find((r) => r.descriptionRaw.startsWith('PAYMENT THANK YOU'));

    expect(debit).toBeDefined();
    expect(credit).toBeDefined();
    expect(debit?.amountCents).toBe(-50000);
    expect(credit?.amountCents).toBe(50000);
    expect((debit?.amountCents ?? NaN) + (credit?.amountCents ?? NaN)).toBe(0);
  });

  it('never puts a float in the money path', () => {
    for (const { text, profile } of [
      { text: CHECKING_CSV, profile: NORTHGATE },
      { text: CARD_CSV, profile: CARDINAL },
      { text: SAVINGS_CSV, profile: HARBOR },
    ]) {
      for (const row of parseCsvWithProfile({ text, profile }).rows) {
        expect(Number.isInteger(row.amountCents)).toBe(true);
        if (row.balanceCents !== null) expect(Number.isInteger(row.balanceCents)).toBe(true);
      }
    }
  });
});

describe('format detection', () => {
  const profiles = [NORTHGATE, CARDINAL, HARBOR];

  it('matches each fixture to its own profile on the header signature', () => {
    for (const [text, expected] of [
      [CHECKING_CSV, 'northgate-checking-v1'],
      [CARD_CSV, 'cardinal-card-v1'],
      [SAVINGS_CSV, 'harbor-savings-v1'],
    ] as const) {
      const detection = detectCsvFormat(text, profiles);
      expect(detection.kind).toBe('matched');
      if (detection.kind === 'matched') expect(detection.profile.id).toBe(expected);
    }
  });

  it('locates the header past a preamble and reports it as skipLines', () => {
    const detection = detectCsvFormat(CHECKING_CSV, []);
    expect(detection.kind).toBe('needs_mapping');
    if (detection.kind === 'needs_mapping') {
      expect(detection.skipLines).toBe(3);
      expect(detection.headerLineNumber).toBe(5);
    }
  });

  /** Plan question 2: a changed header should cost one confirmation click, not a full
   *  remapping — and must never silently apply. */
  it('suggests rather than applies when a bank changes one column name', () => {
    const changed = CHECKING_CSV.replace(
      'Date,Description,Amount,Running Balance,Status',
      'Date,Description,Amount,Balance,Status'
    );

    const detection = detectCsvFormat(changed, profiles);
    expect(detection.kind).toBe('needs_mapping');
    if (detection.kind === 'needs_mapping') {
      expect(detection.suggestions[0]?.profile.id).toBe('northgate-checking-v1');
      expect(detection.suggestions[0]?.similarity).toBeGreaterThan(0.5);
    }
  });
});

describe('profile validation', () => {
  it('rejects a profile with no amount column', () => {
    const broken = { ...NORTHGATE, columnMap: { ...NORTHGATE.columnMap, amount: undefined } };
    expect(validateProfile(broken).ok).toBe(false);
  });

  it('rejects a profile with no date column', () => {
    const broken = {
      ...NORTHGATE,
      columnMap: { description: NORTHGATE.columnMap.description, amount: NORTHGATE.columnMap.amount },
    };
    expect(validateProfile(broken).errors.join(' ')).toContain('transactionDate');
  });

  it('rejects mixing a single amount column with debit/credit columns', () => {
    const broken = {
      ...NORTHGATE,
      amountMode: 'debit_credit' as const,
    };
    expect(validateProfile(broken).ok).toBe(false);
  });

  it('rejects an unusable date format', () => {
    expect(validateProfile({ ...NORTHGATE, dateFormat: 'MM/YYYY' }).ok).toBe(false);
  });

  it('warns, but does not fail, when no balance column is mapped', () => {
    const noBalance = { ...NORTHGATE, columnMap: { ...NORTHGATE.columnMap, balance: undefined } };
    const validation = validateProfile(noBalance);
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join(' ')).toContain('balance');
  });

  it('throws with the available columns when a mapped column is missing', () => {
    const wrong = {
      ...NORTHGATE,
      columnMap: { ...NORTHGATE.columnMap, amount: { by: 'header' as const, name: 'Nope' } },
    };
    expect(() => parseCsvWithProfile({ text: CHECKING_CSV, profile: wrong })).toThrow(
      ProfileApplicationError
    );
    expect(() => parseCsvWithProfile({ text: CHECKING_CSV, profile: wrong })).toThrow(/Nope/);
  });
});

describe('profile-io', () => {
  it('accepts the shorthand column forms a hand-written profile uses', () => {
    const result = loadProfile({
      id: 'p',
      institution: 'Test',
      dateFormat: 'MM/DD/YYYY',
      amountMode: 'single',
      columnMap: { transactionDate: 'Date', description: 'Desc', amount: 2 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.columnMap.transactionDate).toEqual({ by: 'header', name: 'Date' });
      expect(result.profile.columnMap.amount).toEqual({ by: 'index', index: 2 });
    }
  });

  it('reports every problem at once rather than the first', () => {
    const result = loadProfile({ id: 'p', amountMode: 'nonsense', columnMap: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(1);
  });

  it('rejects a non-object', () => {
    expect(loadProfile('nope').ok).toBe(false);
    expect(loadProfile(null).ok).toBe(false);
  });
});

describe('row-level failures', () => {
  it('keeps a bad row as an error instead of dropping it', () => {
    const broken = CHECKING_CSV.replace('-18.75,2481.25,Posted', 'N/A,2481.25,Posted');
    const result = parseCsvWithProfile({ text: broken, profile: NORTHGATE });

    expect(result.rows).toHaveLength(11);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errors.join(' ')).toContain('amount');
    expect(result.errors[0].rawText).toContain('BLUE BOTTLE');
    expect(result.warnings.some((w) => w.kind === 'unparsed_row')).toBe(true);
  });

  it('flags in-file duplicates as a warning, never a removal', () => {
    const doubled = `${CHECKING_CSV}01/03/2026,POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA,-18.75,,Posted\n`;
    const result = parseCsvWithProfile({ text: doubled, profile: NORTHGATE });

    expect(result.rows).toHaveLength(13);
    expect(result.warnings.some((w) => w.kind === 'duplicate_in_file')).toBe(true);
  });

  it('reports the true failure count, not the length of the capped listing', () => {
    // 15 rows whose balance never moves while every amount claims it did, so all 14
    // consecutive pairs fail and the listing cap of 10 is exceeded.
    const rows = Array.from(
      { length: 15 },
      (_, i) => `01/${String(i + 1).padStart(2, '0')}/2026,SOME MERCHANT,-1.00,100.00,Posted`
    );
    const text = `Northgate Bank\nAccount: x\nStatement Period: x\n\nDate,Description,Amount,Running Balance,Status\n${rows.join('\n')}\n`;

    const result = parseCsvWithProfile({ text, profile: NORTHGATE });
    expect(result.balanceCheck.kind).toBe('mismatch');
    if (result.balanceCheck.kind === 'mismatch') {
      expect(result.balanceCheck.rowsChecked).toBe(14);
      expect(result.balanceCheck.failureCount).toBe(14);
      expect(result.balanceCheck.failures).toHaveLength(10);
    }
    expect(
      result.warnings.find((w) => w.kind === 'balance_mismatch')?.message
    ).toContain('14 of 14');
  });

  /**
   * The blind spot, pinned so nobody re-derives the claim I originally made.
   *
   * `signConvention: 'invert'` flips the balance alongside the amount — it has to, or a
   * credit-card export would never reconcile — so both sides move together and the
   * identity still holds. A profile with the convention backwards reconciles perfectly
   * while every number in the app is inverted.
   */
  it('still reconciles when the sign convention is backwards', () => {
    const inverted = { ...NORTHGATE, signConvention: 'invert' as const };
    const result = parseCsvWithProfile({ text: CHECKING_CSV, profile: inverted });

    expect(result.balanceCheck.kind).toBe('reconciled');
    expect(result.rows[0].amountCents).toBe(1875); // wrong sign, and reconciliation cannot tell
  });

  /** So this is the check that can. */
  it('flags an inverted deposit account through implausible balances', () => {
    const inverted = { ...NORTHGATE, signConvention: 'invert' as const };
    const result = parseCsvWithProfile({ text: CHECKING_CSV, profile: inverted });

    const warning = result.warnings.find((w) => w.kind === 'sign_convention_suspect');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('not overdrawn');
  });

  it('does not flag a correctly-oriented deposit account', () => {
    const result = parseCsvWithProfile({ text: CHECKING_CSV, profile: NORTHGATE });
    expect(result.warnings.some((w) => w.kind === 'sign_convention_suspect')).toBe(false);
  });

  /** A card's balance sign is not fixed by the spec, so there is nothing to check. */
  it('never guesses at a credit card’s balance orientation', () => {
    const result = parseCsvWithProfile({
      text: CARD_CSV,
      profile: { ...CARDINAL, signConvention: 'as_is' as const },
    });
    expect(result.warnings.some((w) => w.kind === 'sign_convention_suspect')).toBe(false);
  });

  it('warns when the header no longer matches the profile signature', () => {
    const changed = CHECKING_CSV.replace('Running Balance', 'Balance');
    const result = parseCsvWithProfile({
      text: changed,
      profile: { ...NORTHGATE, columnMap: { ...NORTHGATE.columnMap, balance: { by: 'header', name: 'Balance' } } },
    });
    expect(result.warnings.some((w) => w.kind === 'signature_mismatch')).toBe(true);
  });
});

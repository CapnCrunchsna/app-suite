import { describe, expect, it } from 'vitest';

import { COLLAPSE_MAX_LENGTH, COLLAPSE_VERSION, collapseV1 } from './collapse.js';
import { DEDUPE_KEY_VERSION, dedupeKey } from './dedupe.js';

/**
 * `collapse_v1` is frozen (§3.3). These are **golden values**, not examples.
 *
 * If a change to this file breaks them, the change is wrong — not the test. Editing the
 * collapse in place silently re-keys every stored row, and the next overlapping import
 * re-inserts rows it should have merged, doubling a month of spend with no error
 * anywhere. The supported path is a `collapseV2` beside `collapseV1` plus a migration
 * that recomputes every key in one transaction.
 */
describe('collapseV1 (frozen)', () => {
  it('applies §3.3 in order: uppercase, fold, substitute, collapse, trim, truncate 40', () => {
    expect(collapseV1('sq *blue bottle coffe')).toBe('SQ BLUE BOTTLE COFFE');
    expect(collapseV1('  TST*  THE  PLANT  CAFE  #0042  ')).toBe('TST THE PLANT CAFE 0042');
    expect(collapseV1('PAYPAL *SPOTIFYUSA 4029357733')).toBe('PAYPAL SPOTIFYUSA 4029357733');
  });

  it('truncates to 40 characters and never ends on a space', () => {
    expect(collapseV1('A'.repeat(60))).toHaveLength(COLLAPSE_MAX_LENGTH);
    expect(collapseV1(`${'B'.repeat(39)} TAIL`)).toBe('B'.repeat(39));
    expect(collapseV1('C'.repeat(41))).toBe('C'.repeat(40));
  });

  it('folds tabs and newlines into single spaces', () => {
    expect(collapseV1('A\t\tB\nC')).toBe('A B C');
  });

  /**
   * Punctuation in a descriptor is a separator, so it becomes a space rather than
   * disappearing. Deleting it would glue tokens together — `TST*THE PLANT CAFE` has no
   * space after the processor prefix, and delete-semantics produced `TSTTHE`.
   */
  it('substitutes punctuation rather than deleting it', () => {
    expect(collapseV1('TST*THE PLANT CAFE')).toBe('TST THE PLANT CAFE');
    expect(collapseV1('AMAZON.COM')).toBe('AMAZON COM');
    expect(collapseV1('7-ELEVEN')).toBe('7 ELEVEN');
    expect(collapseV1('AMAZON - PRIME')).toBe('AMAZON PRIME');
  });

  /**
   * The payoff, and the reason this was worth changing before the first import: banks
   * are not consistent about punctuation between exports, and under delete-semantics
   * these three produced two different keys. The merge rule would then re-insert a row
   * it should have absorbed.
   */
  it('collapses punctuation variants of one descriptor to one string', () => {
    const variants = ['AMAZON - PRIME', 'AMAZON PRIME', 'AMAZON  -  PRIME', 'AMAZON.PRIME'];
    const collapsed = new Set(variants.map(collapseV1));
    expect(collapsed).toEqual(new Set(['AMAZON PRIME']));
  });

  /**
   * `parser-port.ts` falls back to Windows-1252 for files that are not valid UTF-8, so
   * an accented merchant name reaches this function intact. Deleting the accent alone
   * would split the word.
   */
  it('folds diacritics to their base letter', () => {
    expect(collapseV1('MÜLLER CAFÉ')).toBe('MULLER CAFE');
    expect(collapseV1('CAFÉ')).toBe(collapseV1('CAFE'));
  });

  it('is idempotent and deterministic', () => {
    const input = 'SQ *BLUE BOTTLE COFFE 415-555-0111 CA';
    const once = collapseV1(input);
    expect(collapseV1(once)).toBe(once);
    for (let i = 0; i < 50; i++) expect(collapseV1(input)).toBe(once);
  });

  it('names its version, which is what `dedupe_key_version` records', () => {
    expect(COLLAPSE_VERSION).toBe('collapse_v1');
    expect(DEDUPE_KEY_VERSION).toBe('collapse_v1');
  });
});

describe('dedupeKey', () => {
  const base = {
    accountId: 'acct-1',
    effectiveDate: '2026-01-03',
    amountCents: -1875,
    descriptionRaw: 'POS DEBIT SQ *BLUE BOTTLE COFFE 415-555-0111 CA',
  };

  it('is stable for identical input', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });

  it('changes when any component changes', () => {
    const original = dedupeKey(base);
    expect(dedupeKey({ ...base, accountId: 'acct-2' })).not.toBe(original);
    expect(dedupeKey({ ...base, effectiveDate: '2026-01-04' })).not.toBe(original);
    expect(dedupeKey({ ...base, amountCents: -1876 })).not.toBe(original);
    expect(dedupeKey({ ...base, descriptionRaw: 'SOMETHING ELSE' })).not.toBe(original);
  });

  /**
   * §3.3: convergence "holds because the key is date-scoped: two months of the same
   * $9.99 charge are two different keys, so a year-to-date export over twelve monthly
   * statements merges to zero inserts."
   */
  it('separates the same charge in different months', () => {
    const january = dedupeKey({ ...base, effectiveDate: '2026-01-15', amountCents: -999 });
    const february = dedupeKey({ ...base, effectiveDate: '2026-02-15', amountCents: -999 });
    expect(january).not.toBe(february);
  });

  it('ignores descriptor noise that collapse_v1 removes', () => {
    const a = dedupeKey({ ...base, descriptionRaw: 'TST* THE PLANT CAFE' });
    const b = dedupeKey({ ...base, descriptionRaw: 'tst*   the   plant   cafe' });
    expect(a).toBe(b);
  });

  /** The concrete reason the collapse substitutes: one transaction re-exported with
   *  different punctuation merges instead of double-counting. */
  it('gives punctuation variants of one charge the same key', () => {
    const keys = ['AMAZON - PRIME', 'AMAZON PRIME', 'AMAZON.PRIME'].map((descriptionRaw) =>
      dedupeKey({ ...base, descriptionRaw })
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('is a sha256 hex digest', () => {
    expect(dedupeKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

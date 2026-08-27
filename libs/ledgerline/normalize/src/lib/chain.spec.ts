import { collapseV1 } from '@metrum/ledgerline-domain';
import { describe, expect, it } from 'vitest';

import type { MerchantAlias } from './alias.js';
import { resolveAlias, trigramSimilarity } from './alias.js';
import { normalizeBatch, normalizeDescriptor } from './chain.js';
import { isP2PDescriptor } from './p2p.js';
import { SEED_ALIASES, SEED_MERCHANT_KEYS } from './seed-aliases.js';
import {
  stageGeoAndContact,
  stageProcessorPrefixes,
  stageReferenceDebris,
  stageStoreNumbers,
} from './stages.js';
import { PROCESSOR_PREFIXES } from './tables.js';

const clean = (raw: string): string => normalizeDescriptor(raw, { trace: false }).descriptionNormalized;

describe('the deterministic chain, on §4’s own examples', () => {
  it('unwraps the three hostile descriptors the spec opens with', () => {
    expect(clean('SQ *BLUE BOTTLE COFFE 415-555-0111 CA')).toBe('BLUE BOTTLE COFFE');
    expect(clean('TST* THE PLANT CAFE #0042')).toBe('THE PLANT CAFE');
    expect(clean('PAYPAL *SPOTIFYUSA 4029357733')).toBe('SPOTIFYUSA');
  });
});

describe('stage 2 — processor prefixes', () => {
  it('keeps the merchant hidden behind the processor, not the processor', () => {
    expect(stageProcessorPrefixes('SQ *BLUE BOTTLE')).toBe('BLUE BOTTLE');
    expect(stageProcessorPrefixes('TST*THE PLANT CAFE')).toBe('THE PLANT CAFE');
    expect(stageProcessorPrefixes('POS DEBIT TARGET')).toBe('TARGET');
  });

  it('unwraps nested prefixes', () => {
    expect(stageProcessorPrefixes('POS DEBIT SQ *BLUE BOTTLE')).toBe('BLUE BOTTLE');
  });

  it('never strips a descriptor down to nothing', () => {
    expect(stageProcessorPrefixes('PAYPAL *')).toBe('PAYPAL *');
  });

  /**
   * From the first real statement (§9n). The bank printed one merchant both ways
   * across eight months — `ICP*` on the earlier charges and bare on the later ones
   * — so one subscription resolved to two merchants and §5.2 could only ever see
   * part of it.
   *
   * The failure is quiet by construction: with the prefix unknown, stage 6's tidy
   * turns the `*` into a space and `ICP` becomes the first word of the merchant's
   * name. The output is clean, stable and wrong, which is why this needs a test
   * rather than a glance.
   */
  it('strips ICP*, so a merchant printed both ways resolves once', () => {
    expect(stageProcessorPrefixes('ICP*GOLDFISH SWIM SCHOOL')).toBe('GOLDFISH SWIM SCHOOL');
    expect(clean('ICP*Goldfish Swim School')).toBe(clean('Goldfish Swim School'));
  });

  it('leaves a merchant genuinely called ICP alone', () => {
    // The table holds `ICP*`, not `ICP` — §4.1's whole reason for keeping
    // punctuation until after stage 5.
    expect(stageProcessorPrefixes('ICP CONSULTING')).toBe('ICP CONSULTING');
  });
});

/**
 * §9o. Stage 2 is the only consumer of the asterisk; after it, an asterisk left in
 * place is glue that defeats every anchored rule downstream, because stages 3–5 are
 * written around whitespace boundaries.
 *
 * The reason this went unnoticed is that the output looks fine. Stage 6's tidy turns
 * the asterisk into a space at the very end, so the descriptor comes out spaced and
 * readable with the debris still in it — and one merchant quietly becomes a hundred.
 */
describe('punctuation as glue (§9o)', () => {
  it('strips a reference welded on with an asterisk, not just one after a space', () => {
    expect(clean('AMAZON MKTPL*5O6QH4PH1')).toBe('AMAZON MKTPL');
    expect(clean('AMAZON MKTPL 5O6QH4PH1')).toBe('AMAZON MKTPL');
  });

  it('collapses one merchant’s order references to one key', () => {
    const keys = new Set(
      ['AMAZON MKTPL*5O6QH4PH1', 'AMAZON MKTPL*5A03Q41F2', 'AMAZON MKTPL*BD5VT45C0'].map(clean),
    );

    expect([...keys]).toEqual(['AMAZON MKTPL']);
  });

  it('still lets stage 2 match on the punctuation it is identified by', () => {
    // The un-gluing happens at stage 3, after the prefix table has had its look —
    // so these keep working exactly as §4 documents them.
    expect(clean('SQ *BLUE BOTTLE COFFE 415-555-0111 CA')).toBe('BLUE BOTTLE COFFE');
    expect(clean('TST* THE PLANT CAFE #0042')).toBe('THE PLANT CAFE');
    expect(clean('PAYPAL *SPOTIFYUSA 4029357733')).toBe('SPOTIFYUSA');
  });

  it('leaves a merchant name that merely contains an asterisk readable', () => {
    // The asterisk becomes a separator rather than vanishing, so nothing is glued
    // together that the bank had kept apart.
    expect(clean('STAR*MART')).toBe('STAR MART');
  });
});

describe('stage 3 — store and terminal numbers', () => {
  it('removes store numbers and long reference runs', () => {
    expect(stageStoreNumbers('THE PLANT CAFE #0042')).toBe('THE PLANT CAFE');
    expect(stageStoreNumbers('STARBUCKS STORE 1234 SEATTLE')).toBe('STARBUCKS SEATTLE');
    expect(stageStoreNumbers('SHELL OIL 57442100 PORTLAND')).toBe('SHELL OIL PORTLAND');
  });

  it('leaves short leading digits that are part of the name', () => {
    expect(stageStoreNumbers('76 GAS')).toBe('76 GAS');
    expect(stageStoreNumbers('7-ELEVEN')).toBe('7-ELEVEN');
  });
});

describe('stage 4 — geographic and contact noise', () => {
  it('strips a phone number and a trailing state code', () => {
    expect(stageGeoAndContact('BLUE BOTTLE COFFE 415-555-0111 CA')).toBe('BLUE BOTTLE COFFE');
  });

  /**
   * A web address is noise *around* the merchant name, not instead of it. Deleting the
   * whole token leaves `CA`, which resolves to a merchant named after a US state — a
   * bug this test exists to keep fixed.
   */
  it('keeps the host label and drops the TLD', () => {
    expect(stageGeoAndContact('NETFLIX.COM 866-579-7172 CA')).toBe('NETFLIX');
    expect(stageGeoAndContact('AMZN.COM/BILL WA')).toBe('AMZN');
    expect(stageGeoAndContact('WWW.ADOBE.COM')).toBe('ADOBE');
  });

  it('never strips the only remaining token', () => {
    expect(stageGeoAndContact('CA')).toBe('CA');
  });
});

describe('stage 5 — reference and date debris', () => {
  it('removes reference numbers', () => {
    expect(stageReferenceDebris('ZELLE TO JORDAN P REF#883021')).toBe('ZELLE TO JORDAN P');
    expect(stageReferenceDebris('PAYMENT XXXX9012')).toBe('PAYMENT');
  });

  /**
   * `TRAN` matches inside `TRANSFER` without a closing word boundary, and the greedy
   * tail then eats the rest of the word — `TRANSFER TO CHECKING` became `TO CHECKING`.
   */
  it('does not eat a word that merely starts with a reference keyword', () => {
    expect(stageReferenceDebris('TRANSFER TO CHECKING')).toBe('TRANSFER TO CHECKING');
    expect(stageReferenceDebris('AUTHENTIC PIZZA')).toBe('AUTHENTIC PIZZA');
    expect(stageReferenceDebris('IDAHO POTATO CO')).toBe('IDAHO POTATO CO');
  });

  it('removes an embedded MM/DD', () => {
    expect(stageReferenceDebris('COMCAST 12/25 PAYMENT')).toBe('COMCAST PAYMENT');
  });
});

describe('stage 6 — alias resolution and §4.3 precedence', () => {
  const alias = (over: Partial<MerchantAlias>): MerchantAlias => ({
    aliasKey: 'NETFLIX',
    merchantId: 'netflix',
    matchType: 'exact',
    confidence: 1,
    source: 'seed',
    ...over,
  });

  it('resolves an exact alias', () => {
    const match = resolveAlias('NETFLIX', [alias({})]);
    expect(match?.alias.merchantId).toBe('netflix');
    expect(match?.matchType).toBe('exact');
  });

  it('resolves a prefix alias', () => {
    const match = resolveAlias('NETFLIX COM BILLING', [alias({ matchType: 'prefix' })]);
    expect(match?.matchType).toBe('prefix');
  });

  /**
   * §4.3: "A user correction is permanent and beats everything, including a later
   * re-run with a better model." Source outranks match type — resolving exact-first and
   * short-circuiting would silently discard the correction.
   */
  it('lets a user prefix alias beat a seed exact alias', () => {
    const match = resolveAlias('NETFLIX', [
      alias({ merchantId: 'seed-netflix', matchType: 'exact', source: 'seed' }),
      alias({ merchantId: 'user-netflix', matchType: 'prefix', source: 'user' }),
    ]);
    expect(match?.alias.merchantId).toBe('user-netflix');
  });

  it('orders sources user > seed > rule > llm', () => {
    const match = resolveAlias('NETFLIX', [
      alias({ merchantId: 'from-llm', source: 'llm' }),
      alias({ merchantId: 'from-rule', source: 'rule' }),
      alias({ merchantId: 'from-seed', source: 'seed' }),
    ]);
    expect(match?.alias.merchantId).toBe('from-seed');
  });

  it('prefers the more specific of two prefix aliases', () => {
    const match = resolveAlias('UBER EATS ORDER', [
      alias({ aliasKey: 'UBER', merchantId: 'uber', matchType: 'prefix' }),
      alias({ aliasKey: 'UBER EATS', merchantId: 'uber-eats', matchType: 'prefix' }),
    ]);
    expect(match?.alias.merchantId).toBe('uber-eats');
  });

  /**
   * Fuzzy matching exists for the way statement descriptors actually vary — truncated
   * and decorated, `BLUE BOTTLE COFFE` for `BLUE BOTTLE COFFEE` — not for typos. On
   * short strings a single wrong character costs a lot of trigrams (`STARBUKS` against
   * `STARBUCKS` scores 0.58), and it stays below the floor on purpose: a wrong merge is
   * invisible in the findings, a missed one is one click in the review queue.
   */
  it('matches a truncated descriptor above the floor', () => {
    const fuzzy = [alias({ aliasKey: 'BLUE BOTTLE COFFEE', merchantId: 'blue-bottle', matchType: 'fuzzy' })];
    expect(resolveAlias('BLUE BOTTLE COFFE', fuzzy)?.alias.merchantId).toBe('blue-bottle');
  });

  it('refuses an unrelated name, and a short-string typo, below the floor', () => {
    const fuzzy = [alias({ aliasKey: 'STARBUCKS', merchantId: 'starbucks', matchType: 'fuzzy' })];
    expect(resolveAlias('SUBWAY', fuzzy)).toBeNull();
    expect(resolveAlias('STARBUKS', fuzzy)).toBeNull();
    expect(trigramSimilarity('STARBUCKS', 'STARBUKS')).toBeLessThan(0.72);
  });

  it('returns null when nothing matches', () => {
    expect(resolveAlias('SOMETHING NEW', [alias({})])).toBeNull();
  });
});

describe('stage 7 — provisional merchants', () => {
  it('falls back to the cleaned string, marked source=rule', () => {
    const result = normalizeDescriptor('MERIDIAN LLC PAYROLL', { aliases: SEED_ALIASES });
    expect(result.resolution).toEqual({
      kind: 'provisional',
      name: 'MERIDIAN LLC PAYROLL',
      source: 'rule',
    });
  });

  it('resolves through the seed table when it can', () => {
    const result = normalizeDescriptor('NETFLIX.COM 866-579-7172 CA', { aliases: SEED_ALIASES });
    expect(result.resolution).toMatchObject({ kind: 'alias', merchantId: 'netflix', source: 'seed' });
  });
});

describe('the P2P hard filter (§2.4)', () => {
  const check = (raw: string): boolean =>
    normalizeDescriptor(raw, { aliases: SEED_ALIASES, knownMerchantKeys: SEED_MERCHANT_KEYS }).isP2P;

  it('flags person-to-person descriptors', () => {
    expect(check('ZELLE TO JORDAN P REF#883021')).toBe(true);
    expect(check('VENMO PAYMENT JANE D')).toBe(true);
    expect(check('CASH APP*JORDAN')).toBe(true);
    expect(check('CHECK #1042')).toBe(true);
  });

  it('does not flag ordinary merchants', () => {
    expect(check('STARBUCKS STORE 1234 SEATTLE WA')).toBe(false);
    expect(check('NETFLIX.COM 866-579-7172 CA')).toBe(false);
  });

  /** PayPal carries both real merchants and payments to people, so the prefix alone
   *  cannot decide. An unknown tail is treated as a person — the safe direction. */
  it('treats a PayPal descriptor with an unknown tail as a person', () => {
    expect(
      isP2PDescriptor({
        upperDescriptor: 'PAYPAL *JORDAN PEREZ',
        merchantKey: 'JORDAN PEREZ',
        knownMerchantKeys: SEED_MERCHANT_KEYS,
      })
    ).toBe(true);
  });

  it('treats a PayPal descriptor with a known merchant tail as a merchant', () => {
    expect(
      isP2PDescriptor({
        upperDescriptor: 'PAYPAL *NETFLIX',
        merchantKey: 'NETFLIX',
        knownMerchantKeys: SEED_MERCHANT_KEYS,
      })
    ).toBe(false);
  });
});

describe('determinism', () => {
  it('produces byte-identical output across repeated runs', () => {
    const input = 'SQ *BLUE BOTTLE COFFE 415-555-0111 CA';
    const first = JSON.stringify(normalizeDescriptor(input, { aliases: SEED_ALIASES }));
    for (let i = 0; i < 50; i++) {
      expect(JSON.stringify(normalizeDescriptor(input, { aliases: SEED_ALIASES }))).toBe(first);
    }
  });

  it('does not depend on the order aliases are supplied in', () => {
    const forwards = resolveAlias('NETFLIX', [...SEED_ALIASES]);
    const backwards = resolveAlias('NETFLIX', [...SEED_ALIASES].reverse());
    expect(forwards?.alias.merchantId).toBe(backwards?.alias.merchantId);
  });

  it('caches repeated descriptors in a batch without changing results', () => {
    const descriptors = ['NETFLIX.COM 866-579-7172 CA', 'NETFLIX.COM 866-579-7172 CA'];
    const [a, b] = normalizeBatch(descriptors, { aliases: SEED_ALIASES });
    expect(a).toEqual(b);
  });
});

/**
 * The regression §3.3 is most afraid of, made into a test.
 *
 * "`collapse_v1` must **not** be the §4 normalization chain: that chain is a
 * maintained, growing prefix table, and every addition to it would change
 * `description_normalized` for historical rows, change every `dedupe_key`, and cause
 * the next overlapping import to re-insert rows it should have merged — silently
 * doubling a month of spend."
 *
 * So: grow the table, and assert that exactly one of the two outputs moves.
 */
describe('collapse_v1 is independent of this chain', () => {
  const descriptor = 'FOOBAR* THE COFFEE PLACE';

  it('a new prefix changes the chain and leaves the dedupe input untouched', () => {
    const before = normalizeDescriptor(descriptor, { trace: false }).descriptionNormalized;
    const collapsedBefore = collapseV1(descriptor);

    const grown = ['FOOBAR*', ...PROCESSOR_PREFIXES];
    const after = normalizeDescriptor(descriptor, { prefixes: grown, trace: false }).descriptionNormalized;
    const collapsedAfter = collapseV1(descriptor);

    expect(after).not.toBe(before);
    expect(after).toBe('THE COFFEE PLACE');
    expect(collapsedAfter).toBe(collapsedBefore);
    expect(collapsedAfter).toBe('FOOBAR THE COFFEE PLACE');
  });

  it('the chain output and the collapse output are not the same function', () => {
    for (const raw of [
      'SQ *BLUE BOTTLE COFFE 415-555-0111 CA',
      'TST* THE PLANT CAFE #0042',
      'PAYPAL *SPOTIFYUSA 4029357733',
    ]) {
      expect(normalizeDescriptor(raw, { trace: false }).descriptionNormalized).not.toBe(collapseV1(raw));
    }
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(trigramSimilarity('NETFLIX', 'NETFLIX')).toBe(1);
    expect(trigramSimilarity('NETFLIX', 'XXXXXXX')).toBe(0);
  });

  it('scores a typo higher than an unrelated name', () => {
    expect(trigramSimilarity('STARBUCKS', 'STARBUKS')).toBeGreaterThan(
      trigramSimilarity('STARBUCKS', 'SUBWAY')
    );
  });
});

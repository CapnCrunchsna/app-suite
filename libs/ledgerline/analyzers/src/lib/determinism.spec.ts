/**
 * §2.4's **T2 — determinism under fixed input**, and the third of its three tests
 * as a type-level fact.
 *
 * "`analyze(snapshot, config)` run 100× over a frozen snapshot returns
 * byte-identical `Finding[]`, ordering included. This catches map-iteration order
 * and float drift, which is what the original suite tested by accident."
 *
 * ## Why this replaces something rather than adding to it
 *
 * §2.4 is unusually direct about the suite this stands in for. The design session
 * asserted that findings are byte-identical with and without a provider and
 * verified it by running the battery twice over one snapshot — a test that "passes
 * without exercising the risk", because "the analyzers never call a provider — §2.2
 * makes it a lint error — so swapping the provider under a fixed snapshot cannot
 * change anything."
 *
 * What that suite *accidentally* tested is the real property, and it is worth
 * keeping: the same snapshot must produce the same findings in the same order. Two
 * things in this codebase can break it without breaking anything else. Every rule
 * groups with a `Map`, and a grouping keyed on something with non-deterministic
 * iteration order re-sorts the findings for free. And §5's confidence formulas are
 * floating point, so a term that is summed in a different order can land on a
 * different side of a band cut point.
 *
 * ## Byte-identical, and literally so
 *
 * `JSON.stringify` rather than `toEqual`, because §2.4 says ordering included and a
 * deep-equality assertion over two arrays is order-sensitive at the top level but
 * says nothing about the order of `evidenceTransactionIds` inside a finding — which
 * is exactly where a `Set` iteration would leak through. One string comparison
 * covers the whole shape.
 *
 * ## 100×, and why the count is not decoration
 *
 * Map iteration order in V8 is insertion order and is stable, so a single re-run
 * would pass whatever the bug. What a hundred runs catch is the thing that is
 * *conditionally* unstable: a `Date.now()` reached for inside a rule, a cache that
 * warms after the first call, an object key order that depends on a hash seed.
 * §7.2's "never the wall clock" is the standing rule this enforces from the outside.
 */

import { describe, expect, it } from 'vitest';

import { analyze } from './analyze.js';
import { DEFAULT_CONFIG, resolveConfig } from './config.js';
import type { Snapshot, SnapshotAccount, SnapshotTransaction } from './snapshot.js';

const RUNS = 100;

let nextId = 0;

function tx(
  effectiveDate: string,
  cents: number,
  overrides: Partial<SnapshotTransaction> = {},
): SnapshotTransaction {
  nextId += 1;
  const base = {
    id: `t${nextId}`,
    accountId: 'a1',
    effectiveDate,
    amountCents: -cents,
    descriptionNormalized: 'MERCHANT',
    merchantId: null,
    categoryId: null,
    isPending: false,
    isInternalTransfer: false,
    isExcluded: false,
    refundPairId: null,
    transferPairId: null,
    ...overrides,
  };
  return { ...base, descriptionRaw: overrides.descriptionRaw ?? base.descriptionNormalized };
}

function lastDay(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

function monthRange(start: string, count: number): string[] {
  const months: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function account(id: string, months: readonly string[]): SnapshotAccount {
  return {
    id,
    displayName: id,
    institution: null,
    accountType: 'checking',
    last4: null,
    currency: 'USD',
    isActive: true,
    coverage: months.map((month) => ({ start: `${month}-01`, end: lastDay(month) })),
  };
}

/**
 * A snapshot broad enough that several rules fire at once.
 *
 * Breadth is the point rather than depth: the failure mode this catches is one
 * rule's grouping order leaking into the concatenated `Finding[]`, and a snapshot
 * that only lit up one rule could not show it. So there are subscriptions with a
 * price step, two overlapping streaming merchants, a run of fees, an outlier
 * against a stable baseline, and a pile of small coffee charges — five rules'
 * worth, sharing one traversal exactly as a real run does.
 *
 * Deliberately **not** frozen with `Object.freeze`: §2.2 already forbids a rule
 * from mutating the snapshot and this test's job is the ordering property. A frozen
 * object would turn an accidental write into a different failure with a clearer
 * message, which sounds better and would quietly stop this test from being about
 * what §2.4 says it is about.
 */
function frozenSnapshot(): Snapshot {
  nextId = 0;
  const months = monthRange('2026-01', 12);

  const transactions: SnapshotTransaction[] = [];

  // Two subscriptions, one of which steps in price mid-year (§5.2, §5.5).
  for (let i = 0; i < 12; i += 1) {
    const month = months[i];
    transactions.push(
      tx(`${month}-04`, i < 6 ? 1099 : 1299, {
        descriptionNormalized: 'NETFLIX',
        merchantId: 'netflix',
        categoryId: 'streaming',
      }),
    );
    transactions.push(
      tx(`${month}-17`, 1149, {
        descriptionNormalized: 'SPOTIFY',
        merchantId: 'spotify',
        categoryId: 'streaming',
      }),
    );
  }

  // A run of fees (§5.8).
  for (const month of months.slice(0, 5)) {
    transactions.push(
      tx(`${month}-22`, 3500, { descriptionNormalized: 'NSF FEE', categoryId: 'fees' }),
    );
  }

  // A stable grocery baseline with one genuine outlier at the end (§5.9).
  months.forEach((month, index) => {
    transactions.push(
      tx(`${month}-09`, index === 11 ? 32600 : 8000 + index * 137, {
        descriptionNormalized: 'SAMSCLUB',
        merchantId: 'samsclub',
        categoryId: 'groceries',
      }),
    );
  });

  // High-frequency small spend (§5.11), enough of it to clear the annual floor.
  for (const month of months) {
    for (const day of ['02', '06', '11', '15', '19', '23', '27']) {
      transactions.push(
        tx(`${month}-${day}`, 640, {
          descriptionNormalized: 'BLUE BOTTLE COFFEE',
          merchantId: 'bluebottle',
          categoryId: 'dining',
        }),
      );
    }
  }

  return {
    accounts: [account('a1', months)],
    transactions,
    merchants: [
      {
        id: 'netflix',
        canonicalName: 'NETFLIX',
        displayName: 'Netflix',
        isKnownSubscription: true,
        isTransferKind: false,
        overlapGroup: 'streaming',
      },
      {
        id: 'spotify',
        canonicalName: 'SPOTIFY',
        displayName: 'Spotify',
        isKnownSubscription: true,
        isTransferKind: false,
        overlapGroup: 'streaming',
      },
      {
        id: 'samsclub',
        canonicalName: 'SAMSCLUB',
        displayName: 'Sam’s Club',
        isKnownSubscription: false,
        isTransferKind: false,
        overlapGroup: null,
      },
      {
        id: 'bluebottle',
        canonicalName: 'BLUE BOTTLE COFFEE',
        displayName: 'Blue Bottle Coffee',
        isKnownSubscription: false,
        isTransferKind: false,
        overlapGroup: null,
      },
    ],
    categories: [
      { id: 'streaming', name: 'Streaming', parentId: null, kind: 'spend', overlapGroup: 'streaming' },
      { id: 'groceries', name: 'Groceries', parentId: null, kind: 'spend', overlapGroup: null },
      { id: 'dining', name: 'Dining', parentId: null, kind: 'spend', overlapGroup: null },
      { id: 'fees', name: 'Fees', parentId: null, kind: 'fee', overlapGroup: null },
    ],
  };
}

describe('T2 — determinism under fixed input (§2.4)', () => {
  const snapshot = frozenSnapshot();

  it('fires several rules, so the ordering property has something to be about', () => {
    const result = analyze(snapshot, DEFAULT_CONFIG);

    // Not an assertion about *which* rules — that is §5's business and is pinned
    // in the rule specs. What matters here is that the concatenated array is long
    // enough and mixed enough for an ordering bug to be visible in it at all.
    expect(result.findings.length).toBeGreaterThan(2);
    expect(new Set(result.findings.map((finding) => finding.ruleId)).size).toBeGreaterThan(1);
  });

  it('returns byte-identical findings over 100 runs, ordering included', () => {
    const first = JSON.stringify(analyze(snapshot, DEFAULT_CONFIG).findings);

    for (let run = 1; run < RUNS; run += 1) {
      expect(JSON.stringify(analyze(snapshot, DEFAULT_CONFIG).findings)).toBe(first);
    }
  });

  /**
   * The series too, because §5.3's ledger is persisted by natural key and a
   * re-ordering there would churn `recurring_series` on every run — rows deleted
   * and re-inserted with no charge having changed, which §5.1's "user state
   * survives every re-run" promise is made of.
   */
  it('returns byte-identical series over 100 runs', () => {
    const first = JSON.stringify(analyze(snapshot, DEFAULT_CONFIG).series);

    for (let run = 1; run < RUNS; run += 1) {
      expect(JSON.stringify(analyze(snapshot, DEFAULT_CONFIG).series)).toBe(first);
    }
  });

  /**
   * The same, under a *tuned* config.
   *
   * §7.4 makes every threshold data, and §7.6 says every one of them will move
   * during calibration. A determinism guarantee that only held at the shipped
   * defaults would be a guarantee that expired the first afternoon anyone used the
   * Settings page.
   */
  it('stays deterministic under an overridden config', () => {
    const config = resolveConfig({
      global: { minAnnualImpactCents: 500 },
      outlier: { zThreshold: 2 },
    });

    const first = JSON.stringify(analyze(snapshot, config).findings);
    for (let run = 1; run < RUNS; run += 1) {
      expect(JSON.stringify(analyze(snapshot, config).findings)).toBe(first);
    }
  });

  /**
   * §2.4's **T3 — boundary**, which it calls "a lint assertion, not a runtime test".
   *
   * `eslint.config.mjs` gives `type:analyzers` `onlyDependOnLibsWithTags:
   * ['type:domain']`, so an import of `llm` or `data` from this lib fails
   * `npm run check` before any test runs — which is where T3 lives and why there is
   * nothing to assert here. This case exists so that a reader looking for T3 finds
   * out where it is rather than concluding it was skipped.
   */
  it.todo('T3 — boundary: enforced by the type:analyzers dep constraint in eslint.config.mjs');
});

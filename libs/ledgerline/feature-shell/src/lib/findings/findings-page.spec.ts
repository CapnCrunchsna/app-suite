/**
 * §6.4, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason the other two page specs are:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface, so
 * repeating it here would test the API twice and the page not at all.
 *
 * What is worth testing here is the part the API cannot see — that the headline
 * comes from the summary rather than from the rows on screen, that the dismiss
 * scope picker reaches two different endpoints, that §5.1's two resurface
 * reasons are two different banners, and that a band chip is shown where a raw
 * confidence would be a false precision.
 */

import { TestBed } from '@angular/core/testing';
import type {
  Account,
  CreateDismissalRuleBody,
  DismissalRule,
  Finding,
  FindingPage,
  FindingsSummary,
  Job,
  ListFindingsQuery,
  Merchant,
  SetFindingStateBody,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { FindingsPage } from './findings-page.js';
import { evidenceFor } from './finding-evidence.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    ruleId: 'price_creep.v1',
    ruleVersion: 'price_creep.v1',
    configHash: 'abc12345',
    naturalKey: 'price_creep.v1|series|s1',
    subjectType: 'series',
    subjectId: 's1',
    title: 'Netflix price rose',
    detail: {
      merchantId: 'netflix',
      firstCents: 899,
      currentCents: 1549,
      cumulativeDeltaCents: 650,
      cumulativePercent: 72.3,
      since: '2025-01-05',
      steps: [
        {
          at: '2025-09-05',
          fromCents: 899,
          toCents: 1549,
          deltaCents: 650,
          percent: 72.3,
          annualisedCents: 7800,
          confirmed: true,
        },
      ],
    },
    confidence: 0.82,
    band: 'high',
    impactKind: 'savings',
    impactMonthlyCents: 650,
    impactAnnualCents: 7800,
    llmDependent: false,
    evidenceHash: 'e'.repeat(32),
    evidenceTransactionIds: ['t1', 't2', 't3'],
    firstDetectedAt: '2026-08-14T00:00:00.000Z',
    status: 'active',
    userStatus: null,
    snoozeUntil: null,
    changedSinceDismissal: false,
    reEvaluated: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const SUMMARY: FindingsSummary = {
  subscriptions: { activeCount: 14, lapsedCount: 2, monthlyCents: 24700, annualCents: 296400 },
  savingsAnnualCents: 31200,
  savingsMonthlyCents: 2600,
  activeFindingCount: 9,
  unreviewedCount: 4,
  countsByRule: {},
  countsByBand: {},
  lastRunAt: '2026-08-14T10:00:00.000Z',
  lastRunConfigHash: 'abc12345',
  lastRunSnapshotRows: 5820,
  configHash: 'abc12345',
};

const ACCOUNTS: Account[] = [
  {
    id: 'a1',
    displayName: 'Northgate Checking',
    institution: null,
    accountType: 'checking',
    last4: null,
    currency: 'USD',
    isActive: true,
    createdAt: '',
    updatedAt: '',
  },
];

const MERCHANTS: Merchant[] = [
  {
    id: 'netflix',
    canonicalName: 'NETFLIX',
    displayName: 'Netflix',
    website: null,
    defaultCategoryId: null,
    isKnownSubscription: true,
    isTransferKind: false,
    overlapGroup: 'video_streaming',
    source: 'seed',
  },
];

class ApiStub {
  readonly queries: ListFindingsQuery[] = [];
  readonly states: { id: string; body: SetFindingStateBody }[] = [];
  readonly rules: CreateDismissalRuleBody[] = [];
  runs = 0;

  rows: Finding[] = [finding()];
  summary: FindingsSummary = SUMMARY;

  listFindings(query: ListFindingsQuery): Promise<FindingPage> {
    this.queries.push(query);
    return Promise.resolve({
      rows: this.rows,
      total: this.rows.length,
      limit: query.limit ?? 250,
      offset: 0,
    });
  }

  getFindingsSummary(): Promise<FindingsSummary> {
    return Promise.resolve(this.summary);
  }

  setFindingState(id: string, body: SetFindingStateBody): Promise<Finding> {
    this.states.push({ id, body });
    return Promise.resolve(finding({ id, userStatus: 'acknowledged', snoozeUntil: '2026-11-12' }));
  }

  createDismissalRule(body: CreateDismissalRuleBody): Promise<DismissalRule> {
    this.rules.push(body);
    return Promise.resolve({
      id: 'dr1',
      scope: body.scope,
      ruleId: body.ruleId,
      merchantId: body.merchantId ?? null,
      reason: null,
      createdAt: '',
      updatedAt: '',
    });
  }

  listDismissalRules(): Promise<DismissalRule[]> {
    return Promise.resolve([]);
  }

  runAnalysis(): Promise<Job> {
    this.runs += 1;
    return Promise.resolve(job('succeeded'));
  }

  getJob(): Promise<Job> {
    return Promise.resolve(job('succeeded'));
  }

  listAccounts(): Promise<Account[]> {
    return Promise.resolve(ACCOUNTS);
  }

  listMerchants(): Promise<Merchant[]> {
    return Promise.resolve(MERCHANTS);
  }
}

function job(state: Job['state']): Job {
  return {
    id: 'job-1',
    kind: 'analysis',
    state,
    progress: 100,
    message: 'Analysis finished: 9 findings.',
    resultJson: null,
    finishedAt: null,
    createdAt: '',
    updatedAt: '',
  };
}

describe('FindingsPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    await TestBed.configureTestingModule({
      imports: [FindingsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(FindingsPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const click = async (
    el: HTMLElement,
    selector: string,
    fixture: { whenStable(): Promise<unknown> },
  ) => {
    (el.querySelector(selector) as HTMLButtonElement).click();
    await fixture.whenStable();
  };

  describe('the three numbers (§6.4)', () => {
    it('takes the headline from the summary, not from the rows on screen', async () => {
      const { el } = await render();

      const values = [...el.querySelectorAll('.figure__value')].map((n) => n.textContent?.trim());
      // 14 active subscriptions, $312.00/yr savings, 4 unreviewed — none of which
      // can be derived from the single $78/yr finding this page is holding.
      expect(values).toEqual(['14', '$312.00', '4']);
    });

    it('does not add a visibility finding into the savings headline (§7.3)', async () => {
      api.rows = [
        finding(),
        finding({
          id: 'f2',
          ruleId: 'duplicate.v1',
          impactKind: 'visibility',
          impactAnnualCents: 120000,
          title: '3 video streaming subscriptions',
        }),
      ];
      const { el } = await render();

      // The headline is still the summary's, untouched by a $1,200/yr
      // visibility card sitting on the page.
      expect(el.querySelector('.figure--headline .figure__value')?.textContent?.trim()).toBe(
        '$312.00',
      );
    });

    it('says when the run is older than the thresholds it used (§7.4)', async () => {
      api.summary = { ...SUMMARY, lastRunConfigHash: 'oldhash1' };
      const { el } = await render();

      expect(el.querySelector('.run__stale')?.textContent).toContain('Thresholds have changed');
    });
  });

  describe('grouping and ordering (§6.4)', () => {
    it('groups by rule and leads with the rule that found the most', async () => {
      api.rows = [
        finding({ id: 'small', ruleId: 'lapsed.v1', impactAnnualCents: 0, title: 'A lapsed' }),
        finding({ id: 'big', ruleId: 'duplicate.v1', impactAnnualCents: 24000, title: 'A dupe' }),
        finding({ id: 'mid', ruleId: 'price_creep.v1', impactAnnualCents: 7800 }),
      ];
      const { el } = await render();

      const rules = [...el.querySelectorAll('.group__rule')].map((n) => n.textContent?.trim());
      expect(rules).toEqual(['duplicate.v1', 'price_creep.v1', 'lapsed.v1']);
    });

    it('sorts cards inside a group by annual impact descending', async () => {
      api.rows = [
        finding({ id: 'a', impactAnnualCents: 1000, title: 'Smaller' }),
        finding({ id: 'b', impactAnnualCents: 9000, title: 'Bigger' }),
      ];
      const { el } = await render();

      const titles = [...el.querySelectorAll('.card__title')].map((n) => n.textContent?.trim());
      expect(titles).toEqual(['Bigger', 'Smaller']);
    });
  });

  describe('the dismiss scope picker (§5.1, §3.1)', () => {
    /**
     * The three scopes are two tables. "This finding" is per-finding user state;
     * the other two are a standing filter applied at emit time to findings that
     * do not exist yet.
     */
    it('routes "just this finding" to the finding-state endpoint', async () => {
      const { fixture, el } = await render();

      await click(el, '.action--dismiss', fixture);
      await click(el, '.picker__option', fixture);

      expect(api.states).toEqual([{ id: 'f1', body: { status: 'dismissed' } }]);
      expect(api.rules).toEqual([]);
    });

    it('routes "this rule for this merchant" to a dismissal rule', async () => {
      const { fixture, el } = await render();

      await click(el, '.action--dismiss', fixture);
      const options = [...el.querySelectorAll<HTMLButtonElement>('.picker__option')];
      options[1].click();
      await fixture.whenStable();

      expect(api.rules).toEqual([
        { scope: 'merchant_rule', ruleId: 'price_creep.v1', merchantId: 'netflix' },
      ]);
      expect(api.states).toEqual([]);
    });

    it('routes "this rule entirely" to a rule-scoped dismissal', async () => {
      const { fixture, el } = await render();

      await click(el, '.action--dismiss', fixture);
      const options = [...el.querySelectorAll<HTMLButtonElement>('.picker__option')];
      options[2].click();
      await fixture.whenStable();

      expect(api.rules).toEqual([{ scope: 'rule', ruleId: 'price_creep.v1' }]);
    });

    it('offers no merchant scope for a finding that has no merchant', async () => {
      api.rows = [
        finding({
          ruleId: 'duplicate.v1',
          subjectType: 'category',
          detail: { kind: 'category_overlap', overlapGroup: 'video_streaming', seriesIds: [] },
        }),
      ];
      const { fixture, el } = await render();

      await click(el, '.action--dismiss', fixture);

      // Two options, not three — offering a scope the API would reject is worse
      // than not offering it.
      expect(el.querySelectorAll('.picker__option')).toHaveLength(2);
    });

    it('says that a rule dismissal suppresses rather than deletes', async () => {
      const { fixture, el } = await render();

      await click(el, '.action--dismiss', fixture);
      const options = [...el.querySelectorAll<HTMLButtonElement>('.picker__option')];
      options[2].click();
      await fixture.whenStable();

      expect(el.querySelector('.notice__text')?.textContent).toContain('suppressed, not deleted');
    });
  });

  describe('the other two actions', () => {
    it('acknowledges a finding', async () => {
      const { fixture, el } = await render();

      const acknowledge = [...el.querySelectorAll<HTMLButtonElement>('.action')].find((b) =>
        b.textContent?.includes('Acknowledge'),
      );
      acknowledge?.click();
      await fixture.whenStable();

      expect(api.states).toEqual([{ id: 'f1', body: { status: 'acknowledged' } }]);
    });

    it('snoozes without restating the 90 days the API already defaults to', async () => {
      const { fixture, el } = await render();

      const snooze = [...el.querySelectorAll<HTMLButtonElement>('.action')].find((b) =>
        b.textContent?.includes('Snooze'),
      );
      snooze?.click();
      await fixture.whenStable();

      expect(api.states).toEqual([{ id: 'f1', body: { status: 'snoozed' } }]);
      expect(el.querySelector('.notice__text')?.textContent).toContain('2026-11-12');
    });
  });

  describe('resurfaced findings (§5.1)', () => {
    it('shows the money-changed banner and the rule-changed banner differently', async () => {
      api.rows = [
        finding({ id: 'changed', changedSinceDismissal: true }),
        finding({ id: 'reeval', reEvaluated: true, title: 'Rescored' }),
      ];
      const { el } = await render();

      expect(el.querySelector('.banner--changed')?.textContent).toContain(
        'Changed since you dismissed this',
      );
      expect(el.querySelector('.banner--reevaluated')?.textContent).toContain(
        'Re-evaluated with an improved rule',
      );
      // Two distinct treatments, because they mean different things: one is the
      // money moving, the other is a threshold being tuned.
      expect(el.querySelectorAll('.banner')).toHaveLength(2);
    });
  });

  describe('what reaches the DOM', () => {
    it('shows a confidence band, never the raw number (§5.1)', async () => {
      const { el } = await render();

      expect(el.querySelector('.chip--band')?.textContent?.trim()).toBe('High confidence');
      expect(el.textContent).not.toContain('0.82');
    });

    it('renders money from integer cents', async () => {
      const { el } = await render();

      expect(el.querySelector('.card__annual')?.textContent?.trim()).toBe('$78.00');
      expect(el.querySelector('.card__monthly')?.textContent?.trim()).toBe('$6.50/mo');
    });

    it('badges an llm-dependent finding (§2.4)', async () => {
      api.rows = [finding({ llmDependent: true })];
      const { el } = await render();

      expect(el.querySelector('.chip--llm')?.textContent).toContain('AI-assisted grouping');
    });

    it('renders evidence inline rather than linking away (§6.4)', async () => {
      const { el } = await render();

      const evidence = el.querySelector('.evidence')?.textContent?.replace(/\s+/g, ' ') ?? '';
      expect(evidence).toContain('$8.99 → $15.49');
      expect(evidence).toContain('+72.3%');
      // The evidence count reassures without fetching the rows themselves.
      expect(evidence).toContain('3 charges');
    });
  });

  describe('filters (§6.4)', () => {
    it('sends band, rule, account and minimum impact to the API', async () => {
      const { fixture } = await render();
      const page = fixture.componentInstance as unknown as {
        onFilterChange: (f: Record<string, unknown>) => void;
        filter: () => Record<string, unknown>;
      };

      page.onFilterChange({
        ...page.filter(),
        bands: ['high', 'medium'],
        ruleIds: ['price_creep.v1'],
        accountIds: ['a1'],
        minAnnualText: '100.00',
      });
      await fixture.whenStable();

      expect(api.queries.at(-1)).toMatchObject({
        bands: 'high,medium',
        ruleIds: 'price_creep.v1',
        accountIds: 'a1',
        // 10000, not 9999.999999999998.
        minAnnualImpactCents: 10000,
      });
    });

    it('hides dismissed and snoozed findings by default', async () => {
      await render();

      expect(api.queries.at(-1)?.visibility).toBe('visible');
    });

    it('ignores a minimum that is not an unambiguous figure', async () => {
      const { fixture } = await render();
      const page = fixture.componentInstance as unknown as {
        onFilterChange: (f: Record<string, unknown>) => void;
        filter: () => Record<string, unknown>;
      };

      page.onFilterChange({ ...page.filter(), minAnnualText: '1.234,56' });
      await fixture.whenStable();

      expect(api.queries.at(-1)?.minAnnualImpactCents).toBeUndefined();
    });
  });

  it('runs an analysis and reports what the job said (§2.7)', async () => {
    const { fixture, el } = await render();

    await click(el, '.run__button', fixture);

    expect(api.runs).toBe(1);
    expect(el.querySelector('.notice__text')?.textContent).toContain('Analysis finished');
  });

  it('explains an empty page rather than showing a blank one', async () => {
    api.rows = [];
    api.summary = { ...SUMMARY, lastRunAt: null, lastRunConfigHash: null };
    const { el } = await render();

    expect(el.querySelector('.empty')?.textContent).toContain('No analysis has run yet');
  });

  it('names the API and how to start it when it cannot be reached', async () => {
    vi.spyOn(api, 'listFindings').mockRejectedValue(new Error('fetch failed'));
    const { el } = await render();

    expect(el.querySelector('.failure__text')?.textContent).toContain('127.0.0.1:4310');
  });
});

describe('evidenceFor', () => {
  /** Pure, so the numbers can be asserted without a DOM — the same separation
   *  `virtual-window.ts` and `review-warnings.ts` have. */
  it("reads each rule's own detail payload", () => {
    expect(evidenceFor(finding()).rows[0].value).toContain('$8.99 → $15.49');

    const lapsed = evidenceFor(
      finding({
        ruleId: 'lapsed.v1',
        detail: {
          lastChargeAt: '2025-06-05',
          coverageEnd: '2025-12-31',
          silentDays: 209,
          expectedEvery: 30,
          formerMonthlyCents: 1549,
        },
      }),
    );
    expect(lapsed.caption).toBe('Appears cancelled');
    expect(lapsed.rows.some((row) => row.value.includes('209 days'))).toBe(true);
  });

  it('degrades to no rows rather than throwing on an unexpected payload', () => {
    expect(evidenceFor(finding({ detail: {} })).rows).toEqual([]);
    expect(evidenceFor(finding({ ruleId: 'unknown.v1', detail: {} })).rows).toEqual([]);
  });
});

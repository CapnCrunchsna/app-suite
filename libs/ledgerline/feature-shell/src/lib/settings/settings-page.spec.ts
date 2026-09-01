/**
 * §6.8, against a stubbed `LedgerlineApiService`.
 *
 * Stubbed rather than served, for the same reason the other five page specs are:
 * `apps/ledgerline-api`'s suite already drives the real HTTP surface.
 *
 * What is worth testing here is the part the API cannot see — that a rule's switch and
 * a threshold travel as the same write, that blanking a field resets rather than
 * setting zero, that §6.8's re-evaluation warning is a count and stays quiet when the
 * count is nothing, and that the wipe button does not arm until the phrase is typed
 * exactly.
 */

import { TestBed } from '@angular/core/testing';
import type {
  Category,
  CategoryDeleteResult,
  CategoryUpdate,
  CategoryUsage,
  CreateCategoryBody,
  DegradedCallLog,
  DeleteCategoryQuery,
  Job,
  LlmHealth,
  Settings,
  SettingsUpdate,
  UpdateCategoryBody,
  UpdateSettingsBody,
  WipeResult,
} from '@metrum/api-client';

import { LedgerlineApiService } from '../ledgerline-api.service.js';
import { SettingsPage } from './settings-page.js';

function settingsOf(overrides: Partial<Settings> = {}): Settings {
  return {
    configHash: 'abc0123456789def',
    rules: [
      {
        id: 'recurrence.v1',
        label: 'Recurring subscriptions',
        specRef: '5.2',
        section: 'recurrence',
        enabledKey: 'enabled',
        enabled: true,
        activeFindings: 3,
        dismissedFindings: 0,
        labelled: { ruleId: '', correct: 0, incorrect: 0, unsure: 0, stale: 0 },
      },
      {
        id: 'duplicate.v1',
        label: 'Same-merchant multiplicity',
        specRef: '5.4',
        section: 'duplicate',
        enabledKey: 'sameMerchantEnabled',
        enabled: true,
        activeFindings: 1,
        dismissedFindings: 2,
        labelled: { ruleId: '', correct: 0, incorrect: 0, unsure: 0, stale: 0 },
      },
      {
        id: 'duplicate.v1',
        label: 'Category overlap',
        specRef: '5.4',
        section: 'duplicate',
        enabledKey: 'categoryOverlapEnabled',
        enabled: true,
        activeFindings: 0,
        dismissedFindings: 1,
        labelled: { ruleId: '', correct: 0, incorrect: 0, unsure: 0, stale: 0 },
      },
    ],
    thresholds: [
      {
        section: 'recurrence',
        key: 'enabled',
        kind: 'boolean',
        defaultValue: true,
        value: true,
        overridden: false,
      },
      {
        section: 'recurrence',
        key: 'minOccurrences',
        kind: 'number',
        defaultValue: 3,
        value: 3,
        overridden: false,
      },
      {
        section: 'duplicate',
        key: 'sameMerchantEnabled',
        kind: 'boolean',
        defaultValue: true,
        value: true,
        overridden: false,
      },
      {
        section: 'duplicate',
        key: 'categoryOverlapEnabled',
        kind: 'boolean',
        defaultValue: true,
        value: true,
        overridden: false,
      },
      {
        section: 'duplicate',
        key: 'sameMerchantConfidence',
        kind: 'number',
        defaultValue: 0.85,
        value: 0.7,
        overridden: true,
      },
      {
        section: 'global',
        key: 'minAnnualImpactCents',
        kind: 'number',
        defaultValue: 2500,
        value: 2500,
        overridden: false,
      },
    ],
    unsettable: [
      { section: 'recurrence', key: 'cadences', reason: 'a calibration decision, not a number' },
    ],
    // §6.8's provider section, at the shipped default: nothing configured, nothing
    // sent, redaction on. That is the state the app is in until someone changes it,
    // and the state most of these cases should be exercised against.
    llm: {
      providerId: 'none',
      model: null,
      redaction: true,
      redactionLocked: false,
      sendsDataOffMachine: false,
      cachedResponses: 0,
      degradedCallCount: 0,
    },
    databaseFile: 'C:/data/ledgerline.sqlite',
    backupDir: 'C:/data/backups',
    ...overrides,
  };
}

/**
 * What a `ledgerline-api` older than §2.4's seam serves: the same payload with no
 * `llm` block at all.
 *
 * Derived from `settingsOf()` by dropping the one key, so the rest of the page still
 * has rules and thresholds to render — the bug is about a missing block, not an empty
 * response. `apps/ledgerline-ui`'s spec holds the same fixture for the header's
 * version of this; it is written twice rather than shared because §2.2's dep rules do
 * not let a lib import from an app.
 */
function settingsWithoutLlm(): Settings {
  const { llm: _llm, ...rest } = settingsOf();
  return rest as unknown as Settings;
}

/** One row of §6.8's taxonomy read, defaulted to the boring case so a test only
 *  states the part it is about. */
function usageOf(
  category: Partial<Category> & { id: string; name: string },
  counts: Partial<Pick<CategoryUsage, 'transactions' | 'merchants' | 'children'>> = {},
): CategoryUsage {
  const filled = {
    parentId: null,
    kind: 'spend' as const,
    overlapGroup: null,
    source: 'seed' as const,
    ...category,
  };
  const used = { transactions: 0, merchants: 0, children: 0, ...counts };
  return {
    category: filled,
    ...used,
    deletable: used.transactions + used.merchants + used.children === 0,
  };
}

class ApiStub {
  readonly updates: UpdateSettingsBody[] = [];
  readonly wipes: unknown[] = [];
  backups = 0;

  current: Settings = settingsOf();
  dismissalsAffected = 0;

  getSettings(): Promise<Settings> {
    return Promise.resolve(this.current);
  }

  updateSettings(body: UpdateSettingsBody): Promise<SettingsUpdate> {
    this.updates.push(body);
    return Promise.resolve({
      settings: this.current,
      configHashChanged: true,
      dismissalsAffected: this.dismissalsAffected,
    });
  }

  backupData(): Promise<{ path: string; createdAt: string }> {
    this.backups += 1;
    return Promise.resolve({ path: 'C:/data/backups/x.sqlite', createdAt: '' });
  }

  wipeData(body: unknown): Promise<WipeResult> {
    this.wipes.push(body);
    return Promise.resolve({
      backupPath: 'C:/data/backups/before-wipe.sqlite',
      rowsDeleted: 42,
      deletedByTable: {},
    });
  }

  exportData(): Promise<Blob> {
    return Promise.resolve(new Blob(['{}']));
  }

  // §6.8's LLM section. The probe is stubbed rather than omitted because the page
  // must never call it on render — a spec that could not observe the call could
  // not catch a regression that started one.
  healthProbes = 0;
  /** Set to make the probe itself fail rather than answer. §6.8's Test Connection
   *  has an error path, and the page builds a `health` object of its own to render
   *  it — so the failure has to come from the stub, not from a bad `health`. */
  healthFailure: Error | null = null;
  health: LlmHealth = {
    providerId: 'none',
    ok: false,
    detail: 'LLM disabled',
    model: null,
    sendsDataOffMachine: false,
    capabilities: [],
  };

  getLlmHealth(): Promise<LlmHealth> {
    this.healthProbes += 1;
    return this.healthFailure ? Promise.reject(this.healthFailure) : Promise.resolve(this.health);
  }

  degradedLog: DegradedCallLog = { entries: [], total: 0 };

  listDegradedCalls(): Promise<DegradedCallLog> {
    return Promise.resolve(this.degradedLog);
  }

  // §6.8's re-normalize trigger. The count is the API's, because it is the number
  // the button promises.
  transactions = 326;

  getHealth(): Promise<{ ok: boolean; schemaVersion: number; transactions: number; profileLoadErrors: string[] }> {
    return Promise.resolve({
      ok: true,
      schemaVersion: 6,
      transactions: this.transactions,
      profileLoadErrors: [],
    });
  }

  // §6.8's Categories (§9ad). The counts are the API's, because they are what
  // decides whether a delete is offered at all.
  categories: CategoryUsage[] = [
    usageOf({ id: 'groceries', name: 'Groceries' }, { transactions: 42, merchants: 1 }),
    usageOf({ id: 'entertainment', name: 'Entertainment', overlapGroup: 'video_streaming' }),
    usageOf({ id: 'music', name: 'Music', overlapGroup: 'video_streaming', source: 'user' }),
    usageOf({ id: 'stationery', name: 'Stationery' }),
  ];
  readonly categoryWrites: unknown[] = [];
  categoryUpdate: CategoryUpdate | null = null;

  listCategoryUsage(): Promise<CategoryUsage[]> {
    return Promise.resolve(this.categories);
  }

  createCategory(body: CreateCategoryBody): Promise<Category> {
    this.categoryWrites.push({ create: body });
    return Promise.resolve({
      id: 'new',
      name: body.name,
      parentId: body.parentId ?? null,
      kind: body.kind,
      overlapGroup: body.overlapGroup ?? null,
      source: 'user',
    });
  }

  updateCategory(id: string, body: UpdateCategoryBody): Promise<CategoryUpdate> {
    this.categoryWrites.push({ update: id, body });
    const existing = this.categories.find((row) => row.category.id === id) as CategoryUsage;
    return Promise.resolve(
      this.categoryUpdate ?? {
        category: { ...existing.category, ...body } as Category,
        kindChangedFrom: null,
        transactionsRepartitioned: 0,
        rulesAffected: [],
      },
    );
  }

  deleteCategory(id: string, query: DeleteCategoryQuery = {}): Promise<CategoryDeleteResult> {
    this.categoryWrites.push({ delete: id, query });
    return Promise.resolve({
      deletedId: id,
      reassignedTo: query.reassignTo ?? null,
      transactionsMoved: query.reassignTo ? 42 : 0,
      merchantsMoved: query.reassignTo ? 1 : 0,
      childrenPromoted: 0,
    });
  }

  sweeps = 0;
  jobStates: Job['state'][] = ['succeeded'];

  renormalizeAll(): Promise<{ id: string; coalesced: boolean; transactions: number }> {
    this.sweeps += 1;
    return Promise.resolve({ id: 'sweep-1', coalesced: false, transactions: this.transactions });
  }

  getJob(): Promise<Job> {
    // Shift through the scripted states so a test can make the job run before it
    // lands, which is the only way to observe the progress bar at all.
    const state = this.jobStates.length > 1 ? (this.jobStates.shift() as Job['state']) : this.jobStates[0];
    return Promise.resolve({
      id: 'sweep-1',
      kind: 'renormalize',
      state,
      progress: state === 'succeeded' ? 100 : 40,
      message: state === 'succeeded' ? null : 're-normalized 130 of 326 transactions',
      resultJson: null,
      createdAt: '',
      updatedAt: '',
    } as Job);
  }
}

describe('SettingsPage', () => {
  let api: ApiStub;

  beforeEach(async () => {
    api = new ApiStub();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [{ provide: LedgerlineApiService, useValue: api }],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement, selector: string) =>
    [...el.querySelectorAll(selector)].map((n) => n.textContent?.replace(/\s+/g, ' ').trim());

  /** By id, not by text: every root's name appears inside every other row's parent
   *  `<select>`, so text picks the wrong row and does it silently. */
  const rowFor = (el: HTMLElement, id: string) =>
    el.querySelector(`.row[data-category="${id}"]`) as HTMLElement;

  // ------------------------------------------------------------ layout ---

  describe('the Analyzers section (§6.8, §7.4)', () => {
    it('shows the config hash and how much has been tuned', async () => {
      const { el } = await render();

      expect(el.querySelector('.hash code')?.textContent).toBe('abc0123456789def');
      // One threshold is overridden in the fixture; §7.6's whole point is knowing
      // which of the uncalibrated defaults you have moved.
      expect(el.querySelector('.hash__tuned')?.textContent?.trim()).toBe('1 threshold overridden');
    });

    it('says so plainly when nothing has been tuned', async () => {
      api.current = settingsOf({
        thresholds: settingsOf().thresholds.map((t) => ({ ...t, overridden: false, value: t.defaultValue })),
      });
      const { el } = await render();

      expect(el.querySelector('.hash__tuned')?.textContent?.trim()).toBe('all defaults');
    });

    /** §5.4 is two rules sharing one id and one section, "separately toggleable". */
    it('renders §5.4’s two halves as two switches under one group', async () => {
      const { el } = await render();
      const groups = text(el, '.group__title');

      expect(groups).toContain('Duplicate and overlapping services');
      const duplicateGroup = [...el.querySelectorAll('.group')].find((g) =>
        g.querySelector('.group__title')?.textContent?.includes('Duplicate'),
      ) as HTMLElement;
      expect(text(duplicateGroup, '.switch__label')).toEqual([
        'Same-merchant multiplicity',
        'Category overlap',
      ]);
    });

    it('groups the sections that belong to no rule rather than dropping them', async () => {
      const { el } = await render();
      // `global` is not a §5 rule but holds §5.1's emission policy — the most
      // consequential numbers in the file.
      expect(text(el, '.group__title')).toContain('Shared emission policy');
    });

    it('lists what it will not edit, with the reason', async () => {
      const { el } = await render();
      expect(text(el, '.unsettable li')[0]).toContain('recurrence.cadences');
      expect(text(el, '.unsettable li')[0]).toContain('calibration');
    });

    it('does not show a rule’s switch twice', async () => {
      const { el } = await render();
      // `recurrence.enabled` is the switch in the header; it must not also appear
      // as a checkbox in the number list below it.
      expect(text(el, '.field__key')).not.toContain('enabled');
      expect(text(el, '.field__key')).toContain('minOccurrences');
    });
  });

  // ------------------------------------------------------------ writes ---

  describe('editing', () => {
    it('sends a rule switch as a change to its own config section (§6.8)', async () => {
      const { el, fixture } = await render();

      (el.querySelector('.switch input') as HTMLInputElement).click();
      await fixture.whenStable();

      expect(api.updates).toHaveLength(1);
      expect(api.updates[0].changes).toEqual([
        { section: 'recurrence', key: 'enabled', value: false },
      ]);
    });

    it('sends a threshold as the same kind of change', async () => {
      const { el, fixture } = await render();

      const input = [...el.querySelectorAll('.field__input')].find(
        (node) =>
          node.previousElementSibling?.querySelector('.field__key')?.textContent?.trim() ===
          'minOccurrences',
      ) as HTMLInputElement;
      input.value = '5';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(api.updates[0].changes).toEqual([
        { section: 'recurrence', key: 'minOccurrences', value: 5 },
      ]);
    });

    /** Blanking a field is how someone asks for "whatever it was". Typing 0 is not. */
    it('treats an emptied field as a reset, not as zero', async () => {
      const { el, fixture } = await render();

      const input = [...el.querySelectorAll('.field__input')].find(
        (node) => node.previousElementSibling?.textContent?.trim() === 'sameMerchantConfidence',
      ) as HTMLInputElement;
      input.value = '';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(api.updates[0].changes).toEqual([
        { section: 'duplicate', key: 'sameMerchantConfidence', value: null },
      ]);
    });

    it('writes nothing when the value has not moved', async () => {
      const { el, fixture } = await render();

      const input = [...el.querySelectorAll('.field__input')].find(
        (node) =>
          node.previousElementSibling?.querySelector('.field__key')?.textContent?.trim() ===
          'minOccurrences',
      ) as HTMLInputElement;
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(api.updates).toHaveLength(0);
    });

    it('warns about the dismissals a change reopens, and only then (§5.1)', async () => {
      api.dismissalsAffected = 3;
      const { el, fixture } = await render();

      (el.querySelector('.switch input') as HTMLInputElement).click();
      await fixture.whenStable();

      expect(el.querySelector('.notice')?.textContent).toContain('3 dismissed findings');
      expect(el.querySelector('.notice')?.textContent).toContain('re-evaluated');
    });

    it('stays quiet about dismissals when there are none', async () => {
      const { el, fixture } = await render();

      (el.querySelector('.switch input') as HTMLInputElement).click();
      await fixture.whenStable();

      expect(el.querySelector('.notice')?.textContent).not.toContain('dismissed');
    });

    /** The rule-level banner, shown before anything is touched. */
    it('marks a group whose dismissals a change would reopen', async () => {
      const { el } = await render();
      const warnings = text(el, '.warn');

      // §5.4's two halves have 2 + 1 dismissed between them.
      expect(warnings.some((w) => w?.includes('3 dismissed findings'))).toBe(true);
      // §5.2 has none, so it gets no banner.
      expect(warnings).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------- data ---

  describe('the Data section (§2.3, §6.8)', () => {
    it('shows where the database and the backups live', async () => {
      const { el } = await render();
      expect(text(el, '.where dd')[0]).toContain('C:/data/ledgerline.sqlite');
      expect(text(el, '.where dd')[1]).toContain('C:/data/backups');
    });

    it('keeps the wipe disarmed until the phrase is exact', async () => {
      const { el, fixture } = await render();
      const button = el.querySelector('.button--danger') as HTMLButtonElement;
      const input = el.querySelector('.danger__input') as HTMLInputElement;

      expect(button.disabled).toBe(true);

      for (const attempt of ['delete everything', 'DELETE', 'DELETE EVERYTHING ']) {
        input.value = attempt;
        input.dispatchEvent(new Event('input'));
        await fixture.whenStable();
        expect(button.disabled).toBe(true);
      }

      input.value = 'DELETE EVERYTHING';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(button.disabled).toBe(false);
    });

    it('reports the safety backup after a wipe', async () => {
      const { el, fixture } = await render();
      const input = el.querySelector('.danger__input') as HTMLInputElement;
      input.value = 'DELETE EVERYTHING';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      (el.querySelector('.button--danger') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.wipes).toEqual([{ confirm: 'DELETE EVERYTHING' }]);
      // The whole safety argument is that the copy exists and the user is told where.
      expect(el.querySelector('.notice')?.textContent).toContain('before-wipe.sqlite');
      expect(el.querySelector('.notice')?.textContent).toContain('42 rows deleted');
    });

    it('cannot back up an in-memory instance, and says why', async () => {
      api.current = settingsOf({ databaseFile: ':memory:' });
      const { el } = await render();

      expect((el.querySelector('.actions .button') as HTMLButtonElement).disabled).toBe(true);
      expect(el.querySelector('.where__note')?.textContent).toContain('nothing is written to disk');
    });
  });

  // ---------------------------------------------------------- absences ---

  /**
   * §9s moved §4.1 step 7's queue to §6.9's Review page. The stub above has no
   * merchant methods at all, so this page reaching for one would fail loudly
   * rather than quietly rendering an empty section — which is the failure mode
   * worth guarding, given the queue spent a day here.
   */
  it('no longer carries the merchant review queue (§9s)', async () => {
    const { el } = await render();

    // §9t added AI assistance, §9v added Merchant names — which is the sweep, not
    // the queue — and §9ad added Categories, which took the "Not built yet" panel
    // with it. The queue is still absent, which is the point.
    expect(text(el, '.panel__heading')).toEqual([
      'Analyzers',
      'AI assistance',
      'Merchant names',
      'Categories',
      'Data',
    ]);
    expect(el.querySelector('ll-merchant-review')).toBeNull();
    expect(el.textContent).not.toContain('Nothing to review');
  });

  /**
   * §9k rendered §6.8's unbuilt sections as stated absences rather than omitting
   * them, and one by one they were built. Categories was the last (§9ad), so the
   * panel that held them has nothing left to hold.
   *
   * Asserted rather than simply deleted, because an empty "Not built yet" panel is
   * exactly what would survive a careless edit — and a page that says it is missing
   * something it now has is worse than one that never said.
   */
  it('has no stated absences left (§9ad)', async () => {
    const { el } = await render();

    expect(el.querySelector('.pending')).toBeNull();
    expect(el.textContent).not.toContain('Not built yet');
  });

  // -------------------------------------------------------- §6.8's LLM ---

  /**
   * The provider section, and the one property of it worth asserting from up here
   * rather than in the panel: **nothing probes on render**.
   *
   * §2.4's providers spawn a process or open a socket. A page that ran a health
   * check when it loaded would start the Claude CLI every time someone opened
   * Settings — which is both slow and, for the one provider that sends data off
   * this machine, not a thing that should happen without being asked for.
   */
  it('does not probe the provider until Test Connection is pressed', async () => {
    await render();
    expect(api.healthProbes).toBe(0);
  });

  it('renders the provider section against the shipped default', async () => {
    const { el } = await render();
    expect(el.querySelector('ll-llm-settings')).not.toBeNull();
  });

  /**
   * §2.4's seam is newer than the API binary a user may still have running, and one
   * older than it serves a settings payload with no `llm` block at all.
   *
   * The header had the same bug and threw on every page load, which is why it was
   * fixed first. This one is the error path of an error path — it needs someone to
   * open Settings, press Test Connection, *and* the probe to reject — but it fails
   * worse when it does happen: the line it throws on is building the fallback
   * `health` object **for** a failed probe, so the throw replaces a legible "the
   * check itself failed" with an unhandled TypeError. The user pressed a button and
   * is told nothing at all.
   *
   * The page renders the panel against §6.8's shipped default in this state, for the
   * reason the header's fix argues: `none`, local, and never the reverse.
   */
  it('still reports a failed probe when the payload predates the llm block', async () => {
    api.current = settingsWithoutLlm();
    api.healthFailure = new Error('spawn claude ENOENT');

    const { el, fixture } = await render();

    // The panel has to survive the render before anyone can press the button: it
    // takes a required input, and the page used to hand it the missing block.
    expect(el.querySelector('ll-llm-settings .provider--selected')?.textContent).toContain('None');

    (el.querySelector('.test button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(api.healthProbes).toBe(1);
    const result = el.querySelector('.test__result')?.textContent;
    expect(result).toContain('The check itself failed');
    expect(result).toContain('spawn claude ENOENT');
  });

  // ------------------------------------------------- §6.8's Categories (§9ad) ---

  /**
   * The half of this section with analytical weight is the overlap group, so that is
   * what most of these are about. §5.4 needs "two or more active series sharing an
   * `overlap_group`", and a group with one category in it is a label the rule can
   * never act on — the page has to say which is which, because the difference is
   * invisible in a text field.
   */
  describe('the Categories section (§6.8, §5.4)', () => {
    it('renders §5.4’s groups and says which one the rule can act on', async () => {
      api.categories = [
        ...api.categories,
        usageOf({ id: 'vpn', name: 'VPN', overlapGroup: 'vpn' }),
      ];
      const { el } = await render();

      const groups = text(el, '.group');
      // Two categories share `video_streaming`; `vpn` has one.
      expect(groups.some((g) => g?.includes('video_streaming') && g?.includes('Entertainment'))).toBe(
        true,
      );
      expect(groups.find((g) => g?.includes('vpn'))).toContain('only one category');
    });

    it('says the rule finds nothing when no category carries a group', async () => {
      api.categories = api.categories.map((row) =>
        usageOf({ ...row.category, overlapGroup: null }),
      );
      const { el } = await render();

      expect(el.querySelector('ll-category-settings .none')?.textContent).toContain(
        'finds nothing',
      );
    });

    it('assigns an overlap group, and says what the claim is for', async () => {
      const { el, fixture } = await render();

      const input = [...el.querySelectorAll('.row__group')].find(
        (node) => (node as HTMLInputElement).value === '',
      ) as HTMLInputElement;
      input.value = 'meal_kit';
      input.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(api.categoryWrites).toEqual([
        { update: 'groceries', body: { overlapGroup: 'meal_kit' } },
      ]);
      expect(el.querySelector('.notice')?.textContent).toContain('duplicate check');
    });

    /** §5.8 and §6.6 read `fee`; §5.10 trends only `spend`. The count and the rule
     *  names are the API's — this page cannot see either. */
    it('reports what a kind change re-partitions, in the API’s numbers', async () => {
      api.categoryUpdate = {
        category: { ...api.categories[0].category, kind: 'fee' },
        kindChangedFrom: 'spend',
        transactionsRepartitioned: 42,
        rulesAffected: ['fees.v1', 'trend.v1'],
      };
      const { el, fixture } = await render();

      const select = el.querySelector('.row__kind') as HTMLSelectElement;
      select.value = 'fee';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      const notice = el.querySelector('.notice')?.textContent;
      expect(notice).toContain('42 charges');
      expect(notice).toContain('fees.v1 and trend.v1');
    });

    /** §6.9's rule, inherited: a direction is armed, and a second explicit click
     *  performs it. Nothing is written on the first press. */
    it('arms a delete rather than performing it', async () => {
      const { el, fixture } = await render();

      const row = rowFor(el, 'stationery');
      (row.querySelector('.row__delete') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.categoryWrites).toEqual([]);
      expect(row.querySelector('.confirm')).not.toBeNull();

      (row.querySelector('.confirm__go') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.categoryWrites).toEqual([{ delete: 'stationery', query: {} }]);
    });

    /**
     * §3.2 RESTRICTs a category in use, and the API refuses before the constraint
     * does. The page's job is not to repeat the refusal — it is to not offer a click
     * that cannot succeed.
     */
    it('will not confirm a delete of a category in use until a target is chosen', async () => {
      const { el, fixture } = await render();

      const row = rowFor(el, 'groceries');
      (row.querySelector('.row__delete') as HTMLButtonElement).click();
      await fixture.whenStable();

      const go = row.querySelector('.confirm__go') as HTMLButtonElement;
      expect(row.querySelector('.confirm')?.textContent).toContain('42 charges');
      expect(go.disabled).toBe(true);

      const target = row.querySelector('.confirm__target') as HTMLSelectElement;
      target.value = 'stationery';
      target.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(go.disabled).toBe(false);
      go.click();
      await fixture.whenStable();

      expect(api.categoryWrites).toEqual([
        { delete: 'groceries', query: { reassignTo: 'stationery' } },
      ]);
      expect(el.querySelector('.notice')?.textContent).toContain('42 charges');
    });

    it('adds a category', async () => {
      const { el, fixture } = await render();

      const name = el.querySelector('.add__name') as HTMLInputElement;
      name.value = 'Cloud storage';
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      (el.querySelector('.add__go') as HTMLButtonElement).click();
      await fixture.whenStable();

      expect(api.categoryWrites).toEqual([
        { create: { name: 'Cloud storage', kind: 'spend', parentId: null } },
      ]);
      expect(el.querySelector('.notice')?.textContent).toContain('Cloud storage');
    });

    /** §7.5: shown, never acted on. It is on screen because an edited seed row stops
     *  moving with the shipped taxonomy, which is worth knowing before you edit one. */
    it('marks the rows that are the user’s rather than the shipped set', async () => {
      const { el } = await render();

      expect(rowFor(el, 'music').querySelector('.row__source')?.textContent?.trim()).toBe('yours');
      expect(rowFor(el, 'stationery').querySelector('.row__source')).toBeNull();
    });
  });

  // --------------------------------------------- §6.8's re-normalize trigger ---

  /**
   * §6.8 asks for "a re-normalize trigger with job progress", and §9v built it. The
   * two things worth asserting from the container are the two it owns: the count on
   * the button is the API's, and the bar is fed by §2.7's job rather than invented.
   */
  describe('the re-normalize trigger (§6.8, §9v)', () => {
    it('promises the count the API gave it, not one derived from the page', async () => {
      const { el } = await render();

      const button = [...el.querySelectorAll('ll-renormalize-settings button')].find((n) =>
        n.textContent?.includes('Re-read'),
      );
      expect(button?.textContent).toContain('326');
    });

    it('offers nothing to re-read on an empty database', async () => {
      api.transactions = 0;
      const { el } = await render();

      expect(el.querySelector('ll-renormalize-settings button')).toBeNull();
      expect(el.querySelector('ll-renormalize-settings')?.textContent).toContain(
        'nothing to re-read',
      );
    });

    it('starts the sweep and reports what it did', async () => {
      const { fixture, el } = await render();

      const button = [...el.querySelectorAll('ll-renormalize-settings button')].find((n) =>
        n.textContent?.includes('Re-read'),
      ) as HTMLButtonElement;
      button.click();
      await fixture.whenStable();

      expect(api.sweeps).toBe(1);
      // The notice names the count the API returned rather than the one on screen —
      // they should agree, and on the day they do not the user is owed the true one.
      expect(text(el, '.notice')[0]).toContain('326');
      expect(text(el, '.notice')[0]).toContain('recalculated');
    });

    /**
     * §2.7: "`GET /api/jobs/:id` reports `{ state, progress, message }`; the UI
     * polls." The bar shows the job's own message, so the phase named on screen is
     * the phase the runner is in rather than a percentage the page made up.
     */
    it('shows the job’s own progress while it runs', async () => {
      api.jobStates = ['running', 'running', 'succeeded'];
      const { fixture, el } = await render();

      const button = [...el.querySelectorAll('ll-renormalize-settings button')].find((n) =>
        n.textContent?.includes('Re-read'),
      ) as HTMLButtonElement;
      button.click();
      await fixture.whenStable();

      // `whenStable` returns before the poll's own wait, so this catches the bar
      // mid-sweep — which is the state worth asserting. The label is the *job's*
      // message verbatim, so what a user reads is the phase the runner is in rather
      // than a percentage this page invented.
      expect(el.querySelector('.progress')).not.toBeNull();
      expect(el.querySelector('.progress__label')?.textContent).toContain(
        're-normalized 130 of 326 transactions',
      );
      expect(el.querySelector('.progress__label')?.textContent).toContain('40%');
    });
  });
});

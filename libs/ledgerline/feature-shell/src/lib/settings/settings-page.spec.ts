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
import type { Settings, SettingsUpdate, UpdateSettingsBody, WipeResult } from '@metrum/api-client';

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
    databaseFile: 'C:/data/ledgerline.sqlite',
    backupDir: 'C:/data/backups',
    ...overrides,
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

      expect(groups).toContain('Duplicate and overlapping services §5.4');
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
      expect(text(el, '.group__title')).toContain('Shared emission policy §5.1');
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
      expect(text(el, '.field__name')).not.toContain('enabled');
      expect(text(el, '.field__name')).toContain('minOccurrences');
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
        (node) => node.previousElementSibling?.textContent?.trim() === 'minOccurrences',
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
        (node) => node.previousElementSibling?.textContent?.trim() === 'minOccurrences',
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

  it('states §6.8’s four unbuilt sections rather than omitting them', async () => {
    const { el } = await render();
    expect(text(el, '.pending dt')).toEqual([
      'LLM provider',
      'Redaction',
      'Merchant aliases',
      'Categories',
    ]);
    expect(text(el, '.pending dd')[0]).toContain('§2.4');
  });
});

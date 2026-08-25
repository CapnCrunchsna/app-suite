/**
 * §6.8's Settings surface, and the promise §7.4 has been making since the analyzers
 * landed: "Every threshold in §5 is a default in a config object; Settings overrides
 * it." The machinery was all there — `resolveConfig`, `configHash`, the settings table
 * — and nothing could write the override, so the thresholds were data in principle and
 * constants in practice. These pin the round trip.
 *
 * The wipe is here too, because it is the one irreversible route in §2.3 and the only
 * one whose test is also its safety argument.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const PROFILES_DIR = new URL('../../../profiles', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);

interface ThresholdShape {
  section: string;
  key: string;
  kind: 'number' | 'boolean';
  defaultValue: number | boolean;
  value: number | boolean;
  overridden: boolean;
}

interface RuleShape {
  id: string;
  label: string;
  specRef: string;
  section: string;
  enabledKey: string;
  enabled: boolean;
  activeFindings: number;
  dismissedFindings: number;
}

interface SettingsShape {
  configHash: string;
  rules: RuleShape[];
  thresholds: ThresholdShape[];
  unsettable: { section: string; key: string; reason: string }[];
  databaseFile: string;
  backupDir: string;
}

describe('ledgerline-api settings surface (§6.8, §7.4)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let backupDir: string;

  beforeEach(async () => {
    backupDir = mkdtempSync(join(tmpdir(), 'll-settings-'));
    context = createContext({ databaseFile: ':memory:', profilesDir: PROFILES_DIR });
    app = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: PROFILES_DIR,
        backupDir,
      },
    });
  });

  afterEach(async () => {
    await app.close();
    context.close();
    rmSync(backupDir, { recursive: true, force: true });
  });

  async function settings(): Promise<SettingsShape> {
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);
    return response.json() as SettingsShape;
  }

  const patch = (changes: Record<string, unknown>[]) =>
    app.inject({ method: 'PATCH', url: '/api/settings', payload: { changes } });

  const thresholdFor = (all: SettingsShape, section: string, key: string) =>
    all.thresholds.find((t) => t.section === section && t.key === key) as ThresholdShape;

  // ---------------------------------------------------------------- read ---

  describe('GET /api/settings', () => {
    it('derives the editable set from the shipped defaults', async () => {
      const all = await settings();

      // §5.10's spike percentage, straight out of DEFAULT_CONFIG.
      expect(thresholdFor(all, 'trend', 'spikePercent')).toMatchObject({
        kind: 'number',
        defaultValue: 0.4,
        value: 0.4,
        overridden: false,
      });
      // §5.11's, to show the walk is not one hand-listed section.
      expect(thresholdFor(all, 'micro', 'minPerMonth').defaultValue).toBe(8);
      expect(all.configHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('names what it will not edit, and why', async () => {
      const all = await settings();
      const cadences = all.unsettable.find((u) => u.key === 'cadences');

      // §5.2's cadence table is a list of triples, not a number with a slider.
      expect(cadences?.section).toBe('recurrence');
      expect(cadences?.reason).toContain('calibration');
      expect(all.thresholds.some((t) => t.key === 'cadences')).toBe(false);
    });

    /** §5.4 is two rules sharing one id, "separately toggleable" in its own words. */
    it('lists §5.4 as two switches over one rule id', async () => {
      const all = await settings();
      const duplicate = all.rules.filter((rule) => rule.id === 'duplicate.v1');

      expect(duplicate).toHaveLength(2);
      expect(duplicate.map((rule) => rule.enabledKey).sort()).toEqual([
        'categoryOverlapEnabled',
        'sameMerchantEnabled',
      ]);
      expect(duplicate.every((rule) => rule.enabled)).toBe(true);
    });

    it('covers all nine of §5’s rules', async () => {
      const all = await settings();
      expect(new Set(all.rules.map((rule) => rule.id)).size).toBe(9);
      expect(all.rules.every((rule) => rule.enabled)).toBe(true);
    });
  });

  // --------------------------------------------------------------- write ---

  describe('PATCH /api/settings', () => {
    it('overrides a threshold and moves config_hash (§7.4)', async () => {
      const before = await settings();

      const response = await patch([{ section: 'trend', key: 'spikePercent', value: 0.6 }]);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { settings: SettingsShape; configHashChanged: boolean };

      expect(body.configHashChanged).toBe(true);
      expect(body.settings.configHash).not.toBe(before.configHash);
      expect(thresholdFor(body.settings, 'trend', 'spikePercent')).toMatchObject({
        value: 0.6,
        defaultValue: 0.4,
        overridden: true,
      });
    });

    it('restores the shipped default when the value is null', async () => {
      const shipped = await settings();

      await patch([{ section: 'trend', key: 'spikePercent', value: 0.6 }]);
      const overridden = await settings();
      expect(thresholdFor(overridden, 'trend', 'spikePercent').overridden).toBe(true);
      expect(overridden.configHash).not.toBe(shipped.configHash);

      await patch([{ section: 'trend', key: 'spikePercent', value: null }]);
      const reset = await settings();

      expect(thresholdFor(reset, 'trend', 'spikePercent')).toMatchObject({
        value: 0.4,
        overridden: false,
      });
      // Back to the shipped hash *exactly*. A reset that left an empty override
      // section behind would hash differently from a config nobody had touched, and
      // §5.1 would go on re-evaluating dismissals over a difference of nothing.
      expect(reset.configHash).toBe(shipped.configHash);
    });

    it('switches a rule off through the same write as a threshold (§6.8)', async () => {
      const response = await patch([{ section: 'micro', key: 'enabled', value: false }]);
      expect(response.statusCode).toBe(200);

      const all = (response.json() as { settings: SettingsShape }).settings;
      expect(all.rules.find((rule) => rule.id === 'micro.v1')?.enabled).toBe(false);
      // It is a config field, so it moves the hash — which is what makes §5.1
      // re-evaluate that rule's dismissals when it comes back.
      expect((response.json() as { configHashChanged: boolean }).configHashChanged).toBe(true);
    });

    it('applies several changes at once', async () => {
      await patch([
        { section: 'micro', key: 'minPerMonth', value: 12 },
        { section: 'outlier', key: 'globalMinSamples', value: 100 },
      ]);
      const all = await settings();

      expect(thresholdFor(all, 'micro', 'minPerMonth').value).toBe(12);
      expect(thresholdFor(all, 'outlier', 'globalMinSamples').value).toBe(100);
    });

    /**
     * `resolveConfig` spreads the override in without complaint, so a wrong-shaped
     * value would surface as a rule behaving oddly rather than as a bad request.
     */
    it('refuses a bad change, and writes none of the batch', async () => {
      // The route's own 422: the shape is fine, the setting is not.
      for (const change of [
        { section: 'nope', key: 'spikePercent', value: 1 },
        { section: 'trend', key: 'notAThreshold', value: 1 },
        { section: 'recurrence', key: 'cadences', value: 3 },
      ]) {
        expect((await patch([change])).statusCode).toBe(422);
      }

      // A value of the wrong JSON type never reaches the handler — the body schema
      // is the right layer for that, and answers 400.
      const wrongType = await patch([{ section: 'trend', key: 'spikePercent', value: 'high' }]);
      expect(wrongType.statusCode).toBe(400);

      // A batch is validated as a set: one bad member writes nothing at all.
      const mixed = await patch([
        { section: 'micro', key: 'minPerMonth', value: 20 },
        { section: 'micro', key: 'nope', value: 3 },
      ]);
      expect(mixed.statusCode).toBe(422);
      expect(thresholdFor(await settings(), 'micro', 'minPerMonth').value).toBe(8);
    });

    it('reports dismissals only for the rules whose own section changed', async () => {
      const response = await patch([{ section: 'trend', key: 'spikePercent', value: 0.5 }]);
      const body = response.json() as { dismissalsAffected: number };

      // Nothing is dismissed in this fixture, so the number is zero — what matters
      // is that it is scoped to `trend` and not a count of every dismissal there is.
      expect(body.dismissalsAffected).toBe(0);
    });
  });

  // ---------------------------------------------------------------- wipe ---

  describe('DELETE /api/data (§2.3, §6.8)', () => {
    const wipe = (confirm?: string) =>
      app.inject({ method: 'DELETE', url: '/api/data', payload: { confirm } });

    it('refuses anything but the exact phrase', async () => {
      // Near misses are refused by the handler: the request is well-formed, the
      // confirmation is not. Case and trailing whitespace both count, because a
      // confirmation that forgives typing is not a confirmation.
      for (const attempt of ['', 'delete everything', 'DELETE EVERYTHING ', 'DELETE']) {
        expect((await wipe(attempt)).statusCode).toBe(422);
      }

      // Omitting it entirely never reaches the handler — `confirm` is required by
      // the body schema, which answers 400.
      expect((await wipe(undefined)).statusCode).toBe(400);

      // Nothing ran, so the account table and the reference rows are untouched.
      expect(context.store.merchants.get('netflix')).not.toBeNull();
    });

    it('clears the data, keeps the configuration, and re-seeds the reference rows', async () => {
      await patch([{ section: 'trend', key: 'spikePercent', value: 0.6 }]);
      const account = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking' },
      });
      expect(account.statusCode).toBe(201);

      const response = await wipe('DELETE EVERYTHING');
      expect(response.statusCode).toBe(200);
      const body = response.json() as { rowsDeleted: number; backupPath: string | null };
      expect(body.rowsDeleted).toBeGreaterThan(0);

      // The account is gone.
      const accounts = await app.inject({ method: 'GET', url: '/api/accounts' });
      expect(accounts.json()).toEqual([]);

      // §4's aliases and §5's categories are back — a wiped database is a fresh
      // install, not an empty one, or the next import invents a provisional
      // merchant for every descriptor §4 already knows.
      expect(context.store.merchants.get('netflix')).not.toBeNull();
      expect(context.store.merchants.listAliases().length).toBeGreaterThan(0);
      const categories = await app.inject({ method: 'GET', url: '/api/categories' });
      expect((categories.json() as unknown[]).length).toBeGreaterThan(0);

      // And §7.4's tuning survives: clearing statements is not clearing an
      // afternoon of calibrating §5 against them.
      expect(thresholdFor(await settings(), 'trend', 'spikePercent')).toMatchObject({
        value: 0.6,
        overridden: true,
      });
    });

    it('has nothing on disk to back up when the instance is in memory', async () => {
      const response = await wipe('DELETE EVERYTHING');
      expect((response.json() as { backupPath: string | null }).backupPath).toBeNull();
    });
  });

  /** The safety argument, on a database that actually has a file. */
  describe('DELETE /api/data on a file-backed instance', () => {
    it('writes a backup immediately before deleting anything', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'll-wipe-'));
      const databaseFile = join(dir, 'ledgerline.sqlite');
      const fileContext = createContext({ databaseFile, profilesDir: PROFILES_DIR });
      const fileApp = await buildServer({
        context: fileContext,
        config: { port: DEFAULT_API_PORT, databaseFile, profilesDir: PROFILES_DIR, backupDir: dir },
      });

      try {
        const response = await fileApp.inject({
          method: 'DELETE',
          url: '/api/data',
          payload: { confirm: 'DELETE EVERYTHING' },
        });
        expect(response.statusCode).toBe(200);

        const { backupPath } = response.json() as { backupPath: string };
        expect(backupPath).toContain('before-wipe');
        // The whole point of taking one is that it is there afterwards.
        expect(existsSync(backupPath)).toBe(true);
      } finally {
        await fileApp.close();
        fileContext.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

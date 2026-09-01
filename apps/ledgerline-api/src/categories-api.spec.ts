/**
 * §6.8's Categories section, over HTTP.
 *
 * Over real fixture bytes through the real import pipeline, for the reason
 * `transactions-api.spec.ts` gives — but here it earns its keep for a second reason
 * as well: every interesting case on this surface is about a *reference*, and a
 * reference only exists once something real points at a category. A hand-built row
 * would let the delete refusal pass without ever having met §3.2's constraint.
 *
 * Four properties are worth pinning, and they are the four this endpoint was written
 * for rather than the CRUD around them:
 *
 * - **A user edit survives the next boot.** `seedMerchants()` runs at every start-up
 *   and re-upserts the whole shipped taxonomy by id. Before migration 009 that
 *   silently reverted every rename, every kind change, and — the one that matters —
 *   every `overlap_group` back to NULL.
 * - **A category in use cannot be deleted**, and the refusal says by how much.
 * - **A kind change reports what it moves**, because §5.8 and §6.6 read `fee` and
 *   §5.10 reads `spend`.
 * - **`overlap_group` is §5.4's input**, and §9d records that its path has been dead
 *   since the analyzers landed. This is where it stops being dead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext, seedMerchants } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const workspaceRoot = new URL('../../../', import.meta.url);
const PROFILES_DIR = fileURLToPath(new URL('profiles', workspaceRoot));

interface CategoryShape {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
  overlapGroup: string | null;
  source: string;
}

interface UsageShape {
  category: CategoryShape;
  transactions: number;
  merchants: number;
  children: number;
  deletable: boolean;
}

describe('ledgerline-api categories (§6.8)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let accountId: string;

  async function importFixture(name: string): Promise<void> {
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL(`fixtures/statements/${name}`, workspaceRoot))),
    );
    const form = new FormData();
    form.append('files', new File([bytes], name, { type: 'text/csv' }));
    const encoded = new Request('http://localhost/api/imports', { method: 'POST', body: form });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/imports',
      payload: Buffer.from(await encoded.arrayBuffer()),
      headers: { 'content-type': encoded.headers.get('content-type') as string },
    });
    const [staged] = (uploaded.json() as { imports: { import: { id: string } }[] }).imports;

    await app.inject({ method: 'PATCH', url: `/api/imports/${staged.import.id}`, payload: { accountId } });
    const committed = await app.inject({
      method: 'POST',
      url: `/api/imports/${staged.import.id}/commit`,
      payload: {},
    });
    expect(committed.statusCode).toBe(200);
  }

  async function usage(): Promise<UsageShape[]> {
    const response = await app.inject({ method: 'GET', url: '/api/categories/usage' });
    expect(response.statusCode).toBe(200);
    return response.json() as UsageShape[];
  }

  async function usageOf(id: string): Promise<UsageShape> {
    return (await usage()).find((row) => row.category.id === id) as UsageShape;
  }

  /** Puts a real, imported row into a category, which is the only way anything
   *  points at one. §2.3's own "assign category" path, not a store write. */
  async function categorize(categoryId: string): Promise<string> {
    const listed = await app.inject({ method: 'GET', url: '/api/transactions?limit=1' });
    const [row] = (listed.json() as { rows: { transaction: { id: string } }[] }).rows;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${row.transaction.id}`,
      payload: { categoryId },
    });
    expect(patched.statusCode).toBe(200);
    return row.transaction.id;
  }

  beforeEach(async () => {
    context = createContext({ databaseFile: ':memory:', profilesDir: PROFILES_DIR });
    app = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: PROFILES_DIR,
        backupDir: '',
      },
    });

    accountId = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { displayName: 'Northgate Checking', accountType: 'checking', last4: '4821' },
      })
    ).json().id;

    await importFixture('northgate-checking-2026-01.csv');
  });

  afterEach(async () => {
    await app.close();
    context.close();
  });

  // ------------------------------------------------------------- reading ---

  describe('GET /api/categories/usage', () => {
    it('lists every category, including the ones nothing points at', async () => {
      const rows = await usage();

      // The shipped set, all of it — a zero is an answer, and omitting unused
      // categories would make "unused" indistinguishable from "missing".
      expect(rows.length).toBeGreaterThanOrEqual(16);
      expect(rows.every((row) => typeof row.transactions === 'number')).toBe(true);
      expect(rows.map((row) => row.category.source)).toContain('seed');
    });

    it('counts what refers to a category, and closes the delete when anything does', async () => {
      // A category nobody has had the chance to point at yet. Not a seed one —
      // §4's merchants ship with defaults, so most of the shipped taxonomy is
      // already referenced on a fresh install, which is itself the point of the
      // next case.
      const fresh = (
        await app.inject({
          method: 'POST',
          url: '/api/categories',
          payload: { name: 'Sundries', kind: 'spend' },
        })
      ).json() as CategoryShape;
      expect((await usageOf(fresh.id)).deletable).toBe(true);

      await categorize(fresh.id);

      const used = await usageOf(fresh.id);
      expect(used.transactions).toBe(1);
      expect(used.deletable).toBe(false);
    });

    /** `merchant_canonical.default_category_id` is the other reference, and it is
     *  the one a fresh install already has — §4's seed merchants carry defaults. */
    it('counts merchant defaults as use, not only transactions', async () => {
      const entertainment = await usageOf('entertainment');
      expect(entertainment.merchants).toBeGreaterThan(0);
      expect(entertainment.deletable).toBe(false);
    });
  });

  // ------------------------------------------------------------ creating ---

  describe('POST /api/categories', () => {
    it('creates a user category', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Music streaming', kind: 'spend', overlapGroup: 'music' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        name: 'Music streaming',
        kind: 'spend',
        overlapGroup: 'music',
        parentId: null,
        source: 'user',
      });
    });

    it('refuses a name that already exists, however it is cased', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: '  groceries ', kind: 'spend' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('duplicate_name');
    });

    it('refuses a blank name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: '   ', kind: 'spend' },
      });

      expect(response.statusCode).toBe(400);
    });

    /** An empty group would put every category carrying one into a single §5.4
     *  group named "", which is the loudest available wrong answer. */
    it('treats a blank overlap group as no group', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Stationery', kind: 'spend', overlapGroup: '  ' },
      });

      expect(response.json().overlapGroup).toBeNull();
    });
  });

  // ------------------------------------------------------------- editing ---

  describe('PATCH /api/categories/:id', () => {
    /**
     * The case migration 009 exists for.
     *
     * `seedMerchants()` runs at every boot and re-upserts `SEED_CATEGORIES` by id.
     * Without the `WHERE source = 'seed'` guard this is a rename that lasts until
     * the next restart, and — worse, because nothing on screen would say so — an
     * `overlap_group` that quietly goes back to NULL and takes §5.4's claim with it.
     */
    it('keeps a user edit through the next boot’s re-seed', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/categories/dining',
        payload: { name: 'Eating out', overlapGroup: 'meal_kit' },
      });

      seedMerchants(context.store);

      const dining = (await usageOf('dining')).category;
      expect(dining.name).toBe('Eating out');
      expect(dining.overlapGroup).toBe('meal_kit');
      expect(dining.source).toBe('user');
    });

    it('leaves an untouched seed category to the seed', async () => {
      const before = (await usageOf('groceries')).category;
      seedMerchants(context.store);

      expect((await usageOf('groceries')).category).toEqual(before);
      expect(before.source).toBe('seed');
    });

    /**
     * §5.8 and §6.6 select `kind = 'fee'`; §5.10 trends only `kind = 'spend'`. A
     * kind change moves every charge in the category between them, and a write that
     * did that silently would be the most consequential invisible edit in the app.
     */
    it('reports what a kind change re-partitions', async () => {
      await categorize('groceries');

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { kind: 'fee' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kindChangedFrom: 'spend',
        transactionsRepartitioned: 1,
        rulesAffected: ['fees.v1', 'trend.v1'],
      });
      expect(response.json().category.kind).toBe('fee');
    });

    it('says nothing about rules when nothing analytical moved', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { name: 'Food' },
      });

      expect(response.json()).toMatchObject({
        kindChangedFrom: null,
        transactionsRepartitioned: 0,
        rulesAffected: [],
      });
    });

    /** §5.4's input. Two categories in one group is the claim "these describe the
     *  same spending"; clearing it withdraws the claim. */
    it('assigns and clears §5.4’s overlap group', async () => {
      await app.inject({
        method: 'PATCH',
        url: '/api/categories/entertainment',
        payload: { overlapGroup: 'video_streaming' },
      });
      expect((await usageOf('entertainment')).category.overlapGroup).toBe('video_streaming');

      await app.inject({
        method: 'PATCH',
        url: '/api/categories/entertainment',
        payload: { overlapGroup: null },
      });
      expect((await usageOf('entertainment')).category.overlapGroup).toBeNull();
    });

    it('refuses a name another category already has', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { name: 'Transport' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('duplicate_name');
    });

    it('404s an unknown category', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/nope',
        payload: { name: 'Anything' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------ nesting ---

  /**
   * §3.1 gives `category` a `parent_id` and **nothing in §5 or §6 reads it** — no
   * rule sums a child into its parent. Two levels is therefore the honest limit:
   * the depth the editor can draw, and the depth beyond which the structure would
   * exist only to be ignored. §9ad records it.
   */
  describe('the two-level cap', () => {
    async function child(name: string, parentId: string): Promise<CategoryShape> {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name, kind: 'spend', parentId },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as CategoryShape;
    }

    it('allows one level of nesting', async () => {
      const streaming = await child('Streaming', 'entertainment');
      expect(streaming.parentId).toBe('entertainment');
      expect((await usageOf('entertainment')).children).toBe(1);
    });

    it('refuses a third level', async () => {
      const streaming = await child('Streaming', 'entertainment');
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Video', kind: 'spend', parentId: streaming.id },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('too_deep');
    });

    it('refuses to make a category with children into a child', async () => {
      await child('Streaming', 'entertainment');
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/entertainment',
        payload: { parentId: 'shopping' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('too_deep');
    });

    it('refuses a category as its own parent', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/categories/groceries',
        payload: { parentId: 'groceries' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s a parent that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/categories',
        payload: { name: 'Orphan', kind: 'spend', parentId: 'nope' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------ deleting ---

  describe('DELETE /api/categories/:id', () => {
    it('deletes one nothing points at, and tombstones it (§3.4)', async () => {
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/categories',
          payload: { name: 'Temporary', kind: 'spend' },
        })
      ).json() as CategoryShape;

      const response = await app.inject({ method: 'DELETE', url: `/api/categories/${created.id}` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ deletedId: created.id, reassignedTo: null });
      expect(await usageOf(created.id)).toBeUndefined();
      expect(context.store.tombstones.countFor('category')).toBe(1);
    });

    /**
     * §3.2's `ON DELETE RESTRICT` would refuse this anyway. The point of the
     * endpoint is that it refuses *legibly*: "FOREIGN KEY constraint failed" names
     * nothing the person can see, and this names the count and the way through.
     */
    it('refuses one in use, with the count and the way out', async () => {
      await categorize('groceries');

      const response = await app.inject({ method: 'DELETE', url: '/api/categories/groceries' });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBe('category_in_use');
      expect(body.message).toContain('1 charge');
      expect(body.message).toContain('reassignTo');
      expect(body.categoryUsage).toMatchObject({ transactions: 1 });
      // Nothing was deleted, and nothing was moved on the way to finding out.
      expect((await usageOf('groceries')).transactions).toBe(1);
    });

    it('moves what points at it, then deletes', async () => {
      const transactionId = await categorize('groceries');

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/categories/groceries?reassignTo=shopping',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        deletedId: 'groceries',
        reassignedTo: 'shopping',
        transactionsMoved: 1,
      });
      expect(await usageOf('groceries')).toBeUndefined();

      const moved = await app.inject({ method: 'GET', url: `/api/transactions/${transactionId}` });
      expect(moved.json().transaction.categoryId).toBe('shopping');
    });

    /** Only a root may have children, so a promotion is always legal where moving
     *  them under an arbitrary target would not be. */
    it('promotes subcategories to the top level rather than moving them', async () => {
      const streaming = (
        await app.inject({
          method: 'POST',
          url: '/api/categories',
          payload: { name: 'Streaming', kind: 'spend', parentId: 'entertainment' },
        })
      ).json() as CategoryShape;

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/categories/entertainment?reassignTo=shopping',
      });

      expect(response.json().childrenPromoted).toBe(1);
      expect((await usageOf(streaming.id)).category.parentId).toBeNull();
    });

    it('404s an unknown target', async () => {
      await categorize('groceries');
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/categories/groceries?reassignTo=nope',
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses to reassign a category to itself', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/categories/groceries?reassignTo=groceries',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});

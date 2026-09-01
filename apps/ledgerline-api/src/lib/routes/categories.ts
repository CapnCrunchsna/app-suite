/**
 * `/api/categories` — §6.8's "taxonomy editor and overlap-group assignment".
 *
 * §2.3's table lists one row here, `GET /api/categories`, added by §9a so §6.3 could
 * populate a dropdown. Everything else on this surface is new, and it exists because
 * §6.8 names a section that cannot be built from a read.
 *
 * ## The two halves are not the same weight
 *
 * Renaming a category, moving it under a parent and deleting an unused one are CRUD.
 * They are here because a taxonomy nobody can edit is a taxonomy that stays wrong.
 *
 * `overlap_group` is not CRUD. §5.4 defines it as "a curated subset of categories
 * where redundancy is meaningful", and two categories sharing one is the claim
 * *these describe the same spending* — the entire input to that rule's
 * category-overlap half. §9d records that the path has been dead since the
 * analyzers landed, because `SEED_CATEGORIES` deliberately left the column unset
 * rather than guess. This endpoint is how it stops being dead, and the guess is
 * still not the app's to make: a person makes it, one category at a time.
 *
 * ## Two things a write has to say out loud
 *
 * **A category in use cannot be deleted.** §3.2 RESTRICTs all three references and
 * would refuse anyway; what a constraint error cannot say is *how many* rows and
 * *what to do instead*. So the refusal carries the counts and names the escape
 * hatch, and `?reassignTo=` is that hatch — move the rows, then delete.
 *
 * **A kind change re-partitions the analyzers.** §5.8's fee rollup and §6.6's
 * Insights select `kind = 'fee'`; §5.10 trends only `kind = 'spend'`. Flipping one
 * moves every charge in the category between those with nothing on screen to say
 * so, which is why `PATCH` reports the count and the rules rather than returning a
 * row.
 *
 * ## Two levels, because nothing rolls up
 *
 * `parent_id` exists in §3.1 and **nothing in §5 or §6 reads it** — no rule sums a
 * child into its parent, and §5.10 trends each category id on its own. A deep
 * hierarchy would therefore be a structure the app displays and never uses. The
 * API caps it at two levels: a parent must itself be a root. That is the depth the
 * editor can draw, and an editor that cannot draw what it can create is how a
 * taxonomy becomes unnavigable. Recorded in §9ad.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CategoryUsage } from '@metrum/ledgerline-data';

import { errorResponses } from './errors.js';
import { CATEGORY_KINDS, ref } from './schemas.js';
import type { LedgerlineContext } from '../context.js';

type CategoryKind = (typeof CATEGORY_KINDS)[number];

/**
 * The rules that read `category.kind`, by the kind they read.
 *
 * Named here rather than derived, because the analyzers are on the other side of
 * §2.2's boundary and this is the composition root's job — the same argument that
 * carries §7.4's thresholds across. Kept in one place so a `PATCH` cannot report a
 * different set from the one §5 actually runs.
 */
const RULES_READING_KIND: Readonly<Record<CategoryKind, readonly string[]>> = {
  // §5.8: "keyword match on normalized descriptors **or** `category.kind = 'fee'`".
  // §6.6's fee rollup calls §5.8's own classifier, so it moves with it.
  fee: ['fees.v1'],
  // §5.10 skips any row whose category is not `spend`.
  spend: ['trend.v1'],
  transfer: [],
  income: [],
};

/** What a kind change alters the input of — the union of what it leaves and what it
 *  joins, because both change. */
function rulesAffectedByKind(from: CategoryKind, to: CategoryKind): string[] {
  return [...new Set([...RULES_READING_KIND[from], ...RULES_READING_KIND[to]])].sort();
}

/**
 * One space between words, none at the ends.
 *
 * A category called `"Groceries "` and one called `"Groceries"` are the same
 * category to a reader and two rows to `COLLATE NOCASE`, so the duplicate check
 * below would let both exist. Normalizing before the check is what makes the check
 * mean what it says.
 */
function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Empty is not a group. A blank string in `overlap_group` would put every category
 *  carrying one into a single §5.4 group named "", which is the loudest possible
 *  wrong answer. */
function cleanGroup(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}

export function registerCategoryRoutes(app: FastifyInstance, context: LedgerlineContext): void {
  app.get(
    '/api/categories',
    {
      schema: {
        summary: 'Spend categories',
        operationId: 'listCategories',
        tags: ['merchants'],
        response: {
          200: { type: 'array', items: ref('Category') },
          ...errorResponses,
        },
      },
    },
    async () => context.store.merchants.listCategories(),
  );

  /**
   * §6.8's editor read: the taxonomy plus what points at each row.
   *
   * A separate call from `GET /api/categories` rather than three more fields on it.
   * That list is §6.3's dropdown and is fetched on every Transactions page load;
   * counting every reference to every category to fill a `<select>` would be work
   * done for nobody. This is fetched by one screen, which is the screen that needs
   * it.
   */
  app.get(
    '/api/categories/usage',
    {
      schema: {
        summary: 'Every category with what refers to it',
        operationId: 'listCategoryUsage',
        description:
          'Spec 6.8’s taxonomy editor. `deletable` is the answer spec 3.2’s `ON DELETE ' +
          'RESTRICT` would give: false when any transaction, merchant default or ' +
          'subcategory still points here.',
        tags: ['merchants'],
        response: {
          200: { type: 'array', items: ref('CategoryUsage') },
          ...errorResponses,
        },
      },
    },
    async () =>
      context.store.merchants
        .categoryUsage()
        .map((usage) => ({ ...usage, deletable: inUse(usage) === 0 })),
  );

  app.post<{
    Body: {
      name: string;
      kind: CategoryKind;
      parentId?: string | null;
      overlapGroup?: string | null;
    };
  }>(
    '/api/categories',
    {
      schema: {
        summary: 'Create a category',
        operationId: 'createCategory',
        description:
          'Spec 6.8. The row is `source = "user"` and the boot re-seed will never ' +
          'overwrite it (migration 009).',
        tags: ['merchants'],
        body: {
          type: 'object',
          required: ['name', 'kind'],
          properties: {
            name: { type: 'string', minLength: 1 },
            kind: { type: 'string', enum: CATEGORY_KINDS },
            parentId: { type: ['string', 'null'] },
            overlapGroup: { type: ['string', 'null'] },
          },
        },
        response: { 201: ref('Category'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const name = cleanName(request.body.name);
      if (name === '') {
        return reply.code(400).send({ error: 'bad_request', message: 'name cannot be blank' });
      }
      if (context.store.merchants.findCategoryByName(name)) {
        return reply.code(409).send({
          error: 'duplicate_name',
          message: `a category called "${name}" already exists`,
        });
      }

      const parent = resolveParent(reply, request.body.parentId ?? null, null);
      if (parent === REJECTED) return reply;

      return reply.code(201).send(
        context.store.merchants.createCategory({
          name,
          kind: request.body.kind,
          parentId: parent,
          overlapGroup: cleanGroup(request.body.overlapGroup),
        }),
      );
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      kind?: CategoryKind;
      parentId?: string | null;
      overlapGroup?: string | null;
    };
  }>(
    '/api/categories/:id',
    {
      schema: {
        summary: 'Rename, reparent, re-kind or group a category',
        operationId: 'updateCategory',
        description:
          'Spec 6.8, including spec 5.4’s `overlapGroup`. A `kind` change is reported ' +
          'rather than performed silently: spec 5.8 and spec 6.6 read `fee` and spec 5.10 ' +
          'reads `spend`, so moving between them moves every charge in this category ' +
          'between those rules on the next analysis run. Any edit sets `source = "user"`, ' +
          'which is what stops the next boot’s re-seed from undoing it.',
        tags: ['merchants'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            kind: { type: 'string', enum: CATEGORY_KINDS },
            parentId: { type: ['string', 'null'] },
            overlapGroup: { type: ['string', 'null'] },
          },
        },
        response: { 200: ref('CategoryUpdate'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const existing = context.store.merchants.getCategory(id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', message: 'no such category' });
      }

      const name = request.body.name === undefined ? undefined : cleanName(request.body.name);
      if (name === '') {
        return reply.code(400).send({ error: 'bad_request', message: 'name cannot be blank' });
      }
      if (name !== undefined && context.store.merchants.findCategoryByName(name, id)) {
        return reply.code(409).send({
          error: 'duplicate_name',
          message: `a category called "${name}" already exists`,
        });
      }

      let parentId: string | null | undefined;
      if (request.body.parentId !== undefined) {
        const resolved = resolveParent(reply, request.body.parentId, id);
        if (resolved === REJECTED) return reply;
        parentId = resolved;
      }

      const kindMoved = request.body.kind !== undefined && request.body.kind !== existing.kind;

      const category = context.store.merchants.updateCategory(id, {
        name,
        kind: request.body.kind,
        parentId,
        overlapGroup:
          request.body.overlapGroup === undefined
            ? undefined
            : cleanGroup(request.body.overlapGroup),
      });

      return {
        category,
        kindChangedFrom: kindMoved ? existing.kind : null,
        // Counted after the write and over the same selector the analyzers use —
        // every row holding the foreign key, hidden or not, because §5.8 and §5.10
        // apply their own eligibility rules and this number is about the partition,
        // not about what either rule will keep.
        transactionsRepartitioned: kindMoved
          ? context.store.transactions.countMatching({
              categoryIds: [id],
              includeInternalTransfers: true,
              includeExcluded: true,
            })
          : 0,
        rulesAffected: kindMoved ? rulesAffectedByKind(existing.kind, category.kind) : [],
      };
    },
  );

  /**
   * Delete, and the one thing that makes this endpoint worth writing.
   *
   * §3.2's `ON DELETE RESTRICT` already refuses a category in use — the database is
   * not the problem. The problem is that a foreign-key error tells the user "FOREIGN
   * KEY constraint failed" about a thing they cannot see, on a screen that offered
   * them the button. So the count is taken first, the refusal names it, and the
   * refusal names the way through: `?reassignTo=` moves the rows to another category
   * and then deletes.
   *
   * Reassignment is not a second endpoint because it is not a second intention.
   * Nobody moves 42 charges to Groceries for its own sake; they do it because they
   * are deleting the category those charges are in, and splitting that into two
   * calls would let the first succeed and the second fail, leaving the user with a
   * merge they did not ask for.
   */
  app.delete<{ Params: { id: string }; Querystring: { reassignTo?: string } }>(
    '/api/categories/:id',
    {
      schema: {
        summary: 'Delete a category, optionally moving what points at it first',
        operationId: 'deleteCategory',
        description:
          'Refuses with `category_in_use` and the counts when anything still references ' +
          'it (spec 3.2). Pass `reassignTo` to move transactions and merchant defaults to ' +
          'another category first; subcategories are promoted to the top level rather ' +
          'than moved, since only a root may have children.',
        tags: ['merchants'],
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            reassignTo: {
              type: 'string',
              description: 'Category to move transactions and merchant defaults to.',
            },
          },
        },
        response: { 200: ref('CategoryDeleteResult'), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { reassignTo } = request.query;

      if (!context.store.merchants.getCategory(id)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such category' });
      }

      const usage = context.store.merchants
        .categoryUsage()
        .find((row) => row.category.id === id) as CategoryUsage;

      if (reassignTo === undefined) {
        if (inUse(usage) > 0) {
          return reply.code(409).send({
            error: 'category_in_use',
            message: describeUsage(usage),
            categoryUsage: {
              transactions: usage.transactions,
              merchants: usage.merchants,
              children: usage.children,
            },
          });
        }

        context.store.merchants.deleteCategory(id);
        return {
          deletedId: id,
          reassignedTo: null,
          transactionsMoved: 0,
          merchantsMoved: 0,
          childrenPromoted: 0,
        };
      }

      if (reassignTo === id) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'a category cannot be reassigned to itself',
        });
      }
      if (!context.store.merchants.getCategory(reassignTo)) {
        return reply.code(404).send({ error: 'not_found', message: 'no such target category' });
      }

      const moved = context.store.merchants.reassignCategory(id, reassignTo);
      context.store.merchants.deleteCategory(id);

      return {
        deletedId: id,
        reassignedTo: reassignTo,
        transactionsMoved: moved.transactions,
        merchantsMoved: moved.merchants,
        childrenPromoted: moved.children,
      };
    },
  );

  // ------------------------------------------------------------- helpers ---

  /**
   * The two-level cap, and the two ways to violate it.
   *
   * A sentinel rather than a thrown error: the route has already started composing a
   * reply, and Fastify's error handler would turn a throw here into a 500 for what is
   * a perfectly well-understood 400.
   */
  function resolveParent(
    reply: FastifyReply,
    parentId: string | null,
    selfId: string | null,
  ): string | null | typeof REJECTED {
    if (parentId === null) return null;

    if (parentId === selfId) {
      reply.code(400).send({ error: 'bad_request', message: 'a category cannot be its own parent' });
      return REJECTED;
    }

    const parent = context.store.merchants.getCategory(parentId);
    if (!parent) {
      reply.code(404).send({ error: 'not_found', message: 'no such parent category' });
      return REJECTED;
    }
    if (parent.parentId !== null) {
      reply.code(400).send({
        error: 'too_deep',
        message:
          `"${parent.name}" is already a subcategory, and the taxonomy is two levels deep. ` +
          'Nothing in the analyzers rolls a child into its parent, so a third level would ' +
          'be structure the app never reads.',
      });
      return REJECTED;
    }
    // A root gaining a parent while it still has children would make its children
    // depth three by the back door.
    if (
      selfId !== null &&
      (context.store.merchants.categoryUsage().find((row) => row.category.id === selfId)?.children ??
        0) > 0
    ) {
      reply.code(400).send({
        error: 'too_deep',
        message: 'this category has subcategories of its own, so it cannot become one',
      });
      return REJECTED;
    }

    return parentId;
  }
}

const REJECTED = Symbol('rejected');

function inUse(usage: CategoryUsage): number {
  return usage.transactions + usage.merchants + usage.children;
}

/** The refusal, in the terms the person is looking at rather than the constraint's. */
function describeUsage(usage: CategoryUsage): string {
  const parts: string[] = [];
  if (usage.transactions > 0) {
    parts.push(`${usage.transactions} ${usage.transactions === 1 ? 'charge' : 'charges'}`);
  }
  if (usage.merchants > 0) {
    parts.push(`${usage.merchants} ${usage.merchants === 1 ? 'merchant' : 'merchants'}`);
  }
  if (usage.children > 0) {
    parts.push(`${usage.children} ${usage.children === 1 ? 'subcategory' : 'subcategories'}`);
  }

  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  return (
    `this category is still used by ${list}. Pass reassignTo to move them to another ` +
    'category first, or change what points here and try again.'
  );
}

/**
 * The contract, and the two things that have to stay true of it.
 *
 * `openapi.json` is committed because "a contract that only exists in a build
 * output cannot be reviewed in a diff" (`src/openapi/emit.ts`). The corollary is
 * that a committed contract can go stale, and so can the client generated from
 * it — and a stale generated client is the worst of the three states, because it
 * type-checks perfectly against an API that no longer exists.
 *
 * These live in the API's suite rather than the client's for a reason §2.2 makes
 * structural: `api-client` may depend on nothing at all, so it cannot import the
 * routes it is generated from and could not check itself even in principle. The
 * API owns the contract, so the API owns the test that the contract is current.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { serializeOpenapiDocument } from './openapi/document.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const OPENAPI_PATH = fileURLToPath(new URL('../openapi.json', import.meta.url));

describe('the emitted OpenAPI contract', () => {
  it('matches the committed openapi.json', async () => {
    // Through the same function the emitter uses, so a difference in indentation
    // or a missing trailing newline cannot masquerade as a stale contract.
    const emitted = await serializeOpenapiDocument();
    const committed = readFileSync(OPENAPI_PATH, 'utf8');

    if (emitted !== committed) {
      throw new Error(
        'apps/ledgerline-api/openapi.json is stale against the route schemas.\n' +
          'Regenerate it with: npx nx build ledgerline-api',
      );
    }
    expect(emitted).toBe(committed);
  });

  it('names every operation, so the generated client never has to guess one', () => {
    const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    const missing: string[] = [];
    const seen = new Map<string, string>();

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const where = `${method.toUpperCase()} ${path}`;
        if (!operation.operationId) {
          missing.push(where);
          continue;
        }
        // A duplicate id is a silently overwritten client method, which is worse
        // than a missing one.
        const previous = seen.get(operation.operationId);
        if (previous) missing.push(`${where} reuses operationId from ${previous}`);
        seen.set(operation.operationId, where);
      }
    }

    expect(missing).toEqual([]);
  });

  it('describes every response it declares a 2xx for', () => {
    // Not every route has a response schema yet — the import review surface is
    // §6.1's work. What must not happen is a route declaring a 2xx it then
    // describes as an empty body, because Fastify would *serialize* it as one.
    const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };

    const empty: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        for (const [code, response] of Object.entries(operation.responses)) {
          if (!code.startsWith('2') || code === '204') continue;
          if (!response.content) empty.push(`${method.toUpperCase()} ${path} ${code}`);
        }
      }
    }

    // The two known holes, both on the import path and both out of §6.3's scope.
    expect(empty).toEqual(['POST /api/data/export 200']);
  });
});

describe('the generated api-client', () => {
  it('matches the committed openapi.json', () => {
    // Shelling out to the generator in `--check` mode rather than reimplementing
    // its comparison: the thing being tested is that *the generator's* output
    // matches what is committed, and a second implementation of that in a spec
    // would be a second thing to keep in step.
    try {
      execFileSync('node', ['tools/generate-api-client.mjs', '--check'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (cause) {
      const error = cause as { stderr?: string; stdout?: string };
      throw new Error(error.stderr?.trim() || error.stdout?.trim() || 'generator check failed');
    }
  });
});

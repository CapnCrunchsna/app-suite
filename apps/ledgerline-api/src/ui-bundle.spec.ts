/**
 * §9aj: this process serves the UI bundle at `/`, and must still be an API.
 *
 * These replace the preflight test §9ab left behind. That one asserted a CORS
 * header named every verb the routes use — a rule somebody had to remember to
 * extend for each new method, guarding a seam that no longer exists. What is
 * worth guarding now is the seam that does: a static handler sitting in front of
 * an API can shadow it, answer a missing asset with a page, or read a file the
 * bundle does not contain, and none of those is visible from a route test.
 *
 * The bundle here is four files in a temp directory rather than a real Angular
 * build, because everything under test is true of any directory — and a suite
 * that needed `nx build ledgerline-ui` to have run would fail for reasons that
 * have nothing to do with it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_API_PORT } from './lib/config.js';
import { createContext } from './lib/context.js';
import type { LedgerlineContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

const INDEX_HTML = '<!doctype html><html><body><ll-root></ll-root></body></html>';

describe('the UI bundle served at / (§9aj)', () => {
  let context: LedgerlineContext;
  let app: FastifyInstance;
  let bundle: string;
  let outside: string;

  beforeEach(async () => {
    outside = mkdtempSync(join(tmpdir(), 'll-outside-'));
    // Something worth stealing, one directory above the bundle root.
    writeFileSync(join(outside, 'ledgerline.sqlite'), 'not a real database', 'utf8');

    bundle = join(outside, 'browser');
    mkdirSync(join(bundle, 'assets'), { recursive: true });
    writeFileSync(join(bundle, 'index.html'), INDEX_HTML, 'utf8');
    writeFileSync(join(bundle, 'main-A1B2C3.js'), 'export const ok = 1;\n', 'utf8');
    writeFileSync(join(bundle, 'assets', 'logo.svg'), '<svg></svg>', 'utf8');

    context = createContext({ databaseFile: ':memory:', profilesDir: null });
    app = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: null,
        backupDir: '',
        uiDistDir: bundle,
      },
    });
  });

  afterEach(async () => {
    await app.close();
    context.close();
    rmSync(outside, { recursive: true, force: true });
  });

  it('serves index.html at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(INDEX_HTML);
  });

  it('serves an asset with a content type a browser will execute', async () => {
    const script = await app.inject({ method: 'GET', url: '/main-A1B2C3.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');

    const logo = await app.inject({ method: 'GET', url: '/assets/logo.svg?v=2' });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toContain('image/svg+xml');
  });

  /** §6's routes are client-side, so a reload on one has to reach the app. */
  it('answers a deep link with index.html so a refresh survives', async () => {
    const response = await app.inject({ method: 'GET', url: '/transactions?merchant=gym' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  /**
   * The whole point of registering this last. A fallback that answered `/api`
   * would turn every unknown route into a page, and every failed request into a
   * JSON parse error somewhere else entirely.
   */
  it('leaves /api alone, including the routes that do not exist', async () => {
    const real = await app.inject({ method: 'GET', url: '/api/health' });
    expect(real.statusCode).toBe(200);
    expect(real.json()).toMatchObject({ ok: true });

    const missing = await app.inject({ method: 'GET', url: '/api/not-a-route' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect(missing.json()).toMatchObject({ error: 'not_found' });
  });

  /** A missing asset is a broken build; a page in its place hides which. */
  it('404s a missing asset rather than serving the page for it', async () => {
    const response = await app.inject({ method: 'GET', url: '/main-OLDHASH.js' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });

  /**
   * This process has no authentication and the database sits a few directories
   * up from the bundle (§2.1), so the containment check is the only thing
   * between a crafted URL and the statements.
   */
  it('refuses to climb out of the bundle directory', async () => {
    for (const url of [
      '/../ledgerline.sqlite',
      '/%2e%2e/ledgerline.sqlite',
      '/assets/../../ledgerline.sqlite',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.body).not.toContain('not a real database');
    }
  });

  it('is not installed at all when nothing has been built', async () => {
    const bare = await buildServer({
      context,
      config: {
        port: DEFAULT_API_PORT,
        databaseFile: ':memory:',
        profilesDir: null,
        backupDir: '',
        uiDistDir: join(outside, 'never-built'),
      },
    });

    // Degrades to an API-only process rather than refusing to boot — the UI is
    // not a dependency of the backend.
    expect((await bare.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await bare.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);

    await bare.close();
  });
});

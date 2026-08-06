/**
 * Boot.
 *
 * Opening the store applies migrations (§3), seeding loads the shipped format
 * profiles and the §4.1 alias set, and then the server binds `127.0.0.1` — never
 * `0.0.0.0`. See `config.ts` for why the host is a constant rather than a
 * setting.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_HOST, configFromEnvironment } from './lib/config.js';
import { createContext } from './lib/context.js';
import { buildServer } from './lib/server.js';

/** `dist/main.js` and `src/main.ts` sit at the same depth under the app root,
 *  which sits two levels under the workspace root. */
const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

async function main(): Promise<void> {
  const config = configFromEnvironment(process.env, workspaceRoot);

  if (config.databaseFile !== ':memory:') {
    mkdirSync(dirname(config.databaseFile), { recursive: true });
  }

  const context = createContext({
    databaseFile: config.databaseFile,
    profilesDir: config.profilesDir,
  });

  for (const error of context.profileLoadErrors) {
    process.stderr.write(`format profile skipped — ${error}\n`);
  }

  const app = await buildServer({ context, config, logger: true });

  const shutdown = async (): Promise<void> => {
    await app.close();
    context.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: API_HOST, port: config.port });
  app.log.info(`ledgerline-api on http://${API_HOST}:${config.port} — database ${config.databaseFile}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});

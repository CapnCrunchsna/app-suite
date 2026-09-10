/**
 * Dev only. `ledgerline-api` serves the built bundle at `/` (§9aj), so the app's
 * API base URL is the empty string and every request is a same-origin `/api/...`.
 * This is what makes `nx serve ledgerline-ui` match that: the browser only ever
 * talks to 4200, the API needs no CORS allow-list, and the same base URL is
 * correct in both arrangements.
 *
 * **`.mjs` rather than `.json` because the port is configurable.** `config.ts`
 * honours `LEDGERLINE_PORT` (the host is deliberately fixed at loopback), and a
 * JSON proxy could only hardcode 4310 — so moving the API would silently break
 * the dev server while production carried on working, which is the exact shape
 * of bug this change set out to remove. Edgeline's equivalent is JSON because
 * its port is a constant 8000.
 *
 * Run the dev server with the same `LEDGERLINE_PORT` the API has:
 *
 *     LEDGERLINE_PORT=4399 npx nx serve ledgerline-api
 *     LEDGERLINE_PORT=4399 npx nx serve ledgerline-ui
 */

const port = process.env['LEDGERLINE_PORT'] ?? '4310';

export default {
  '/api': {
    target: `http://127.0.0.1:${port}`,
    secure: false,
    changeOrigin: false,
  },
};

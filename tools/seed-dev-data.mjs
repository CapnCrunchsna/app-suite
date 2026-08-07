/**
 * Put the committed fixture statements in front of a running API.
 *
 *   npx nx serve ledgerline-api          # in one terminal
 *   npm run seed:dev                     # in another
 *
 * Drives the real §6.1 sequence over HTTP — `POST /api/imports` (multipart),
 * `PATCH /api/imports/:id` to confirm the guessed account, then
 * `POST /api/imports/:id/commit` — because that is the only path that produces rows
 * the §4 normalization chain actually ran over. Nothing here writes to the database
 * directly, which is the point: seeding through the API means the dev database and
 * a real import differ in their contents and nothing else.
 *
 * Idempotent, by §3.3's layer one: re-running it re-uploads byte-identical files,
 * which short-circuit rather than double-inserting.
 *
 * The fixtures are committed and synthetic. The database this fills lives under
 * `data/`, which is gitignored and must never hold anything else.
 */

import { readFileSync } from 'node:fs';

const BASE = process.env['LEDGERLINE_URL'] ?? 'http://127.0.0.1:4310';

async function json(path, init) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch (cause) {
    throw new Error(
      `cannot reach the API at ${BASE} — start it with \`npx nx serve ledgerline-api\`\n` +
        `  (${cause.message})`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  }
  return text === '' ? null : JSON.parse(text);
}

async function ensureAccount(account) {
  const existing = await json('/api/accounts');
  const found = existing.find((a) => a.displayName === account.displayName);
  if (found) return found.id;

  const created = await json('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  });
  return created.id;
}

async function importFixture(filename, accountId, body = {}) {
  const bytes = readFileSync(`fixtures/statements/${filename}`);

  const form = new FormData();
  form.append('files', new File([bytes], filename, { type: 'text/csv' }));

  const uploaded = await json('/api/imports', { method: 'POST', body: form });
  const [staged] = uploaded.imports;

  // §3.3 layer one: a byte-identical re-upload returns the existing import.
  if (!staged.created) {
    console.log(`  ${filename}: already imported (${staged.import.status})`);
    return;
  }

  // §6.1: the guessed account "must be confirmed", and commit refuses without one.
  await json(`/api/imports/${staged.import.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });

  const result = await json(`/api/imports/${staged.import.id}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log(`  ${filename}: +${result.rowsInserted} inserted, ${result.rowsDuplicate} merged`);
}

const checking = await ensureAccount({
  displayName: 'Northgate Checking',
  institution: 'Northgate Bank',
  accountType: 'checking',
  last4: '4821',
});

const card = await ensureAccount({
  displayName: 'Cardinal Card',
  institution: 'Cardinal Card',
  accountType: 'credit_card',
  last4: '9012',
});

const savings = await ensureAccount({
  displayName: 'Harbor Savings',
  institution: 'Harbor Bank',
  accountType: 'savings',
  last4: '3355',
});

console.log('importing:');
await importFixture('northgate-checking-2026-01.csv', checking);
await importFixture('northgate-checking-2026-02.csv', checking);
// The card's $0.00 trial authorization is refused unless the reviewer says it is
// one — §3.2 allows $0 only for trials, and everything else is a misparse.
await importFixture('cardinal-card-2026-01.csv', card, {
  allowZeroAmountRows: true,
});
await importFixture('harbor-savings-2026-01.csv', savings);

const health = await json('/api/health');
const merchants = await json('/api/merchants');
const provisional = merchants.filter((m) => m.source === 'rule').length;

console.log(`\n${health.transactions} transactions, ${merchants.length} merchants`);
console.log(
  `${provisional} provisional (§4.1 step 7 — these are what §6.3's bulk correction is for), ` +
    `${merchants.length - provisional} resolved`,
);

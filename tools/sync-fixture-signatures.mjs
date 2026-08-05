#!/usr/bin/env node
/**
 * Recompute `headerSignature` / `headerTokens` for the bundled fixture profiles.
 *
 * A profile is keyed on the hash of its header row (§3.1, `header_signature` UNIQUE),
 * so editing a fixture's header invalidates its profile. Run this after touching a
 * fixture rather than transcribing a sha256 by hand.
 *
 *   node tools/sync-fixture-signatures.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeStatementText, detectCsvFormat } from '@app-suite/ledgerline-parsing';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const PAIRS = [
  ['fixtures/statements/northgate-checking-2026-01.csv', 'profiles/northgate-checking.json'],
  ['fixtures/statements/cardinal-card-2026-01.csv', 'profiles/cardinal-card.json'],
  ['fixtures/statements/harbor-savings-2026-01.csv', 'profiles/harbor-savings.json'],
];

let failed = false;

for (const [csvPath, profilePath] of PAIRS) {
  const text = decodeStatementText(readFileSync(resolve(ROOT, csvPath)));
  const detection = detectCsvFormat(text, []);

  if (detection.kind === 'undetectable') {
    console.error(`FAIL ${csvPath}: ${detection.reason}`);
    failed = true;
    continue;
  }

  const absolute = resolve(ROOT, profilePath);
  const profile = JSON.parse(readFileSync(absolute, 'utf8'));
  profile.headerSignature = detection.signature.signature;
  profile.headerTokens = detection.signature.tokens;
  writeFileSync(absolute, `${JSON.stringify(profile, null, 2)}\n`);

  console.log(
    `${profilePath}\n  signature ${detection.signature.signature.slice(0, 16)}…  skipLines=${detection.skipLines}  [${detection.signature.tokens.join(', ')}]`
  );
}

process.exit(failed ? 1 : 0);

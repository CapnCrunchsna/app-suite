#!/usr/bin/env node
/**
 * parse-statement — run the ingest → detect → parse → normalize path over one CSV and
 * print what came out. Writes nothing, anywhere.
 *
 * This is the standalone answer to "a script that will handle the parsing of statements
 * for me", and it is also how a new bank gets a profile: point it at an unrecognized
 * file and it prints the header signature, the sample rows and a starter profile you
 * can fill in. The in-app column mapper (§6.1) replaces this workflow in v0.2.
 *
 * Usage:
 *   npm run build
 *   node tools/parse-statement.mjs <file.csv> [options]
 *
 * Options:
 *   --profile <id|path>   Force a specific profile instead of matching by signature.
 *   --profiles-dir <dir>  Where to load profiles from (default: ./profiles).
 *   --account <id>        Account id used to compute dedupe keys (default: the profile id).
 *   --json                Emit the full result as JSON instead of a table.
 *   --limit <n>           Show at most n rows in the table (default: all).
 *   --trace <n>           Print the per-stage normalization trace for row n.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

let parsing;
let domain;
let normalize;
try {
  parsing = await import('@metrum/ledgerline-parsing');
  domain = await import('@metrum/ledgerline-domain');
  normalize = await import('@metrum/ledgerline-normalize');
} catch (error) {
  console.error('Could not load the Ledgerline libraries. Build them first:\n');
  console.error('  npm run build\n');
  console.error(String(error.message ?? error));
  process.exit(2);
}

const {
  detectCsvFormat,
  decodeStatementText,
  loadProfile,
  parseCsvWithProfile,
  sniffFileKind,
} = parsing;
const { collapseV1, dedupeKey, DEDUPE_KEY_VERSION, formatCents } = domain;
const { normalizeDescriptor, SEED_ALIASES, SEED_MERCHANT_KEYS } = normalize;

function parseArgs(argv) {
  const args = { file: null, profile: null, profilesDir: null, account: null, json: false, limit: Infinity, trace: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--profiles-dir') args.profilesDir = argv[++i];
    else if (arg === '--account') args.account = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--trace') args.trace = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (!arg.startsWith('--')) args.file ??= arg;
  }
  return args;
}

function loadProfiles(dir) {
  if (!existsSync(dir)) return [];
  const loaded = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      console.error(`! ${name}: not valid JSON — ${error.message}`);
      continue;
    }
    const result = loadProfile(raw);
    if (!result.ok) {
      console.error(`! ${name}: invalid profile`);
      for (const error of result.errors) console.error(`    - ${error}`);
      continue;
    }
    loaded.push({ profile: result.profile, path, warnings: result.warnings });
  }
  return loaded;
}

function pad(value, width) {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function padStart(value, width) {
  const s = String(value);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function truncate(value, width) {
  const s = String(value);
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`;
}

function describeResolution(resolution) {
  return resolution.kind === 'alias'
    ? `${resolution.merchantId} (${resolution.matchType}/${resolution.source})`
    : `${truncate(resolution.name, 28)} (provisional)`;
}

function printUnmatched(detection, file) {
  console.log(`\n  ${basename(file)} — format not recognized (this is the needs_mapping case in §2.5)\n`);
  if (detection.kind === 'undetectable') {
    console.log(`  Could not read it as a delimited file: ${detection.reason}`);
    return;
  }

  console.log(`  header signature : ${detection.signature.signature}`);
  console.log(`  delimiter        : ${JSON.stringify(detection.delimiter)}`);
  console.log(`  header on line   : ${detection.headerLineNumber}`);
  console.log(`  columns          : ${detection.signature.tokens.map((t) => `"${t}"`).join(', ')}`);

  if (detection.suggestions.length > 0) {
    console.log('\n  Similar known profiles (confirm before using — a wrong amount column poisons every finding):');
    for (const s of detection.suggestions) {
      console.log(`    ${(s.similarity * 100).toFixed(0)}%  ${s.profile.id}  (${s.profile.institution})`);
    }
  }

  if (detection.sampleRows.length > 0) {
    console.log('\n  First rows:');
    for (const row of detection.sampleRows) {
      console.log(`    ${row.map((c) => truncate(c, 24)).join(' | ')}`);
    }
  }

  const scaffold = {
    id: `${basename(file).replace(/\.[^.]+$/, '')}-v1`,
    institution: 'CHANGE ME',
    accountTypeHint: 'checking',
    headerSignature: detection.signature.signature,
    headerTokens: detection.signature.tokens,
    hasHeader: true,
    delimiter: detection.delimiter,
    skipLines: detection.skipLines,
    dateFormat: 'MM/DD/YYYY',
    amountMode: 'single',
    signConvention: 'as_is',
    columnMap: {
      transactionDate: 'CHANGE ME',
      description: 'CHANGE ME',
      amount: 'CHANGE ME',
    },
    pendingValues: ['pending'],
    version: 1,
    source: 'user',
  };

  console.log('\n  Starter profile — fill in the CHANGE ME fields and save under profiles/:\n');
  console.log(
    JSON.stringify(scaffold, null, 2)
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')
  );
  console.log('\n  See docs/statement-parsing.md for what each field means.');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    console.log(`
  parse-statement — run ingest → detect → parse → normalize over one CSV. Writes nothing.

  Usage:
    node tools/parse-statement.mjs <file.csv> [options]

  Options:
    --profile <id|path>   Force a profile instead of matching on the header signature.
    --profiles-dir <dir>  Where to load profiles from (default: ./profiles).
    --account <id>        Account id used to compute dedupe keys (default: the profile id).
    --json                Emit the full result as JSON instead of a table.
    --limit <n>           Show at most n rows in the table.
    --trace <n>           Print the per-stage normalization trace for row n.

  Point it at an unrecognized file and it prints the header signature, sample rows and a
  starter profile to fill in.
`);
    process.exit(args.file ? 0 : 1);
  }

  const filePath = resolve(args.file);
  if (!existsSync(filePath)) {
    console.error(`No such file: ${filePath}`);
    process.exit(1);
  }

  const bytes = readFileSync(filePath);
  const kind = sniffFileKind(bytes);
  if (kind === 'pdf') {
    console.error(
      `${basename(filePath)} is a PDF. PDF ingest is v0.4 (pdfjs-dist positional extraction with\n` +
        `column inference) and is not built yet — this tool handles CSV only.`
    );
    process.exit(1);
  }

  const text = decodeStatementText(bytes);
  const profilesDir = args.profilesDir ? resolve(args.profilesDir) : join(WORKSPACE_ROOT, 'profiles');
  const available = loadProfiles(profilesDir);

  let profile = null;
  if (args.profile) {
    const byId = available.find((p) => p.profile.id === args.profile);
    if (byId) {
      profile = byId.profile;
    } else if (existsSync(resolve(args.profile))) {
      const result = loadProfile(JSON.parse(readFileSync(resolve(args.profile), 'utf8')));
      if (!result.ok) {
        console.error('Profile is invalid:');
        for (const error of result.errors) console.error(`  - ${error}`);
        process.exit(1);
      }
      profile = result.profile;
    } else {
      console.error(`No profile with id or path "${args.profile}". Known ids: ${available.map((p) => p.profile.id).join(', ') || '(none)'}`);
      process.exit(1);
    }
  } else {
    const detection = detectCsvFormat(text, available.map((p) => p.profile));
    if (detection.kind === 'matched') {
      profile = detection.profile;
    } else {
      printUnmatched(detection, filePath);
      process.exit(3);
    }
  }

  const result = parseCsvWithProfile({ text, profile });
  const accountId = args.account ?? profile.id;

  const normalized = result.rows.map((row) =>
    normalizeDescriptor(row.descriptionRaw, {
      aliases: SEED_ALIASES,
      knownMerchantKeys: SEED_MERCHANT_KEYS,
      trace: args.trace !== null,
    })
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          file: basename(filePath),
          profile: { id: profile.id, institution: profile.institution, accountTypeHint: profile.accountTypeHint },
          accountId,
          dedupeKeyVersion: DEDUPE_KEY_VERSION,
          periodStart: result.periodStart,
          periodEnd: result.periodEnd,
          periodDeclared: result.periodDeclared,
          parser: result.parser,
          parserVersion: result.parserVersion,
          balanceCheck: result.balanceCheck,
          rows: result.rows.map((row, i) => ({
            ...row,
            descriptionNormalized: normalized[i].descriptionNormalized,
            merchant: normalized[i].resolution,
            isP2P: normalized[i].isP2P,
            collapsed: collapseV1(row.descriptionRaw),
            dedupeKey: dedupeKey({
              accountId,
              effectiveDate: row.effectiveDate,
              amountCents: row.amountCents,
              descriptionRaw: row.descriptionRaw,
            }),
          })),
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n  ${basename(filePath)}`);
  console.log(`  profile ${profile.id} · ${profile.institution} · ${profile.accountTypeHint ?? 'unknown type'}`);
  console.log(`  ${result.rows.length} rows parsed, ${result.errors.length} failed · period ${result.periodStart ?? '—'} → ${result.periodEnd ?? '—'} (${result.periodDeclared ? 'declared by the statement' : 'from row dates'})\n`);

  console.log(
    `  ${pad('DATE', 11)}${padStart('AMOUNT', 12)}  ${pad('MERCHANT', 34)}${pad('RAW DESCRIPTOR', 40)}`
  );
  console.log(`  ${'-'.repeat(11)}${'-'.repeat(12)}  ${'-'.repeat(34)}${'-'.repeat(40)}`);

  result.rows.slice(0, args.limit).forEach((row, i) => {
    const flag = row.status === 'pending' ? ' *' : '  ';
    console.log(
      `  ${pad(row.effectiveDate, 11)}${padStart(formatCents(row.amountCents), 12)}${flag}${pad(truncate(describeResolution(normalized[i].resolution), 33), 34)}${truncate(row.descriptionRaw, 40)}`
    );
  });

  if (result.rows.length > args.limit) {
    console.log(`  … ${result.rows.length - args.limit} more`);
  }

  const inflow = result.rows.filter((r) => r.status !== 'pending' && r.amountCents > 0).reduce((a, r) => a + r.amountCents, 0);
  const outflow = result.rows.filter((r) => r.status !== 'pending' && r.amountCents < 0).reduce((a, r) => a + r.amountCents, 0);
  const pending = result.rows.filter((r) => r.status === 'pending').length;

  console.log(`\n  in ${formatCents(inflow)} · out ${formatCents(outflow)} · net ${formatCents(inflow + outflow)}`);
  if (pending > 0) {
    console.log(`  ${pending} pending row(s), marked * — stored and shown, excluded from every analyzer and total (§2.5)`);
  }

  const check = result.balanceCheck;
  const signSuspect = result.warnings.find((w) => w.kind === 'sign_convention_suspect');

  if (check.kind === 'reconciled') {
    console.log(
      `\n  ✓ running balance reconciles across ${check.rowsChecked} rows (${check.order} order)` +
        `\n    the amount column is mapped correctly and no rows are missing`
    );
    // Reconciliation is blind to an inverted signConvention: the inversion is applied to
    // the balance too, so both sides flip and the identity still holds. Saying otherwise
    // would give false confidence in exactly the setting that inverts every number.
    console.log(
      signSuspect
        ? `    ⚠ but the sign convention looks backwards — see the warning below`
        : `    (this does not verify signConvention; balances look plausible for the account type)`
    );
  } else if (check.kind === 'mismatch') {
    console.log(`\n  ✗ running balance does NOT reconcile (best: ${check.bestOrder}, ${check.failureCount} of ${check.rowsChecked} rows disagree)`);
    for (const f of check.failures.slice(0, 5)) {
      console.log(`      row ${f.rowIndex}: balance moved ${formatCents(f.expectedCents)} but amount says ${formatCents(f.actualCents)}`);
    }
    if (check.failureCount > 5) {
      console.log(`      … and ${check.failureCount - 5} more`);
    }
    console.log(`    every row disagreeing usually means the sign convention is inverted;`);
    console.log(`    a handful usually means rows are missing from the export.`);
  }

  if (result.errors.length > 0) {
    console.log(`\n  ${result.errors.length} row(s) failed to parse:`);
    for (const error of result.errors.slice(0, 10)) {
      console.log(`    line ${error.lineNumber}: ${error.errors.join('; ')}`);
      console.log(`      ${truncate(error.rawText, 88)}`);
    }
  }

  const notable = result.warnings.filter((w) => w.kind !== 'pending_row');
  if (notable.length > 0) {
    console.log(`\n  warnings:`);
    for (const warning of notable) {
      console.log(`    [${warning.kind}] ${warning.message}`);
    }
  }

  if (args.trace !== null) {
    const row = result.rows[args.trace];
    if (!row) {
      console.log(`\n  no row at index ${args.trace}`);
    } else {
      console.log(`\n  normalization trace for row ${args.trace}:`);
      console.log(`    raw: ${row.descriptionRaw}`);
      for (const stage of normalized[args.trace].trace) {
        const changed = stage.before === stage.after ? '   ' : ' → ';
        console.log(`    ${stage.stage}. ${pad(stage.name, 30)}${changed}${stage.after}`);
      }
      console.log(`    collapse_v1 (frozen, dedupe only): ${collapseV1(row.descriptionRaw)}`);
    }
  }

  console.log('');
}

main();

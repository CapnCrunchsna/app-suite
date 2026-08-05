# app-suite

The Nx monorepo for the Angular/TypeScript UIs and Ionic/Capacitor mobile apps, with polyglot
backends wired via Nx `run-commands`. See [`CLAUDE.md`](CLAUDE.md) for what lives here and the
stack defaults.

Currently bootstrapped by **Ledgerline**, a locally run financial-statement analyzer. Its
contract is [`docs/ledgerline-spec.md`](docs/ledgerline-spec.md); the plan artifact is one
level up at `artifacts/plans/ledgerline-design.md`.

## What exists today

The CSV ingest path — `ingest → detect → parse → normalize` from spec §2.5. No database, no
API, no UI yet.

```
libs/ledgerline/
  domain/      types, Money (integer cents), ISO dates, the frozen collapse_v1 + dedupe key
  parsing/     ParserPort, header-signature detection, format profiles, the CSV parser
  normalize/   the seven-stage deterministic merchant chain (no LLM)
fixtures/statements/   synthetic CSVs in three disagreeing bank shapes
profiles/              format profiles, keyed on a header-row hash
tools/                 the parse-statement CLI
```

## Getting started

```bash
npm install
npm run build
node tools/parse-statement.mjs fixtures/statements/northgate-checking-2026-01.csv
```

`npm run check` runs the boundary lint, typecheck and tests. The lint is part of that pipeline
deliberately: spec §2.2's module boundaries are enforced by `@nx/enforce-module-boundaries`
tags, and an unrun lint rule is not enforcement.

[`docs/statement-parsing.md`](docs/statement-parsing.md) covers the profile schema, how to add
a bank, and what has not been validated against a real statement.

## Real statement files

`data/` and `*.sqlite` are gitignored. Real statements go in `data/` — never in `fixtures/`,
which is committed and synthetic.

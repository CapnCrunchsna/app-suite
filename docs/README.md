# app-suite/docs

Documents that **must be true of the code at this commit** live here, so a spec and the
implementation it governs version atomically and land in the same commit. This is the
workspace rule from `../../CLAUDE.md`, and the reason the Chip Away build spec sits at
`games/chip-away/docs/build-spec.md` rather than in `artifacts/`.

**Goes here:** implementation specs, data-model and schema references, API contracts,
analyzer rule definitions with their thresholds, phase signoffs — anything that goes stale
the moment the code changes.

**Stays an artifact** under `../../artifacts/`, on the dashboard: plans, roadmaps, designs,
charters, reports, revenue models. These inform the code but do not change with it.

A doc that lives here can still be a registered dashboard artifact. Register it with the
`create-artifact` skill, passing `--type` explicitly — the script infers type from the
parent folder, and `docs` is not one of `plans|reports|designs`:

```bash
node ../../scripts/new-artifact.mjs app-suite/docs/some-spec.md --type plans --project "Ledgerline" --desc "…"
```

Then verify with `node ../../scripts/check-artifacts.mjs`.

## Current contents

- **`ledgerline-spec.md`** — the Ledgerline build specification: Nx layout and
  module-boundary tags, HTTP API, LLM provider seam, parse-to-analyze pipeline, SQLite schema,
  merchant normalization chain, the nine analyzer rules with their thresholds, and the
  page-level UI contract. Registered on the dashboard; its companion plan artifact is
  `../../artifacts/plans/ledgerline-design.md`.
- **`statement-parsing.md`** — implementation notes for the CSV ingest path: the
  format-profile schema, the `parse-statement` CLI, how to add a bank, the five places the
  code deliberately departs from the spec, and what has and has not been validated against a
  real statement. Not yet registered on the dashboard.

## Why the Ledgerline design was split

An earlier note here provisionally kept that design whole as a plan artifact, on the grounds
that no code exists in this repo yet for a spec to version against, and proposed splitting
§3–§7 out once v0.1 scaffolds Nx. **That call was overturned on 2026-08-03** during an
adversarial audit of the design, and the split happened then. The reasoning, in full, is in §3
of the plan artifact; in short:

- The rule sorts documents **by kind, not by whether the code exists yet**. A schema, an
  ESLint `depConstraints` block and nine numeric analyzer thresholds are true-or-false of an
  implementation the moment one exists — and this README's own "goes here" list names exactly
  those things.
- This repo has **zero commits**, so moving now lands the spec in the initial commit — the
  cleanest atomic landing available. Deferring would leave the commits that scaffold Nx,
  define the tags and write the first migrations governed by a document in a different
  repository, which is the window the rule exists to close.
- The cost of a cross-repo move only grows. The document is quiet and the target repo is empty
  today; neither will be true again.

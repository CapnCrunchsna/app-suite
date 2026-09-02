# Ledgerline — Build Specification

The implementation contract for Ledgerline: Nx layout and module boundaries, the HTTP
API, the LLM provider seam, the parse-to-analyze pipeline, the SQLite schema, the merchant
normalization chain, the nine analyzer rules with their thresholds, and the page-level UI
contract. Everything here must be true of the code in this repository at this commit. The
concept, the locked decisions, the roadmap and the open questions live in the companion plan
artifact, `artifacts/plans/ledgerline-design.md`.

**Section map — navigation only, non-normative.** §1 status & provenance · §2 architecture
(Nx layout, HTTP API, LLM seam, parse-to-analyze pipeline) · §3 data model (SQLite schema) ·
§4 merchant normalization · §5 analyzer specs (the nine rules and thresholds) · §6 UI
contract · §7 cross-cutting rules · §8 changes from the design session · §9 and §9a–§9r
amendments from implementation, oldest first · §10 open discrepancies, recorded not resolved.

## 1. Status and provenance

**Status: partially implemented.** The Nx workspace exists with its §2.2 tags and boundary
lint; the CSV half of §2.5's `ingest → detect → parse → normalize` path is built in
`libs/ledgerline/{domain,parsing,normalize}`; as of 2026-08-06 the persistence and
import-commit half is built too — the whole of §3 (schema, indexes, constraints, idempotent
re-import) in `libs/ledgerline/data`, and the import, account, transaction and data endpoints
of §2.3 in `apps/ledgerline-api`; and as of 2026-08-07 the **first UI page** is built —
§6.3's Transactions page in `libs/ledgerline/feature-shell`, with `POST /api/transactions/bulk`
behind it and `libs/shared/api-client` genuinely generated from the emitted contract. As of
2026-08-11 §6.1's **Import page** is built on the same lib — the dropzone, the review table
with its duplicate and near-duplicate dispositions, the warning strip, the commit gate, the
inline column mapper over `POST /api/format-profiles/preview`, and the import history. Also as
of 2026-08-11, `libs/ledgerline/analyzers` exists with §5.1's shared finding contract, §7.4's
config-and-hash machinery, and **five of §5's nine rules** — recurrence (§5.2, §5.3) and the
four that build on the series it produces: duplicate and overlap (§5.4), price creep (§5.5),
trial conversions (§5.6) and cancellation confirmation (§5.7). `analyze()` composes them over
one snapshot with §2.2's row guard. As of 2026-08-14 those rules **run over stored data**:
§2.7's in-process job runner, `buildSnapshot()`, finding and series persistence with §5.1's
upsert-by-natural-key lifecycle, and §2.3's `POST /api/analysis/run`, `GET /api/findings`,
`GET /api/findings/summary`, `POST /api/findings/:id/state` and `/api/dismissal-rules`. As of
2026-08-19 §6.4's **Findings page** — the one §6 calls the hero — is built on those endpoints,
with the three headline numbers, per-rule grouping, the three-scope dismissal picker and inline
evidence; it is where the app now opens. As of 2026-08-21 **§2.6's transfer matcher runs**, and
§6.2's **Accounts page** is built for the half of it that needs a human: the matcher is a pure
function in `analyzers` with §2.6's scoring table, its bipartite assignment and its
partial-payment pass, `transfer_link` / `transfer_rule` persistence in `data`, and the link
stage runs on every commit and at the head of every analysis run — so a credit-card payment
stops being counted as spending. The page carries §6.2's coverage bar, its four account
actions, and the Possible Transfers queue with both rows, the score's reasons and the dollar
effect of confirming. `GET /api/accounts/:id/coverage`, `POST /api/accounts/:id/merge` and
§2.3's three transfer endpoints are behind it. Also as of 2026-08-21 **§5 is complete**: the
four remaining rules — fees and interest (§5.8), outlier charges (§5.9), category trends
(§5.10) and high-frequency small spend (§5.11) — are built alongside the five that were, and
`analyze()` composes all nine over one snapshot. They need no UI work of their own: §6.4 groups
by rule, so they appear on the Findings page as they are.

As of 2026-08-23 **§5.10's `trend.v1` and §5.11's `micro.v1` are no longer silent**, because the
two pipeline stages they were starved by now feed them. §9g recorded that both rules were
correct and emitted nothing: they restrict themselves to §7.2's fully-covered months, which
almost nothing qualified as while `period_start`/`period_end` came from row dates rather than a
declared statement period (§9f), and §5.10 additionally needs a `category_id`, which nothing
assigned. **The parser now reads a declared period** — an optional `period_pattern` on
`format_profile`, matched against the preamble — and **§2.5's `normalize` stage now assigns a
category by rule**, from the resolved merchant's `default_category_id`, stamped
`category_source = 'rule'` with §4.3's `user` precedence honoured on every path. Neither rule
changed; both fire over a multi-year corpus and produce the numbers §5.10 and §5.11 describe,
and §6.2's coverage bar, which rendered every month `partial`, now goes green on an ordinary
statement. §9h records the six decisions this took.

As of 2026-08-25 §6.5's **Subscriptions page** is built, on §2.3's three `/api/series` routes —
the recurring ledger sorted by annual cost, the month strip, and the detail drawer with the
charge history, the price-step table and §6.5's three user-owned fields, where "a manual status
always beats the computed one" holds through to §6.4's headline. `recurring_series` now carries
the charge list and price steps `recurrence.v1` had been computing and discarding (migration
`005`), because §5.3 forbids re-deriving them downstream. §6.4's "Open subscription" action
**navigates** rather than explaining its own absence.

As of 2026-08-25 §6.8's **Settings page** is built on §2.3's `/api/settings`, and with it §7.4
stops being a promise: every threshold in §5 is editable with its shipped default beside it, the
current `config_hash` is on the page, and each rule has a switch that moves that hash — so §5.1
re-evaluates the rule's dismissals when it comes back. §2.3's `DELETE /api/data` is built
alongside it and takes its own backup before deleting anything. §9k recorded that one of that
page's six sections could not be built at all; **as of 2026-09-01 all six are built**, the last
being **Categories** — a taxonomy editor and, with it, the first way anything has ever written
§5.4's `overlap_group`, which §9d recorded as a dead path. §9ad records what that needed.

§4.1 step 7's **review queue reached a person on 2026-08-27** as a section of that page (§9r)
and **moved off it the next day** into **§6.9's Review page**, with a count in the rail — a
queue nobody knows is non-empty is a queue nobody answers, and Settings is a door people open
twice a year. §6.9 is a section of §6 this implementation added rather than found; §9s records
the move, the badge, and where the count lives.

**§2.4's provider seam is wired as of 2026-08-28**, and with it §6.8's LLM provider and
Redaction sections, §4.2's merchant-proposal stage, and the degraded-call log in Data — §9t.
`none` remains the default and the app is complete without a provider (§2.4).

PDF ingest is **not** built, nor are the merchant-alias endpoints of
§2.3 — §2.3's **review queue is built** as of 2026-08-27, and §9p
records what it proposes — — **every one of §6's nine pages now exists**. §6.1's Import, §6.2's Accounts,
§6.3's Transactions, §6.4's Findings, §6.5's Subscriptions, §6.6's Insights,
§6.7's Ask, §6.8's Settings and §6.9's Review exist and are all reachable from the
rail. `docs/statement-parsing.md` records what has and has not been validated.
§9, §9a, §9b, §9c, §9d, §9e, §9f, §9g, §9h, §9i, §9j, §9k, §9l, §9m, §9n, §9o, §9p, §9q, §9r, §9s, §9t, §9u, §9v, §9w, §9x, §9y, §9z, §9aa, §9ab, §9ac, §9ad and §9ae list the amendments
implementation made to this document.

Every number in this document is still a *designed* threshold, not a measured one; the
calibration note in §7.6 says what has to happen to each of them once real statements are in
the database. **The first real statement was parsed on 2026-08-26** — a Chase credit-card
export, 326 rows over eight months, through `profiles/chase-card.json` with no parse failures.
It has not calibrated anything: §7.6 asks for "a hand-labelled year of real statements with the
expected findings written down", and one unlabelled statement from one account is not that. What
it did do is falsify three rules that no synthetic fixture had reached — two corrected in §9l and
§5.2's grouping in §9m — and expose a silent gap in §4.1's processor-prefix table, corrected in
§9n and §9o. It also opened one tension, recorded in §10 and closed there by §9m. Every threshold in §5
remains a designed number.

This document was extracted from §3–§7 of the design session artifact on 2026-08-03, under
the workspace rule in `../../CLAUDE.md` § Version control — *must it be true of the code at
this commit?* It is, so it lives in this repo and versions with the code. The extraction was
part of an adversarial audit of that design; §8 lists every substantive change the audit
made, and the plan artifact carries the reasoning.

Section numbers changed in the move. The mapping, for anyone following a citation written
before 2026-08-03:

| Design artifact | This document |
|---|---|
| §3 Architecture | §2 |
| §4 Data model | §3 |
| §5 Merchant normalization | §4 |
| §6 Analyzer specs | §5 |
| §7 UI | §6 |
| — | §7 Cross-cutting rules (new) |

## 2. Architecture

### 2.1 Nx layout

The monorepo does not exist yet. The first phase begins with `npx create-nx-workspace@latest`
(Angular preset) inside `app-suite/`, per that folder's `CLAUDE.md`, and this app is generated
into it. Two shared libs get stubbed immediately because they are workspace-wide commitments,
not app-local ones.

```
app-suite/
  apps/
    ledgerline-ui/        Angular 18+, standalone components, signals
    ledgerline-api/       Node/TS, Fastify, binds 127.0.0.1. Composition root.
    ledgerline-api-e2e/
    ledgerline-parser-py/         (conditional) FastAPI + pdfplumber
  libs/
    ledgerline/
      domain/                    types, value objects, Money, DateRange. Zero deps.
      parsing/                   ParserPort, CSV profiles, PDF extraction, format detection
      normalize/                 merchant cleanup chain, alias resolution, categorization
      analyzers/                 the nine rules + the transfer matcher; pure functions, no I/O
      data/                      repository interfaces + SQLite impl + migrations
      llm/                       LlmProvider interface + claude-cli | ollama | none
      feature-shell/             UI routing shell and page components
    shared/
      ui/                        workspace-wide Angular components (stubbed here)
      api-client/                generated TS client from the OpenAPI schema
```

**Libs compute; the app persists.** `parsing`, `normalize` and `analyzers` are pure: they take
values in and return values out. Nothing in `libs/ledgerline/` except `data` may write.
The API app is the composition root that wires a pure result into a repository call. This is
not a style preference — §2.2 makes it a lint error, and §2.5's pipeline table assigns stage
*ownership* on that basis.

### 2.2 Module boundaries

Boundaries are enforced by Nx tags and `@nx/enforce-module-boundaries`, not by convention.
This is the single most load-bearing piece of the design, because it is what makes the later
Elasticsearch move mechanical instead of a rewrite.

`@nx/enforce-module-boundaries` matches on **tags**, so two libs that share a tag necessarily
share a constraint. Every lib therefore gets a **distinct** `type:` tag; a shared `type:util`
across `parsing`, `normalize` and `analyzers` would force their union of allowances and
silently permit `analyzers` to import `data`, which is the one thing this section exists to
prevent. Every lib also carries a `scope:` tag, because this monorepo will hold Meal Planner,
Photo-to-Calendar and Edgeline alongside this app, and scope isolation is the other half of
the job.

| Lib | tags | May depend on | Hard rule |
|---|---|---|---|
| `domain` | `scope:ll`, `type:domain` | nothing | Pure types and arithmetic. No I/O, no framework. |
| `parsing` | `scope:ll`, `type:parsing` | `type:domain` | Produces `RawRow[]`. **Never** touches the database. |
| `normalize` | `scope:ll`, `type:normalize` | `type:domain`, `type:llm` | Deterministic chain first; LLM strictly optional. Returns values, never writes. |
| `analyzers` | `scope:ll`, `type:analyzers` | `type:domain` | **Never** imports `data` or `llm`. Snapshot in, `Finding[]` / `LinkProposal[]` out. |
| `data` | `scope:ll`, `type:data-access` | `type:domain` | The only lib that knows a store exists. Named methods, never raw query strings from callers. |
| `llm` | `scope:ll`, `type:llm` | `type:domain` | No knowledge of statements or findings; it moves strings. |
| `feature-shell` | `scope:ll`, `type:feature` | `type:domain`, `type:ui`, `type:api-client` | No direct `data`/`analyzers` imports — everything through HTTP. |
| `ui` | `scope:shared`, `type:ui` | `type:ui` | Presentational only. |
| `api-client` | `scope:shared`, `type:api-client` | nothing | Generated. Never hand-edited. |
| `ledgerline-api` | `scope:ll`, `type:app` | every `scope:ll` lib | Composition root. The only place the pure libs meet `data`. |
| `ledgerline-ui` | `scope:ll`, `type:app` | `type:feature`, `type:ui`, `type:api-client`, `type:domain` | Shell only. |

The corresponding ESLint rule, which is the actual contract:

```json
"depConstraints": [
  { "sourceTag": "scope:ll",       "onlyDependOnLibsWithTags": ["scope:ll", "scope:shared"] },
  { "sourceTag": "scope:shared",   "onlyDependOnLibsWithTags": ["scope:shared"] },
  { "sourceTag": "type:domain",    "onlyDependOnLibsWithTags": [] },
  { "sourceTag": "type:parsing",   "onlyDependOnLibsWithTags": ["type:domain"] },
  { "sourceTag": "type:normalize", "onlyDependOnLibsWithTags": ["type:domain", "type:llm"] },
  { "sourceTag": "type:analyzers", "onlyDependOnLibsWithTags": ["type:domain"] },
  { "sourceTag": "type:data-access","onlyDependOnLibsWithTags": ["type:domain"] },
  { "sourceTag": "type:llm",       "onlyDependOnLibsWithTags": ["type:domain"] },
  { "sourceTag": "type:feature",   "onlyDependOnLibsWithTags": ["type:domain", "type:ui", "type:api-client"] },
  { "sourceTag": "type:ui",        "onlyDependOnLibsWithTags": ["type:ui"] },
  { "sourceTag": "type:api-client","onlyDependOnLibsWithTags": [] },
  { "sourceTag": "type:app",       "onlyDependOnLibsWithTags": ["*"] }
]
```

Two constraints are load-bearing enough to have their own test: `type:analyzers` must not
reach `type:llm` (§2.4's invariant depends on it) and `type:analyzers` must not reach
`type:data-access` (§2.2's purity claim depends on it). A lint rule that nobody runs is not
enforcement — the boundary lint is a required target in the default build pipeline.

**Tags say which libs may meet. They say nothing about which runtime the code lands in.**
`feature-shell` is allowed to depend on `domain` and should be — that is where `formatCents`
lives. But `domain` also holds §3.3's dedupe key, which hashes with `node:crypto`, so a
single `export *` barrel handed a Node builtin to every Angular page that wanted a number
formatted. `domain` therefore ships **two entry points**: `@metrum/ledgerline-domain` is
loadable in any runtime, and `@metrum/ledgerline-domain/node` is the half that is not. The
split is by platform rather than by feature so the rule for a new file is mechanical — if it
imports `node:*`, it goes behind `/node`. Nothing enforces that but the build, which is why
`build` is one of the targets `npm run check` runs (§9j).

**Analyzers as pure functions over a full snapshot.** A heavy household is six accounts ×
120 months × ~80 transactions ≈ 58,000 transactions, which hydrates to roughly 60 MB of
JavaScript objects. That fits in memory with two orders of magnitude to spare, and in
exchange every rule is unit-testable with a literal array of transactions and zero database
fixtures. Three conditions make the claim survive contact with real data:

- **One snapshot per run, not one per analyzer.** `buildSnapshot()` runs once; the nine rules receive the same frozen object. Nine independent loads would be nine times the query cost and nine times the peak memory.
- **The transfer matcher (§2.6) must be indexed, not quadratic.** A naive all-pairs scan over 58,000 rows is 3.4 billion comparisons. Bucket by `(abs(amount_cents), floor(date/86400))` first; only compare within a bucket and its ±7-day neighbours.
- **A guard, not a hope.** `analysis_run` records the snapshot row count. Above 250,000 rows the run logs a warning; above 1,000,000 it refuses and points at date-range scoping. The design is allowed to have a ceiling — it is not allowed to have an undiscovered one.

The scaling risk in this design is not the analyzers. It is the re-normalize job (§4.3),
which re-runs the chain and the full analysis on every merchant correction; §2.7 makes it a
coalesced background job for exactly that reason.

### 2.3 API surface

Fastify, JSON only, OpenAPI schema emitted at build time and used to generate
`shared/api-client`. Chosen over Express for native TS types, schema-based validation and
serialization out of the box, and a clean Nx build target.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/imports` | Upload one or more files. Returns staged import ids; does not commit. |
| `GET` | `/api/imports/:id` | Staged parse result: rows (paginated), detected profile, duplicates, near-duplicates, warnings. |
| `PATCH` | `/api/imports/:id` | Set account, apply/override a column mapping, re-parse. Rejects if already committed. |
| `POST` | `/api/imports/:id/commit` | Insert rows into `transaction`. Idempotent. Body carries per-row near-duplicate resolutions. |
| `DELETE` | `/api/imports/:id` | Remove the import and the rows for which it is the last remaining source (§3.3). |
| `GET` | `/api/format-profiles` · `POST` · `PATCH /:id` | Column-mapping profiles keyed on header signature. |
| `POST` | `/api/format-profiles/match` | Fuzzy-match a header signature against known profiles (§9.2 in the plan). |
| `GET` | `/api/accounts` · `POST` · `PATCH /:id` | Account CRUD. |
| `GET` | `/api/accounts/:id/coverage` | Per-month statement coverage for the coverage bar (§6.2). |
| `POST` | `/api/accounts/:id/merge` | Merge another account into this one; re-points transactions and imports. |
| `GET` | `/api/transactions` | Filter, search, paginate. Includes `hasFinding` via `finding_evidence`. |
| `GET` | `/api/transactions/:id` | One transaction, the imports that cover it, and the verbatim statement line each of those printed — §6.3's row expander. |
| `PATCH` | `/api/transactions/:id` | Assign merchant/category, mark transfer, exclude. A merchant assignment writes a `user` alias and enqueues a re-normalize (§4.3). |
| `POST` | `/api/transactions/bulk` | Apply one change to a filter-matched set. `?dryRun=true` returns the match count only — this is what backs the UI's "apply to all 47 matching". |
| `GET` | `/api/merchants` · `PATCH /:id` · `POST /api/merchants/aliases` | Canonical merchants and alias management. |
| `GET` | `/api/categories` | Spend categories, for §6.3's category filter and inline assignment. |
| `GET` | `/api/categories/usage` | Every category with what points at it, and whether §3.2 would let it be deleted — §6.8's taxonomy editor. Separate from the list above because that one is a dropdown and a dropdown does not need three counts per entry (§9ad). |
| `POST` | `/api/categories` · `PATCH /:id` | Create and edit, including §5.4's `overlapGroup`. A `kind` change returns how many charges it re-partitions and which rules read the column — §5.8 and §6.6 read `fee`, §5.10 reads `spend`. Any edit makes the row `source = 'user'`, which is what stops the boot re-seed undoing it. |
| `DELETE` | `/api/categories/:id` | Refuses with a count while anything still points at it (§3.2). `?reassignTo=` moves the charges and merchant defaults first; subcategories are promoted to the top level. |
| `GET` | `/api/merchants/review-queue` | **Merge candidates**, provisional merchants, and sub-floor LLM proposals awaiting a decision. A merge candidate is a pair of merchants the chain resolved separately and cannot itself tell apart — §9p. Read-only: it proposes, and §4.3 owns every write. |
| `POST` | `/api/merchants/:id/merge` | Treat this merchant as another one, retroactively. Writes a `user` alias for every descriptor spelling of `:id` and enqueues §4.3's re-normalize job. The answer to a merge candidate above, and the only write on this surface — §9q. |
| `POST` | `/api/transfers/propose` · `POST /api/transfers/:id/confirm` · `DELETE /api/transfers/:id` | Transfer link proposals and their resolution (§2.6). |
| `POST` | `/api/analysis/run` | Enqueue an analysis run. Returns a job id (§2.7). |
| `GET` | `/api/findings` · `GET /api/findings/summary` | List with filters (rule, band, status, account, min annual impact); summary backs the three headline numbers. |
| `POST` | `/api/findings/:id/state` | Acknowledge / snooze / dismiss **this finding**. |
| `GET` | `/api/dismissal-rules` · `POST` · `DELETE /:id` | Merchant-scoped and rule-scoped dismissals (§5.1). |
| `GET` | `/api/series` · `GET /api/series/:id` · `PATCH /api/series/:id` | Recurring subscriptions, charge history, and the user fields: cancellation URL, notes, manual status override. |
| `GET` | `/api/insights/*` | `categories`, `movers`, `fees`, `outliers`, `small-spend`. |
| `POST` | `/api/ask` | Q&A. `409` with a machine-readable reason when provider is `none`. |
| `GET` | `/api/settings` · `PATCH` · `GET /api/llm/health` | Config, analyzer thresholds, provider health probe. |
| `POST` | `/api/jobs/renormalize` · `GET /api/jobs/:id` · `GET /api/jobs` | Long-running work and its progress (§2.7). |
| `POST` | `/api/data/backup` · `POST /api/data/export` · `DELETE /api/data` | SQLite file copy, JSON/CSV export, wipe. |

### 2.4 The LLM provider interface

```ts
export type LlmCapability = 'complete' | 'json';

export interface LlmProvider {
  readonly id: 'claude-cli' | 'ollama' | 'none';
  /** Drives the UI warning. True only for claude-cli. */
  readonly sendsDataOffMachine: boolean;
  capabilities(): LlmCapability[];
  health(): Promise<{ ok: boolean; detail: string; model?: string }>;
  complete(req: CompleteRequest): Promise<string>;
  completeJson<T>(req: JsonRequest<T>): Promise<T>;   // schema-validated
}
```

**`ClaudeCliProvider`** — spawns `claude -p --output-format json` and writes the prompt to
**stdin**, never to argv. That is both an argument-length and an injection concern: statement
text is untrusted input and must never be interpolated into a command line. Concurrency is
pinned to 1, with a 90s default timeout and hard process kill on expiry. The JSON envelope is
parsed for the result text; a non-zero exit, malformed envelope, or timeout all raise
`LlmUnavailableError`. `sendsDataOffMachine = true`.

**`OllamaProvider`** — `POST http://127.0.0.1:11434/api/chat`, using Ollama's `format: 'json'`
mode for `completeJson`. Model is configurable; default is a small instruct model. Health check
hits `/api/tags` and verifies the configured model is actually pulled — a common failure that
otherwise surfaces as a confusing 404. `sendsDataOffMachine = false`.

**`NoneProvider`** — `capabilities()` returns `[]`, `health()` returns
`{ ok: false, detail: 'LLM disabled' }`, and both call methods throw `LlmUnavailableError`
immediately. It is a real implementation, not a null, so the degradation path is exercised
rather than special-cased.

**No feature calls a provider directly.** Everything goes through:

```ts
llmAssist(() => provider.completeJson({...}), deterministicFallback)
```

Any throw, timeout, or schema-validation failure yields the fallback and records a
degraded-call event visible in Settings.

**The `none`-mode invariant, stated correctly.** The design session asserted that findings are
byte-identical with and without a provider, verified by running the analyzer battery twice
over one snapshot. That claim is false and that test is a tautology. The analyzers never call
a provider — §2.2 makes it a lint error — so swapping the provider under a fixed snapshot
cannot change anything, and the test passes without exercising the risk. The actual influence
path runs one stage earlier and is *persisted* before the analyzers ever start: an LLM-authored
`merchant_alias` changes which descriptors resolve to which `merchant_id`, and every rule in §5
groups by canonical merchant. An LLM-assigned `category_id` likewise changes §5.8 (fees, via
`category.kind`), §5.9 (per-category outliers), §5.10 (category trends) and the overlap half of
§5.4 (via `overlap_group`). LLM output changing findings is not a leak to be plugged — it is
the entire point of normalization. What must be true is narrower and testable:

- **Completeness.** With the provider set to `none`, every rule still runs and can still emit, using only inputs with `source ∈ {seed, rule, user}`. No rule is provider-gated.
- **No branch on provenance.** No analyzer reads a `source` column or behaves differently because a value came from a model. Provenance is metadata for the UI, never an input to a threshold.
- **No silent authority.** A finding whose evidence depends on any `source='llm'` alias or category carries `llm_dependent = true`, is badged in the UI as resting on an AI-suggested grouping, and has its confidence **capped at Medium** until the underlying alias is user-confirmed. High confidence is reserved for groupings a human or a seed vouched for.
- **No rewriting of settled history.** An LLM alias that would merge or split a `recurring_series` with `occurrence_count ≥ 3` never auto-applies, regardless of its confidence. It goes to the review queue.

**The tests that actually verify this**, replacing the parity suite:

- **T1 — provenance ablation.** Over a database with LLM aliases applied, run the analyzers twice: once with the full alias set, once with every `source='llm'` alias stripped so those rows fall back to their rule-normalized provisional merchants. Assert (a) the ablated run is non-empty for every rule that fires in the full run, (b) every finding in the ablated run survives into the full run with the same `rule_id` and subject, and (c) the diff is emitted as the run's *LLM-attributable finding set* for review. A regression that lets a model suppress a deterministic finding fails (b).
- **T2 — determinism under fixed input.** `analyze(snapshot, config)` run 100× over a frozen snapshot returns byte-identical `Finding[]`, ordering included. This catches map-iteration order and float drift, which is what the original suite tested by accident.
- **T3 — boundary.** `analyzers` has no dependency edge to `llm` or `data`. A lint assertion, not a runtime test.

**Caching.** Every call is keyed by `sha256(provider + model + prompt)` into `llm_cache`. The
Claude CLI path costs seconds per call, so caching is what makes bulk merchant normalization
tolerable and makes runs reproducible.

**Redaction.** The redaction pass strips account numbers and last4 before any call — and also
**counterparty names**, which are the most sensitive strings on a statement and are not account
numbers. Descriptors matching the P2P prefix list (`ZELLE`, `VENMO`, `CASH APP`, `SQUARE CASH`,
`PAYPAL *` where the tail is not in the known-merchant table, `CHECK #`) are **never sent to a
provider at all**: the counterparty is a person, not a merchant, and normalization has nothing
to gain from them. This is a hard filter, not a redaction, because a partially-masked personal
name is still a personal name.

### 2.5 The parsing pipeline

```
ingest → detect → parse → normalize → link → dedupe → store → analyze
```

Stage *ownership* below names the lib that holds the logic. Per §2.1, only `data` writes; the
API app calls the pure stage and hands the result to a repository.

| Stage | Logic in | What happens |
|---|---|---|
| **ingest** | api | File hashed (`sha256`), stored as a `statement_import` in `uploaded` state. A hash already present short-circuits the whole pipeline — idempotency layer one. |
| **detect** | `parsing` | Sniff PDF vs CSV. For CSV, hash the header row into a *format signature* and look up a `format_profile`. For PDF, extract text and match against known statement headers. Unmatched CSV → `needs_mapping`, which surfaces the mapping UI. |
| **parse** | `parsing` | Profile-driven extraction into `RawRow[]` (transaction date, posted date, description, amount, optional balance, optional status) plus the verbatim source line, preserved in `raw_row`. |
| **normalize** | `normalize` | Description → `description_normalized` → canonical merchant (§4). Amount sign coerced to the house convention. Dates coerced to ISO. Category assigned by rule, then optionally by LLM. |
| **link** | `analyzers` (match) + `data` (persist) | Propose internal-transfer pairs (§2.6). Confirmed pairs are flagged and excluded from spend analytics so a credit-card payment isn't counted as spending. |
| **dedupe** | `data` | Row-level idempotency via the multiset merge rule (§3.3) — idempotency layer two, which handles overlapping statement date ranges. |
| **store** | `data` | Transactional commit of the whole import. Partial imports never land. |
| **analyze** | `analyzers` (compute) + `data` (persist) | Snapshot in, findings out, upserted by natural key so user state survives (§5.1). |

**Dates.** `transaction` carries both `posted_date` and `transaction_date` because statements
disagree about which they print. Everything downstream uses
`effective_date = COALESCE(transaction_date, posted_date)`, including the dedupe key and every
cadence calculation in §5. Using posted dates for cadence would inject two days of
weekend-shift noise into every monthly series and force wider cadence windows than the data
warrants; using transaction dates keeps the windows honest.

**Pending rows never analyze.** A CSV pulled mid-cycle contains authorizations that have not
settled; the same charge later posts on a different date and often a different amount (a tip
turns a $50.00 pending into a $59.00 posted). `RawRow` therefore carries an optional `status`
and `transaction` carries `is_pending`. Pending rows are stored, shown in the UI, and excluded
from every analyzer and every total. When a later import produces a posted row that matches a
pending one (§3.3's near-duplicate window), the pending row is superseded rather than kept.

**Review before commit.** Parsing lands in a staging state and the user sees the parsed rows,
flagged duplicates, near-duplicates, and any warnings *before* anything enters the transaction
table. This is a data-integrity decision as much as a UX one: a silently misparsed amount
column poisons every downstream finding, and it is very hard to notice after the fact.

**The `ParserPort` seam.**

```ts
export interface ParserPort {
  id: string;
  canParse(file: FileMeta, sample: Uint8Array): Promise<number>;  // 0..1 confidence
  parse(file: FileMeta, bytes: Uint8Array): Promise<ParseResult>;
}
```

**`parse` returns a `ParseResult`, not `RawRow[]`** — the rows that parsed, the rows that did
not, the warnings, the detected profile and header signature, the period bounds, and the
balance-reconciliation verdict. A bare row array cannot carry any of that, and this section
is not free to choose otherwise: §6.1 requires the review screen to show "unparsed rows,
dates outside the detected period, pending rows, and a balance that doesn't reconcile", and
§3.1's `statement_import` stores `rows_parsed`, `rows_inserted`, `parser`, `parser_version`
and `error_detail`. Returning only the rows that succeeded discards exactly the rows a
reviewer needs to see, which would make §2.5's review-before-commit rule unimplementable.

`Uint8Array` rather than `Buffer` because a `Buffer` *is* a `Uint8Array` — every caller is
unaffected, and the pure libs avoid naming a Node-only runtime type.

Implementations register in priority order: `NodeCsvParser`, `NodePdfParser`,
`PythonParserClient`, `LlmAssistedParser`. The port exists from the PDF phase even if only the
Node implementations are built, so adding Python later is a registration, not a refactor.

- **Node PDF** uses `pdfjs-dist` positional text extraction: pull text items with x/y, cluster into lines by y-proximity, infer column boundaries from x-gap histograms, then map columns exactly like CSV.
- **The Python trigger condition**, stated now so it isn't a judgment call later: build `ledgerline-parser-py` when a real statement from an account you actually hold fails Node extraction *and* the failure is column inference rather than the file being image-only. Scanned PDFs need OCR, which Python does not fix within v1 scope.
- **LLM-assisted parsing** sends extracted *text* — never the file — asks for JSON rows, validates against a schema, and marks every row `parse_source = 'llm'`, which forces the review screen and blocks silent commit.

### 2.6 Internal transfer linking

The design session asserted "same amount, within ±3 days" and left the algorithm open. That
predicate is not an algorithm: it says nothing about how two identical $500 transfers in the
same week are assigned, it is too tight for ACH settlement, and it silently deletes real spend
whenever it is wrong. A false link removes money from every total invisibly; a false negative
leaves a number that is visibly too big. The asymmetry decides the design: **auto-link only the
unambiguous case, propose everything else.**

**Candidate generation.** For every debit *d* in account A and credit *c* in account B (A ≠ B,
both accounts present in the system):

- `|d.amount| == c.amount`
- `−1 ≤ (c.effective_date − d.effective_date) ≤ 7` days — money leaves before it lands, and one day of posting-order noise is normal. Seven days covers ACH settlement across a holiday weekend; ±3 loses the common case.

Bucket candidates by `(abs(amount_cents), day)` before pairing, per §2.2's cost note.

**Scoring.** Each candidate pair scores:

| Signal | Points |
|---|---|
| Both descriptors match the transfer keyword list (`TRANSFER`, `XFER`, `ONLINE PMT`, `AUTOPAY`, `PAYMENT THANK YOU`, `E-PAYMENT`, `ACH PMT`) | +3 |
| Either descriptor contains the other account's `last4` | +2 |
| B is a credit card and the debit's descriptor names B's institution | +2 |
| Date gap ≤ 3 days | +1 |
| Either side already belongs to a `recurring_series` whose merchant is not a transfer-kind merchant | −2 |
| Either side's category `kind` is `spend` with a non-transfer canonical merchant | −2 |

**Assignment.** Solve the surviving candidates as a **maximum-weight bipartite matching**
(greedy by descending score with a one-to-one constraint is sufficient at this scale). This is
the part a bare predicate cannot do: without it, four identical $500 transfers in one month
produce sixteen "matches".

**Disposition.**

- **Score ≥ 5** — auto-link. In practice this means keyword-matched on both sides plus one corroborator, which is what a credit-card payment or a savings sweep looks like.
- **Score 2–4** — **propose**. The pair appears in a Possible Transfers queue on the Accounts page and is *not* excluded from spend until confirmed. The queue shows both rows and the dollar effect of linking.
- **Score < 2** — no link.

**Partial payments.** A payment split across two debits, or a payment against a card whose
credit posts as one line, never matches one-to-one. A second pass attempts a one-to-many match
— a single credit in B against a set of ≤3 debits in A inside the window summing exactly to it
— and **always proposes, never auto-links**. Combinatorics over more than three parts is not
worth the false-positive risk.

**Learning.** Confirming a proposal writes a `transfer_rule` (descriptor pattern + account
pair + cadence hint), which scores +3 on subsequent runs. A monthly credit-card payment is
confirmed once and auto-links thereafter.

**What this cannot do.** A transfer to an account not in the system has no counterpart and
will never link, so it counts as spend. The Accounts page says so where coverage is
incomplete; there is no algorithmic fix, only importing the other side.

### 2.7 Jobs

Two operations in this design are long-running and neither fits a synchronous HTTP request.
Batched merchant normalization at ~50 descriptors per call, concurrency 1, with a 90s timeout
per call, is up to an hour for a first-time normalization of a few thousand descriptors. A
re-normalize triggered by a merchant correction re-runs the chain over every historical
transaction and then re-runs the full analysis.

- `POST /api/jobs/renormalize` and `POST /api/analysis/run` **enqueue** and return a job id.
- `GET /api/jobs/:id` reports `{ state, progress, message, result }`; the UI polls.
- Jobs of the same kind **coalesce**: a second renormalize request while one is queued merges into it rather than stacking. Merchant corrections in the UI are debounced 5 seconds and batched, so correcting eight merchants in a row is one job, not eight.
- Re-normalization is **incremental** where it can be: only transactions whose current `description_normalized` falls in the affected alias key-space are re-resolved. A full sweep is available explicitly from Settings.
- Jobs run in-process (single local user, `better-sqlite3` is synchronous); the queue is a table, not a broker.

## 3. Data model

SQLite via `better-sqlite3` (synchronous, no daemon, single-file, correct for one local user).
Migrations are numbered SQL files applied at boot and tracked in `schema_migrations`.

### 3.1 Tables

| Table | Key columns |
|---|---|
| `account` | `id`, `display_name`, `institution`, `account_type` (checking/savings/credit_card), `last4`, `currency`, `is_active` |
| `format_profile` | `id`, `institution`, `account_type_hint`, `header_signature` **UNIQUE**, `column_map_json`, `date_format`, `amount_mode` (single/debit_credit), `sign_convention`, `version`, `source` (seed/user) |
| `statement_import` | `id`, `account_id`, `source_filename`, `file_sha256` **UNIQUE**, `file_bytes`, `format_profile_id`, `period_start`, `period_end`, `rows_parsed`, `rows_inserted`, `rows_duplicate`, `status`, `parser`, `parser_version`, `error_detail`, `imported_at` |
| `raw_row` | `id`, `import_id`, `row_index`, `raw_text`, `parsed_json`, `parse_status`, `parse_source` |
| `transaction` | `id`, `account_id`, `raw_row_id`, `posted_date`, `transaction_date`, `effective_date`, `amount_cents` (signed), `balance_cents`, `currency`, `description_raw`, `description_normalized`, `merchant_id`, `category_id`, `category_source`, `is_pending`, `is_internal_transfer`, `transfer_pair_id`, `refund_pair_id`, `is_excluded`, `dedupe_key`, `dedupe_key_version`, `occurrence_index` |
| `transaction_source` | `transaction_id`, `import_id` — many-to-many; a row present in two overlapping statements has two sources |
| `merchant_canonical` | `id`, `canonical_name`, `display_name`, `website`, `default_category_id`, `is_known_subscription`, `is_transfer_kind`, `overlap_group`, `source` |
| `merchant_alias` | `id`, `alias_key`, `merchant_id`, `match_type` (exact/prefix/fuzzy), `confidence`, `source` (seed/rule/llm/user) |
| `category` | `id`, `name`, `parent_id`, `kind` (spend/fee/transfer/income), `overlap_group`, `source` (seed/user — migration 009, §9ad) |
| `recurring_series` | `id`, `merchant_id`, `account_id`, `cadence_days`, `cadence_label`, `cadences_per_year`, `amount_cents_current`, `amount_cents_first`, `first_seen`, `last_seen`, `next_expected`, `occurrence_count`, `status` (active/lapsed/cancelled), `user_status`, `cancellation_url`, `notes`, `regularity`, `confidence` |
| `transfer_link` | `id`, `debit_transaction_id`, `credit_transaction_id`, `score`, `state` (proposed/confirmed/rejected/auto), `rule_id`, `created_at` |
| `transfer_rule` | `id`, `descriptor_pattern`, `debit_account_id`, `credit_account_id`, `created_at` |
| `finding` | `id`, `rule_id`, `rule_version`, `config_hash`, `natural_key` **UNIQUE**, `subject_type`, `subject_id`, `title`, `detail_json`, `confidence`, `band`, `impact_kind` (savings/visibility), `impact_monthly_cents`, `impact_annual_cents`, `llm_dependent`, `evidence_hash`, `first_detected_at`, `last_run_id`, `status` |
| `finding_evidence` | `finding_id`, `transaction_id`, `account_id` — the join that backs "has-finding" filtering and inline evidence |
| `finding_state` | `natural_key` **PK**, `status`, `reason`, `snooze_until`, `dismissed_evidence_hash`, `updated_at` |
| `dismissal_rule` | `id`, `scope` (merchant_rule/rule), `rule_id`, `merchant_id` (null for rule scope), `reason`, `created_at` |
| `analysis_run` | `id`, `started_at`, `finished_at`, `rule_versions_json`, `config_hash`, `snapshot_rows`, `counts_json` |
| `job` | `id`, `kind`, `state`, `progress`, `message`, `payload_json`, `result_json`, `created_at`, `finished_at` |
| `llm_cache` | `id`, `prompt_sha256` **UNIQUE**, `provider`, `model`, `response_json`, `created_at` |
| `tombstone` | `entity_type`, `entity_id`, `deleted_at` — deletions the Elasticsearch re-index has to see (§3.4) |
| `settings` | `id`, `key` **UNIQUE**, `value_json` |
| `schema_migrations` | `version`, `applied_at` |

**Conventions.** Money is always integer `amount_cents`, never a float. Sign convention:
**negative = money leaving the account**, applied uniformly across checking and credit cards,
with the per-profile mapping absorbing each bank's disagreement about this. Dates are ISO
`YYYY-MM-DD` strings. Every table carries a surrogate `id`, `created_at` and `updated_at` — the
design session claimed this and then omitted them from half the tables; the repository layer
sets all three on every write, and there is a migration test that asserts every table has them.

**`finding_state` versus `dismissal_rule`.** The design session put all three dismissal scopes
in one table keyed by finding natural key, but "dismiss this rule for this merchant" and
"dismiss this rule" are not findings and have no natural key. They are separate concerns and
are now separate tables: `finding_state` is per-finding user state, `dismissal_rule` is a
standing filter applied at emit time.

### 3.2 Indexes and constraints

None of these are optional. The first one is the difference between an import that takes
200 ms and one that takes four minutes.

| Index / constraint | On | Why |
|---|---|---|
| `INDEX (account_id, dedupe_key)` | `transaction` | The merge rule counts existing rows per key for every incoming row. Without it, a 500-row import is 500 table scans. |
| `UNIQUE (account_id, dedupe_key, occurrence_index)` | `transaction` | Makes the multiset merge rule a database invariant rather than application arithmetic. A retried commit cannot double-insert. |
| `INDEX (account_id, effective_date)` | `transaction` | Snapshot load, coverage bar, every date-ranged query. |
| `INDEX (merchant_id, effective_date)` | `transaction` | Series construction, per-merchant outliers, merchant history. |
| `INDEX (abs(amount_cents), effective_date)` | `transaction` | Transfer candidate bucketing (§2.6). |
| `UNIQUE (alias_key, match_type)` | `merchant_alias` | Without it, §4.3's precedence order is ambiguous — two `user` aliases for one key have no defined winner. |
| `UNIQUE (rule_id, subject_type, subject_id)` | `finding` | Upsert-by-natural-key is the lifecycle (§5.1); this is what makes it an upsert. |
| `INDEX (transaction_id)` and `(finding_id)` | `finding_evidence` | Both directions are read paths. |
| `INDEX (import_id)` | `transaction_source`, `raw_row` | Import deletion and the review screen. |
| `CHECK (amount_cents <> 0)` | `transaction` | A zero-amount row is a parse failure, not a transaction — except for trial authorizations (§5.6), which are stored with `is_pending` or an explicit `$0` allowance flag. |
| `CHECK (currency = account.currency)` | `transaction` | v1 is single-currency — **confirmed 2026-08-03: every account is USD**. Money stays integer `amount_cents` with no FX dimension. The column stays on both tables so a future non-USD account is a migration, not a rewrite, and this constraint is what fails loudly the day one appears. |
| `FOREIGN KEY ... ON DELETE RESTRICT` | everywhere | Cascading deletes across `transaction` would let one bad import delete findings and series silently. Deletion goes through the repository, which writes tombstones. |

### 3.3 Idempotent re-import

Two independent layers, because they solve different problems, plus a third thing that is not
idempotency at all and was previously conflated with it.

**Layer one — file identity.** `file_sha256` is unique on `statement_import`. Re-uploading a
byte-identical file is a no-op that returns the existing import. This covers the common case:
you re-drag the same folder.

**Layer two — row identity.** Statements overlap. A re-issued statement, or a date-ranged
export you pull twice with different endpoints, contains rows you already have in a file with
a different hash. Each row gets:

```
dedupe_key      = sha256(account_id | effective_date | amount_cents | collapse_v1(description_raw))
occurrence_index = ordinal among rows sharing that key
```

**`collapse_v1` is frozen.** This is the correctness condition the design session left
implicit, and it is the one most likely to be violated by accident. `collapse_v1` must **not**
be the §4 normalization chain: that chain is a maintained, growing prefix table, and every
addition to it would change `description_normalized` for historical rows, change every
`dedupe_key`, and cause the next overlapping import to re-insert rows it should have merged —
silently doubling a month of spend. `collapse_v1` is instead a minimal transform that is never
changed in place, and it is versioned by name. In order:

1. Uppercase.
2. Fold diacritics to their base letter (NFD, then drop combining marks).
3. **Replace** every character outside `[A-Z0-9 ]` with a space.
4. Collapse whitespace runs to a single space.
5. Trim.
6. Truncate to 40 characters, then trim again in case the cut landed on a space.

**Step 3 substitutes rather than deletes, and that is the whole of the design.** Punctuation
in a descriptor is a separator — `TST*THE PLANT CAFE`, `AMAZON.COM`, `7-ELEVEN`,
`AMAZON - PRIME`. Deleting it glues tokens together (`TSTTHE PLANT CAFE`) and leaves a double
space wherever the separator was itself spaced. Both are deterministic, so neither breaks the
key outright — but banks are not consistent about punctuation between exports, and under
delete-semantics `AMAZON - PRIME` and `AMAZON PRIME` hash differently, so the merge rule
re-inserts a row it should have absorbed. That is the exact failure this section exists to
prevent, arriving through the collapse instead of through the normalization chain. Diacritic
folding is there for the same reason: the reader falls back to Windows-1252 for files that are
not valid UTF-8, so an accented merchant name reaches the collapse intact, and dropping the
accent alone would split `MÜLLER` into `M LLER`.

- `transaction.dedupe_key_version` records which collapse produced each key.
- Changing the collapse function means shipping `collapse_v2` **and** a migration that recomputes every key inside one transaction.
- Imports refuse to run while the table contains mixed `dedupe_key_version` values.

**The multiset merge rule:** for each `dedupe_key`, insert
`max(0, count_in_incoming_file − count_already_in_account)` rows. If the account has one $4.75
charge and the incoming file has two, one is inserted. If the account already has two and the
file has two, none are. The naive alternatives are both wrong: skipping any row whose key
exists loses the second of two genuine identical charges (two coffees, two app purchases),
and inserting everything double-counts on overlap. `rows_duplicate` records what was skipped so
the review screen can show "18 of 52 rows already present."

**Convergence holds** for exact re-import, for a strict superset, and for any two overlapping
exports — every one of those is a pure count comparison per key, and the second run of any
file inserts zero. It holds because the key is date-scoped: two months of the same $9.99
charge are two different keys, so a year-to-date export over twelve monthly statements merges
to zero inserts.

**What the merge rule cannot do, and what covers it.** Three real cases produce rows with
*different* keys that are nonetheless the same transaction. No count comparison will ever see
them, because they hash differently:

- A statement **re-issued with a corrected amount** — $104.53 becomes $104.35. Both rows land; the month over-counts by $104.53.
- A **pending charge that later posts** at a different date or amount — $50.00 on the 10th becomes $59.00 on the 12th once a tip settles.
- The **same month exported in two formats** where one carries `transaction_date` and the other only `posted_date`, so `effective_date` differs by a day or two.

Commit therefore runs a **near-duplicate pass** after the merge: for each row about to be
inserted, look for an existing row in the same account with `|Δ effective_date| ≤ 3` days, the
same `collapse_v1(description_raw)`, and an amount within ±$2 **or** ±3%. Matches are never
resolved automatically. They surface on the review screen as an explicit choice — *replace the
existing row · keep both · skip this row* — with both rows shown. Pending-to-posted matches
default to *replace*; everything else defaults to *keep both*, because over-counting is
visible and losing a real transaction is not.

**Refunds are not duplicates.** A $59.00 debit followed by a $59.00 credit at the same merchant
is a reversal, and both rows are real. The commit pass links them via `refund_pair_id` — same
account, same canonical merchant, equal absolute amount, credit within 90 days of the debit,
one-to-one — and every analyzer nets them out: a refunded charge is not spend, not an outlier,
and not an occurrence in a recurring series. This is a different relation from
`transfer_pair_id`, which is cross-account.

**Import deletion.** Because a row can be covered by more than one statement,
`transaction_source` is many-to-many and `DELETE /api/imports/:id` removes only the
transactions for which that import is the **last remaining source**. Deleting the first of two
overlapping imports must not delete rows the second one legitimately contains — the design
session's "removes only its rows" would have done exactly that, and the surviving import's
`rows_duplicate` count would have become a lie.

### 3.4 What changes when this moves to Elasticsearch

The home-server plan re-indexes this data into ES later. The design keeps that cheap:

- Every row has a stable id, `created_at` and `updated_at`, so an incremental re-index is a watermark query. This is now true because §3.1 enforces those columns; the design session claimed it while several tables lacked them.
- **A watermark query cannot see deletions**, and this app deletes: import removal, account merge, wipe. The `tombstone` table records `(entity_type, entity_id, deleted_at)` and the re-index consumes it in the same pass. Without it, a deleted import's transactions would live forever in the ES index and every aggregate would be wrong.
- A `transaction` denormalizes into exactly one ES document with merchant and category embedded — no joins to reconstruct. The corollary is that **a merchant rename or a re-normalize re-writes every document for that merchant**, so the re-index job must be driven off `updated_at` on `transaction`, which the re-normalize job bumps.
- `finding` and `recurring_series` are already document-shaped.
- The repository layer exposes **named intent methods** (`listDebitsByMerchant(range)`, `monthlyCategoryTotals(range)`), never raw SQL passed in from callers. Swapping the implementation means writing those same methods against ES; nothing above `data` changes.
- The real costs, noted now so they are not discovered later: SQLite gives read-your-writes consistency that ES does not, so any ES read path used immediately after a write needs an explicit refresh or a write-through cache; and `UNIQUE (account_id, dedupe_key, occurrence_index)` has no ES equivalent, so the merge rule's database-level guarantee becomes an application-level one enforced by using the composite as the document `_id`.

## 4. Merchant normalization

Statement descriptors are hostile by design: `SQ *BLUE BOTTLE COFFE 415-555-0111 CA`,
`TST* THE PLANT CAFE #0042`, `PAYPAL *SPOTIFYUSA 4029357733`. Everything downstream —
recurrence, duplicates, categories — depends on collapsing those to one merchant.

This chain is **separate from `collapse_v1` (§3.3)** and may change freely. `collapse_v1` feeds
the dedupe key and is frozen; this chain feeds merchant resolution and is expected to grow.
Conflating them would make every prefix-table addition corrupt the dedupe history.

### 4.1 The deterministic chain

Runs in order, each stage cheap and inspectable. This is rules-first on purpose: it is fast,
reproducible, debuggable, and works with the LLM off.

1. **Case and whitespace** — uppercase, fold Unicode dashes and quotes to ASCII, drop control characters, collapse runs of spaces. **Punctuation stripping does not happen here**, and must not: stage 2's prefix table is `SQ *`, `TST*`, `PAYPAL *`, entries identified *by* their punctuation. Removing `*` at this stage leaves `SQ BLUE BOTTLE`, every processor prefix silently stops matching, and the chain goes on producing stable, wrong output. Character-class stripping is a final tidy after stage 5.
2. **Processor prefixes** — a maintained prefix table: `SQ *`, `TST*`, `ICP*`, `SP `, `PAYPAL *`, `PP*`, `IN *`, `WWW.`, `POS DEBIT`, `ACH DEBIT`, `DEBIT CARD PURCHASE`, `RECURRING PMT`. Notably these often *hide* the real merchant behind Square/Toast/PayPal — the rule strips the prefix and keeps what follows. A prefix **missing** from this table fails quietly rather than loudly: stage 6's tidy turns the `*` into a space and the processor becomes the first word of the merchant's name, so the chain keeps producing clean, stable, wrong output. §9n is one instance, found only because the same merchant appeared both with and without its prefix in one statement.
3. **Store and terminal numbers** — `#0042`, `STORE 1234`, trailing 3–5 digit runs, and long numeric reference tails. **The asterisk is also un-glued to a space here**, and this is the earliest point it may be: stage 2 is its only consumer, and left in place past that it is glue rather than structure. Stages 3–5 are all written around whitespace boundaries, so `AMAZON MKTPL*5O6QH4PH1` reaches stage 5 with its order reference welded on and the trailing-reference rule never fires — then stage 6 spaces it out, long after anything could have cleaned it. See §9o.
4. **Geographic and contact noise** — phone numbers, country codes, and a trailing state code against a state-code list. A URL keeps its host label and loses its scheme, `WWW.` and TLD: `NETFLIX.COM 866-579-7172 CA` must reach stage 6 as `NETFLIX`, and deleting the whole token leaves `CA`, a merchant named after a US state. **The city is deliberately not stripped.** The state code is verifiable against a list; the city is merely whatever token precedes it, and removing it blind turns `BLUE BOTTLE COFFE CA` into `BLUE BOTTLE`. The costs are asymmetric — over-stripping silently merges two merchants and every §5 rule groups by merchant, while under-stripping leaves `STARBUCKS SEATTLE`, which is *stable* and therefore still groups correctly, only less prettily. The known cost is that one chain in two cities is two provisional merchants until an alias joins them, which is step 6's job. Revisit with a city list once real statements show how often it happens (§7.6).
5. **Reference and date debris** — transaction ids, `REF#`, embedded `MM/DD`.
6. **Alias lookup** — exact match on `alias_key` first, then prefix, then trigram fuzzy match above a similarity floor. A hit resolves to a canonical merchant and stops.
7. **Unmatched** — the cleaned string becomes a provisional merchant, marked `source = 'rule'`, and joins the review queue.

### 4.2 Where the LLM helps

Only at step 7, and never in the driver's seat. Unresolved descriptors are batched (~50 per
call), sent as **descriptor strings only** — no amounts, no dates, no account numbers, and
nothing on the P2P filter list from §2.4 — and the model is asked for
`{ descriptor, merchant_name, category, confidence }` validated against a schema. Results land
as `merchant_alias` rows with `source = 'llm'`. Above a confidence floor (0.85) they apply
provisionally and are marked in the UI; below it they sit in the review queue and apply to
nothing. The LLM never overwrites an existing alias and never touches anything with
`source = 'user'`.

**One exception overrides the floor.** An LLM alias that would merge or split an existing
`recurring_series` with `occurrence_count ≥ 3` never auto-applies at any confidence — it goes
to the review queue with the affected series shown. Rewriting four years of a settled
subscription's history on a model's say-so is exactly the failure that makes the tool
untrustworthy, and the confidence floor does not protect against it.

### 4.3 Precedence and persistence

Alias precedence, highest first: **`user` → `seed` → `rule` → `llm`.** A user correction is
permanent and beats everything, including a later re-run with a better model. Within a source,
`UNIQUE (alias_key, match_type)` and then match type order (exact → prefix → fuzzy) decide.

Correcting a merchant in the UI writes a `merchant_alias` row and enqueues a **re-normalize
job** (§2.7) that reapplies the chain across the affected historical transactions and then
re-runs the analyzers. So fixing `SPOTIFYUSA` once retroactively merges four years of charges
into one series — and the subscription findings update. This is why corrections are worth
making, and why the UI puts a bulk "apply to all matching" action next to every merchant edit
(§6.3). The job is debounced and coalesced; a run of eight corrections is one re-normalization,
not eight full sweeps.

## 5. Analyzer specs

### 5.1 The shared finding contract

Every rule emits `Finding` objects with the same shape: a natural key
(`rule_id + subject_type + subject_id`), a title, a structured detail payload, the **evidence**
(explicit transaction ids, materialized into `finding_evidence`), a confidence in `0..1`, and a
money impact in both monthly and annual cents.

**Impact kind, and why the headline number needs it.** Findings measure two different things
and summing them double-counts the same dollars — a $1,459/yr coffee finding, a $1,200/yr
dining-spike finding and a subscription total can all describe the same transactions. Every
finding therefore declares `impact_kind`:

- **`savings`** — money that would stop leaving if you acted: a price-creep delta, a duplicate subscription's cost, an avoidable maintenance fee. These sum. This is the number on the Findings page and the default sort.
- **`visibility`** — money you are already knowingly spending, surfaced because you have never seen it totalled: small-spend aggregates, category spikes, informational overlap. These are shown per-finding and are **never** added into the headline.

**Confidence bands:** `≥0.80` High · `0.55–0.79` Medium · `0.35–0.54` Low · `<0.35` suppressed.
Bands, not raw numbers, are shown to the user; a "0.72" implies a precision the rules do not
have. Confidence is capped at Medium for any finding with `llm_dependent = true` (§2.4).

**Thresholds are configuration, not constants.** Every number in §5.2–§5.10 is a default in a
`config` object that Settings can override. Analyzers take `(snapshot, config)`; `analysis_run`
records `config_hash`, and `finding.rule_version` incorporates it. Without this, changing a
threshold silently resolves and re-creates findings with no explanation and quietly invalidates
dismissals whose evidence never changed.

**Runs and lifecycle.** Analyzers are pure and re-runnable. Findings are **upserted by natural
key**, so user state survives every re-run. A finding present in the previous run but absent
from the current one becomes `resolved` rather than being deleted — "this stopped being true"
is itself information.

**Dismissal.** Three scopes: this finding (`finding_state`), this merchant + this rule, or this
rule entirely (`dismissal_rule`). Dismissing a single finding stores its `evidence_hash` — a
hash of `(rule_id, subject_id, amount rounded to the nearest dollar, cadence_label,
series_status)`. The finding stays dismissed while that hash is stable; if the price changes or
a lapsed series resumes, the hash changes and the finding returns flagged **"changed since you
dismissed this,"** with a diff. Note what is deliberately *not* in the hash: occurrence count.
The design session included an "occurrence-count bucket", which increases every billing cycle
and would have un-dismissed every monthly subscription on a schedule, while `series_status` —
the thing that actually flips when a dormant series resumes — was absent. A `rule_version` or
`config_hash` bump also resurfaces findings, grouped separately as "re-evaluated with an
improved rule" so the user knows why their dismissal was reopened.

**Snooze** is a fourth option — 90 days by default — for "yes, I know, deal with it later."

**Emission budget.** No rule may emit more than 25 findings in a run. Beyond that it emits its
top 25 by impact plus one rollup — "31 more below $40/yr" — that expands on demand. False-
positive volume is the failure mode that gets a tool like this abandoned, and an unbounded rule
is one bad threshold away from producing a thousand cards.

**Absolute impact floor.** No finding is emitted whose annual impact is under **$25** unless
its rule explicitly opts out (only `lapsed.v1` does, because its value is confirmation rather
than money). Applied globally, this kills the largest single source of noise in §5.9 and
§5.10 without touching their statistics.

### 5.2 Recurring subscriptions (`recurrence.v1`)

The core rule; everything in §5.4–§5.7 builds on the series it produces.

**Inputs:** all non-excluded, non-transfer, non-pending, non-refunded debits with an
`effective_date`, grouped by canonical merchant.

**Amount grouping is temporal, not just numeric.** The design session clustered by amount alone
— "within the greater of ±5% or ±$1 of the cluster median" — which breaks in both directions.
Netflix at $8.99 in 2019 and $15.49 in 2023 falls into two clusters, so one subscription that
got more expensive presents as **two series for the same merchant**, which is precisely what
§5.4's same-merchant multiplicity rule reports as an error at 0.85 confidence. For an annual
subscription this false positive persists for eighteen months, because `1.5 × cadence` keeps
the superseded cluster "active". Meanwhile ±$1 at an $11 price point spans three consecutive
real price tiers.

The fix is to make grouping aware of time, in three passes:

1. **Seed by amount.** Sort the merchant's debit amounts; split into candidate groups wherever the gap to the running median exceeds `max(5%, $1.00)`. Recompute medians and re-split until stable, capped at five iterations. (The design session's rule was circular — membership defined against a median that membership defines — so the algorithm is stated here.)
2. **Merge price steps.** Two candidate groups of the same merchant merge into one series when their date ranges are **disjoint or overlap by at most one cadence**, and their independent cadence estimates agree within tolerance. That is a price change, not a second subscription. This is what makes §5.5 work at all: price creep is only visible inside a single series.
3. **Keep genuine concurrency separate.** Groups whose dates **interleave** — both charging in the same period for at least two consecutive cycles — stay separate series. Only these count as concurrent for §5.4.

**Cadence fitting.** For each cluster with ≥3 charges (see the annual exception below), take
the sorted deltas between consecutive `effective_date` values. Do **not** take the raw median
and look it up in a table: a single missing statement turns one 30-day delta into a 60-day one,
and with three charges the median of `[30, 61]` is 45.5, which matches no cadence and makes a
real monthly subscription invisible. Missing months are common — the Accounts coverage bar
exists because of them.

Instead, fit each candidate cadence *C*: for every delta compute `k = round(delta / C)`,
require `1 ≤ k ≤ 3` (up to two missed cycles), and take the residual
`r = delta − k·C`. Score the cadence by `median(|r|)`; the best-scoring cadence wins if that
median is within tolerance.

| Cadence | `cadence_days` | Tolerance | `cadences_per_year` |
|---|---|---|---|
| Weekly | 7 | ±2 | 52.18 |
| Biweekly | 14 | ±2 | 26.09 |
| Four-weekly | 28 | ±2 | 13.04 |
| Monthly | 30.44 | ±4 | 12 |
| Quarterly | 91.3 | ±7 | 4 |
| Semiannual | 182.6 | ±12 | 2 |
| Annual | 365.25 | ±20 | 1 |

**Four-weekly versus monthly must be tie-broken explicitly**, because a true four-weekly series
has deltas of exactly 28 and matches both. Four-weekly wins only when **every** delta is in
27–29 *and* `n ≥ 6`; a fixed-day-of-month subscription cannot produce that, because any span
covering a 31-day month forces a delta of 30 or 31. Otherwise monthly wins. Getting this
backwards understates every annualized number for those series by 7.7% — 12 cadences a year
instead of 13 — and §5.5 inherits the error.

**`cadences_per_year` is stored on the series**, not recomputed per rule, so §5.5's
`delta × cadences_per_year` and the Subscriptions page's annual totals cannot disagree.

**Confidence** = `0.45 × regularity + 0.30 × count_score + 0.25 × amount_stability`, plus
`0.10` if the merchant carries the `is_known_subscription` seed flag, clamped to 1.0, then
subject to the caps below.

- `regularity = 1 − clamp(MAD(residuals) ÷ tolerance(C), 0, 1)` — residuals from the cadence fit above, scaled by that cadence's own tolerance. The design session used `1 − MAD(deltas) ÷ cadence`, which for a monthly series can only ever produce values above 0.85, because the cadence match already guaranteed small deltas.
- `count_score = clamp((n − 2) ÷ 6, 0, 1)` — 0.17 at three occurrences, 1.0 at eight. The design session's `min(n, 6) ÷ 6` starts at 0.5 for the minimum qualifying series.
- `amount_stability = 1 − clamp(CV ÷ 0.05, 0, 1)`, where CV is the coefficient of variation of the series' amounts *within its current price step*. The design session said stability "falls off with coefficient of variation" without defining the function.
- **Caps:** a two-occurrence series is capped at 0.45; a three-occurrence series at 0.70. Under the original formula a two-occurrence series scored 0.90 — MAD of a single delta is always zero, so regularity was always 1.0 — which contradicted the same section's statement that two occurrences emit at Low.

These four changes exist because the original formula was structurally incapable of producing a
Low band. With `count_score ≥ 0.5` by construction, `regularity ≥ 0.85` by construction, and
amount stability bounded above ~0.6 by the clustering tolerance, every qualifying series scored
between 0.66 and 1.00 — the Low band and the suppression threshold were dead code, and the
bands communicated nothing. The revised inputs put a ragged three-occurrence series near 0.40
(Low), a solid five-occurrence series near 0.71 (Medium), and a clean twelve-occurrence series
at 1.0 (High).

**Annual subscriptions get an exception**, because the ≥3-charge rule means three years of
statements before an annual subscription is detected at all, and annual subscriptions are
exactly the ones people forget. Two charges 355–375 days apart with stable amounts emit at
Medium, with the `is_known_subscription` flag *not* required. A single large charge at a
known-subscription merchant emits at Low as "possible annual subscription — only one charge in
the imported window", which is honest and actionable.

**Liveness** is measured against the **maximum `effective_date` in that series' own account**,
not the dataset maximum and not today's clock. Wall-clock time would mark every series lapsed
the moment imports fall behind. The dataset maximum is almost as bad: if checking is imported
through July and the credit card only through May, every card subscription looks lapsed by two
months. Active = last charge within `1.5 × cadence_days` of that account's coverage end.

**Presentation.** Feeds the Subscriptions page rather than spamming Findings: one summary
finding ("14 active subscriptions, $247/mo, $2,964/yr", `impact_kind = visibility`), with
individual series findings reserved for the rules below.

### 5.3 Recurrence output contract

Downstream rules consume series, not transactions. A series exposes: `merchant_id`,
`account_id`, `cadence_days`, `cadences_per_year`, `status`, `confidence`, the ordered charge
list, and the **price steps** derived in §5.5. Rules in §5.4–§5.7 must not re-derive any of
these; a second implementation of cadence inference is a second set of thresholds to keep in
sync.

### 5.4 Duplicate and overlapping services (`duplicate.v1`)

Two distinct rules, deliberately weighted differently, and **separately toggleable in
Settings** — one claims an error, the other claims nothing.

- **Same-merchant multiplicity** — two or more **concurrent** series for the *same* canonical merchant, where concurrent means §5.2's pass 3 kept them separate because their charge dates interleave for at least two consecutive cycles. Usually a real error: a double-charged account, or a personal plan still billing after a family plan started. Base confidence **0.85**, `impact_kind = savings`, impact = the cheaper series' annual cost. The concurrency requirement is what stops this rule from firing on every subscription that ever changed price.
- **Category overlap** — two or more active series sharing an `overlap_group`, a curated subset of categories where redundancy is meaningful (video streaming, music streaming, cloud storage, VPN, password manager, meal kit, news). Base confidence **0.60**, `impact_kind = visibility`, and the wording is informational — "you have 3 music streaming subscriptions totaling $32/mo" — not accusatory. Owning both Netflix and Disney+ is a legitimate choice; the app's job is to make the total visible, not to nag.

Overlap groups are curated seed data. `Restaurants` is deliberately not one.

### 5.5 Price creep (`price_creep.v1`)

Within a series, a **step** is an amount change that holds for a cadence-appropriate number of
consecutive occurrences. The "holds" requirement is what separates a price increase from a
one-off proration or a tax-rate blip — but a flat "≥2 occurrences" means an annual
subscription's price increase is reported **two years late**, and combined with the ≥3-charge
requirement that needs four years of statements. The requirement is therefore
`max(1, min(2, ceil(60 ÷ cadence_days)))`:

| Cadence | Occurrences required to confirm a step |
|---|---|
| Weekly, biweekly, four-weekly, monthly | 2 |
| Quarterly, semiannual, annual | 1 |

A step confirmed by a single occurrence is reported at reduced confidence and labelled
**"unconfirmed — one charge at the new price."**

**Noise floor.** The design session ignored changes "under 2% or $0.50", which as written
suppresses a $3.80 step on a $200/month subscription (1.9%, $45.60/yr — material) while
admitting a $0.60 step on an annual plan ($0.60/yr — not). The filter is now stated in the unit
the whole app sorts by: ignore a step unless `|delta| ≥ $0.50` **and** the annualized impact
`|delta| × cadences_per_year ≥ $5`. Percentage remains a presentation field, not a filter.

Reports every step with old price, new price, delta, percent, effective date, and annualized
impact, plus the cumulative change since the first observed charge. That cumulative number is
the one that lands: "$8.99 → $15.49 since 2023, +72%, $78/yr more than when you signed up."
`impact_kind = savings`.

**Confidence** = `min(0.90, series.confidence)` for a confirmed step, `min(0.70,
series.confidence)` for an unconfirmed one. The arithmetic is certain; the only doubt is
whether the series is really one subscription — which is exactly what `series.confidence`
measures, so a flat 0.90 would have claimed more certainty than the grouping supports.

### 5.6 Trial conversions (`trial.v1`)

Signals combine; **no single signal is sufficient on its own** except an explicit trial
descriptor.

| Signal | Points | Notes |
|---|---|---|
| A `$0.00` or `≤$1.50` authorization at the merchant 5–35 days before the first real charge | 2 | The classic card-validation pattern. |
| The first real charge falls 7, 14, 30, or 90 days (±3) after **that authorization**, or after a charge whose descriptor carried a trial marker | 1 | Relative to the trial marker, not to the merchant's first appearance. |
| Descriptor contains a trial marker | 2 | Whole-token match on `TRIAL`, `FREE TRIAL`, `INTRO OFFER`, `INTRO RATE`. |
| The first charge is materially below the subsequent steady-state amount | 1 | Never sufficient alone. |

Confidence = `0.30 + 0.15 × points`, capped at 0.85. A finding is emitted at ≥2 points.

Three corrections to the design session's version, all of which would have produced constant
false positives:

- **Signals one and two were the same signal.** "First real charge falls 7/14/30/90 days after the merchant's first-ever appearance in the data" can only fire when an earlier non-charge row exists — which is signal one. For a merchant whose first row *is* its first charge the delta is zero and nothing matches. Scoring them as independent corroboration double-counted.
- **Bare `FREE` as a substring** matches `FREE PEOPLE` (a clothing retailer), `FREEDOM MORTGAGE`, `FREEPORT`, `FREESTYLE`. Normalization uppercases everything, so an unanchored substring test over every descriptor in the database is a guaranteed noise generator. The match is now whole-token and `FREE` alone is dropped.
- **"Any one signal makes a candidate" plus the intro-rate signal** fires on every subscription whose price ever went up — the entire subscription base. The intro-rate signal is now worth one point and cannot emit alone, and the finding is **suppressed entirely** when `price_creep.v1` has already reported a step at the same first-to-second transition.

**Stated limitation.** This rule needs history *before* the trial. If a merchant's first charge
lands within the first 45 days of the imported window, the rule cannot distinguish "new trial
converted" from "pre-existing subscription we're only now seeing," and confidence is halved.
The UI says so on the finding rather than hiding it.

### 5.7 Cancellation confirmation (`lapsed.v1`)

A series with ≥3 occurrences whose last charge is older than `2 × cadence_days` relative to
**its own account's coverage end** (not the dataset maximum — see §5.2) is marked "appears
cancelled." Low priority, informational, `impact_kind = visibility`, and exempt from the $25
impact floor because its value is confirmation rather than money. Useful in both directions: it
confirms a cancellation actually took effect, and its *absence* after you cancelled something
is the signal that they're still billing you.

### 5.8 Fees and interest (`fees.v1`)

Whole-token keyword match on normalized descriptors **or** `category.kind = 'fee'` — either
qualifies, because a fee whose category was never assigned is still a fee. Keywords: interest
charge, cash advance fee, late fee, annual membership fee, overdraft, NSF, returned item,
foreign transaction, ATM fee, monthly maintenance, minimum balance.

Three qualifications the design session omitted, each of which produces wrong numbers without
them:

- **Debits only.** On a savings account `INTEREST` is income, not a fee; on a credit card it is a charge. Sign disambiguates them and nothing else does.
- **Exclusion list.** `INTEREST CHECKING` and `INTEREST EARNED` are account descriptors, not fees. Suffixes `REFUND`, `REVERSAL`, `CREDIT`, `WAIVED`, `ADJUSTMENT` disqualify a match.
- **Net out reversals.** A fee credited back within 60 days at the same account and amount is netted to zero. A refunded fee that still shows in an annual total is the kind of error that costs the whole tool its credibility.

Emits **one rollup finding per account**, not one per transaction — a per-transaction finding
for every $3 ATM fee is noise. The rollup gives monthly and annual totals with the breakdown,
and separately flags recurring maintenance fees as the avoidable subset (they usually have a
fee-waiver condition), which is the part that carries `impact_kind = savings`; the rest is
`visibility`. Confidence **0.95** on a keyword hit, **0.75** on a category-only hit.

### 5.9 Outlier charges (`outlier.v1`)

Robust statistics, not mean and standard deviation — a single $2,000 charge inflates the mean
enough to hide itself. **Every branch below is additionally subject to an absolute floor: the
charge must exceed the comparison median by at least $25**, and the global §5.1 floor applies.
Without it the rule fires constantly on trivia: a coffee shop with a $6.40 median and a $0.50
MAD flags a $9.80 latte at z = 4.6, and the MAD=0 fallback flags a $7 transit fare against a
$2 median.

- **Per merchant** with n≥5 and **per category** with n≥15: modified z-score `0.6745 × (x − median) ÷ MAD`; flag `|z| > 3.5` **and** `x − median ≥ $25`.
- **MAD = 0** (a perfectly steady charge): fall back to flagging anything above `3 × median`, still subject to the $25 floor.
- **The global rule** catches what the above structurally cannot — a one-off large charge at a merchant with no history has no distribution to be an outlier in. But "any debit above the 95th percentile of all debits and $200" is, by definition, 5% of every transaction: about a thousand findings over ten years of data, and for most households the top of that distribution is rent, mortgage, tuition and insurance — expected payments, every one of them. The global rule is therefore: **the ten largest debits in each rolling twelve-month window** that are above the 99th percentile and above $200, are **not** members of a recurring series, and are **not** internal transfers — emitted as **one rollup finding per window**, not ten cards.

Presented as comparison, not judgment: "$412 at Merchant — typical is $23." `impact_kind =
visibility` throughout; an outlier is information, not a saving.

### 5.10 Category trends and month-over-month (`trend.v1`)

Monthly sums and counts per category, computed **only over fully-covered months** (§7.2). A
month in which one of three accounts was imported has artificially low spend, which makes the
next complete month look like a spike; the coverage rule is what stops the trend analyzer from
reporting import gaps as spending behaviour.

- **Spike** — a month exceeds its trailing three-month average by **both** >40% *and* >$75 **of excess** (not of total), with all three trailing months present and non-zero. Both conditions, because a percentage alone flags a $12 category and a dollar amount alone flags every large category every month.
- **Climb** — three consecutive monthly increases totalling >25% **and** >$50/month, where the three-month rise also exceeds twice the MAD of that category's own historical monthly deltas. Without the volatility test, a category performing an ordinary random walk produces three consecutive increases about one window in eight; across thirty categories and a year of windows that is roughly twenty-five spurious "climbs" per run.
- **Seasonality suppression** — a spike in a month-of-year that already spiked in a prior year for the same category is suppressed to a note rather than a finding. December, insurance renewal months and tuition months otherwise fire every single year.
- Both triggers exclude categories whose spend is dominated (>80%) by a single recurring series, which §5.2 and §5.5 already cover better.
- `impact_kind = visibility`. Emission is capped at the top five spikes and top five climbs per run, per §5.1's budget.

### 5.11 High-frequency small spend (`micro.v1`)

Merchants or categories averaging ≥8 transactions per month across fully-covered months, at a
median ≤$15. No judgment attached — the finding *is* the annualized arithmetic: "coffee: 19
transactions/month averaging $6.40 = $122/mo, **$1,459/yr**." Most people have never seen that
number, and seeing it is the entire value. `impact_kind = visibility` — this money is already
being spent knowingly, and adding it to a "savings" headline that also counts the same
transactions in a category trend would make the headline fiction.

## 6. UI

Angular standalone components with signals, shared shell, dark-first to match the workspace
look. Wireframe level below — layout, not pixels.

### 6.1 Import

Full-page dropzone accepting multiple files at once. Each file gets a row with progress and a
detected badge (`CSV · Chase profile` / `PDF · text layer OK` / `⚠ needs mapping`). Then the
**Review** table: parsed rows with the raw source line available per row, exact duplicates
greyed with an "already imported" tag and a count summary, **near-duplicates** (§3.3) shown as
an explicit three-way choice against the row they resemble, and a warning strip for anything
suspicious — unparsed rows, dates outside the detected period, pending rows, and a balance
that doesn't reconcile (`balance[n] − balance[n−1] ≠ amount[n]`, checked at import time from
`balance_cents` where the profile supplies it). Account assignment is auto-guessed from the
filename and statement header and must be confirmed. Nothing enters the database until
**Commit**.

The **column mapper** appears inline for unknown formats: the first rows in a grid, a dropdown
per column (`Date` / `Posted date` / `Description` / `Amount` / `Debit` / `Credit` / `Balance`
/ `Status` / `Ignore`), a date-format picker with a live preview, and a sign-convention toggle.
Saving stores a `format_profile` keyed on the header signature — the next statement from that
bank imports without asking.

Below: import history with re-parse and delete. Re-parse is refused on a committed import;
delete removes only the rows for which this import is the last remaining source.

### 6.2 Accounts

List of accounts with type, institution, last4, transaction count, and a **coverage bar** — a
strip of month cells showing which months you have statements for, sourced from
`GET /api/accounts/:id/coverage`. Gaps are visible at a glance, which matters because most
findings degrade quietly with missing months and because §5.10 and §5.11 refuse to compute over
partial months at all. Actions: rename, set type, merge two accounts, archive.

The **Possible Transfers** queue lives here (§2.6): proposed pairs with both rows, the score's
reasons, and the dollar effect of confirming.

### 6.3 Transactions

Virtualized table. Filters for account, date range, amount range, merchant, category,
has-finding, pending, and an internal-transfer toggle (off by default). Full-text search across
raw and normalized descriptors. Row expander reveals the verbatim statement line and the
imports that cover it.

Inline edits: assign merchant, assign category, mark internal transfer, exclude from analysis.
Critically, every merchant edit offers **"apply to all 47 matching descriptors"** — the count
comes from `POST /api/transactions/bulk?dryRun=true`, and that bulk correction path is what
makes normalization converge in minutes instead of row by row. Corrections enqueue a coalesced
re-normalize job (§2.7); the UI shows its progress rather than blocking.

### 6.4 Findings — the hero page

A top strip with the three numbers that justify the app: active subscriptions and their
monthly/annual total, **total flagged annual savings** (`impact_kind = savings` only — see
§5.1), and unreviewed finding count.

Findings are grouped by rule, sorted by **annual impact** descending. Each card shows the
title, the money (monthly and annual), a confidence band chip, an "AI-assisted grouping" badge
where `llm_dependent`, and inline evidence — a compact charge history or mini-table, not a link
to go find it. Actions per card: Acknowledge, Dismiss (with the scope picker: this / this
merchant / this rule), Snooze 90 days, and Open subscription. Filters for band, rule, account,
and minimum annual impact. Resurfaced findings carry a "changed since you dismissed this"
banner with the diff, and rule-version resurfaces are grouped separately.

### 6.5 Subscriptions

The recurring ledger: merchant, amount, cadence, next expected date, first seen, total paid to
date, status. Sortable by annual cost, which is the view that produces the "I pay *what* for
that?" reaction.

A month strip shows which days charges land — genuinely useful for cash flow. The detail drawer
holds the full charge history as a chart with price-change markers, the price-step table, a
user-entered cancellation URL and notes field, and a manual "mark cancelled" override — all
three persisted via `PATCH /api/series/:id` into `recurring_series.cancellation_url`, `notes`
and `user_status`. A manual status always beats the computed one.

### 6.6 Insights

The secondary goal's home. Category spend by month as stacked bars with a date-range selector,
a month-over-month movers table (biggest risers and fallers), the fees and interest rollup per
account, the outliers list, and the small-spend aggregate table with annualized columns. Months
that are not fully covered are rendered hatched rather than omitted, so a gap reads as a gap
and not as a drop in spending.

### 6.7 Ask

Chat over the data, disabled with a clear explanation and a link to Settings when the provider
is `none`.

**Not text-to-SQL.** The LLM chooses from a fixed set of validated query functions —
`spendByCategory(range)`, `merchantHistory(merchant, range)`, `findRecurring()`,
`topMerchants(range, n)`, `transactionSearch(filters)`, `monthlyTotals(range)` — with
schema-checked parameters. The functions execute deterministically; the LLM only picks the
query and writes prose around the returned rows. This buys no hallucinated numbers, no
arbitrary database access from generated SQL, and data minimization.

Two constraints make those claims true rather than aspirational:

- **`transactionSearch` returns rows to the UI but not to the provider.** Row-level descriptors are the least aggregated data in the system, and sending them contradicts the data minimization claim in the same breath as making it. The provider receives a count, the aggregate totals, and at most twenty descriptors with the §2.4 redaction and P2P filter applied. The UI renders the full result locally.
- **Numeric post-validation.** Every numeric token in the model's prose must appear in the returned rows or be a simple aggregate of them (sum, difference, mean, percentage of two present values). An answer that fails validation is not shown; the table is shown instead with a note. This is what converts "no hallucinated numbers" from a hope into a check.

Every answer renders the underlying table or chart, names the query it ran, and offers "view
the rows." An answer with no visible data behind it is not shown.

### 6.8 Settings

- **LLM provider** — `none` (default) / `claude-cli` / `ollama`, with a Test Connection button and health detail. Selecting `claude-cli` shows a prominent warning card: *"The Claude CLI provider sends statement text — merchant descriptors, and for Q&A, aggregated amounts — off this machine to Anthropic. Ollama and None keep everything local."* While it's active, a persistent indicator sits in the app header.
- **Redaction** — strips account numbers, last4 and counterparty names, and hard-filters P2P descriptors (§2.4). On by default and not disableable while `claude-cli` is selected.
- **Merchant aliases** — a re-normalize trigger with job progress. The review queue for LLM proposals and provisional merchants, and the list of user corrections, are **§6.9's**: they are work on the data rather than configuration of the app, and §9s says why that difference earned its own page.
- **Analyzers** — per-rule enable (with the two halves of `duplicate.v1` toggled separately) and threshold overrides, plus rule versions and the current `config_hash`. Changing a threshold warns that dismissed findings in that rule will be re-evaluated.
- **Categories** — taxonomy editor and overlap-group assignment.
- **Data** — database path, backup, export to JSON/CSV, wipe, and the degraded-LLM-call log.

### 6.9 Review

Where the app puts the questions it will not answer for itself, with a count in the rail so
they are noticed rather than found. §4.1 step 7's queue is the first population: **merge
candidates** as cards — both merchants, both transaction counts, the sample spellings behind
each, and which way the merge points, stated in words and flipped in one click — and the
**provisional merchants** behind them. §4.2's LLM alias proposals belong here too and say why
they are empty until §2.4's seam exists.

Three rules, all inherited from §6.3's merchant edit because they are the same decision.
Counts come from the API and are never computed from what the page holds. Nothing applies on
selection: a direction is armed, and a second explicit click performs it. And the re-read
waits for §4.3's job, because the alias write is synchronous and the rows are not.

The rail badge counts **questions, not context** — provisional merchants are listed and not
counted, since a name the chain invented for itself is only a problem when it is unstable.

Everything of that shape belongs here as it arrives: uncategorized merchants, and anything
else where the app is unsure and one click settles it. §2.6's possible transfers stay on
§6.2 for now, because they are a fact about two accounts and the page holding both already
has the evidence.

**Not Settings**, which is where the app is configured. This is where the data is corrected,
and the two are different errands — §9s.

## 7. Cross-cutting rules

These bind every section above. They exist because the same mistake was available in several
places independently.

### 7.1 One date

Every analyzer, every aggregate and the dedupe key use
`effective_date = COALESCE(transaction_date, posted_date)`. `posted_date` is retained for
display and for reconciliation against the statement, and is never used for cadence.

### 7.2 Fully-covered months

An account's month is **covered** when a committed import's `[period_start, period_end]`
spans it. Any analyzer that computes a per-month aggregate — §5.10, §5.11, the Insights page —
restricts itself to months covered for **every** account in scope, and reports the window it
used. Every liveness and lapse test measures against the account's own coverage end, never the
dataset maximum and never the wall clock. Missing statements are the normal condition of this
app, not an edge case.

### 7.3 Money, once

`impact_kind` (§5.1) separates money you could stop spending from money you are already
choosing to spend. Only `savings` sums into a headline. Two findings may never claim the same
dollars as `savings`.

### 7.4 Thresholds are data

Every threshold in §5 is a default in a config object; Settings overrides it; `analysis_run`
records `config_hash`; `finding.rule_version` incorporates it. No analyzer reads a module-level
constant.

### 7.5 Provenance is metadata, never input

No analyzer branches on a `source` column. Provenance travels to the UI as `llm_dependent` and
caps confidence at Medium (§2.4). This is what makes the `none`-mode claim testable.

### 7.6 Every number here is uncalibrated

Nothing in §5 has been run against a real statement. The first phase that ships analyzers also
ships a fixture corpus — a hand-labelled year of real statements with the expected findings
written down — and every threshold is re-derived against it before the numbers in this document
are treated as settled. Until then they are starting points with stated reasoning, and the
`config_hash` machinery in §7.4 exists precisely so that tuning them is a normal operation
rather than a schema migration.

## 8. Changes from the design session

This document was extracted from the design artifact on 2026-08-03 during an adversarial audit.
The extraction was not verbatim. Substantive changes, in document order:

| § | Change |
|---|---|
| 2.1 | Added the "libs compute, the app persists" rule; the pipeline previously assigned write-owning stages to pure libs. |
| 2.2 | Gave every lib a distinct `type:` tag and a `scope:` tag, and wrote the `depConstraints` out. The original shared `type:util` across `parsing`/`normalize`/`analyzers`, which forces one shared constraint and would have permitted `analyzers → data`. |
| 2.2 | Added the snapshot-once rule, the transfer-matcher bucketing requirement, and a row-count guard. |
| 2.3 | Added the missing endpoints the UI requires: format profiles, account coverage, account merge, bulk dry-run, series PATCH, dismissal rules, transfer proposals, jobs, backup/export/wipe, findings summary, merchant review queue. |
| 2.4 | Replaced the `none`-mode invariant and its parity test. The original claim was false and the test tautological; replaced with four narrower guarantees and three tests that can fail. |
| 2.4 | Added the P2P descriptor hard filter to redaction. |
| 2.5 | Made `effective_date` the single analysis date; added pending-row handling and `RawRow.status`. |
| 2.6 | Wrote the transfer-linking algorithm the original asserted as a predicate: candidate window, scoring, bipartite assignment, auto/propose/reject bands, partial-payment pass, learned rules. |
| 2.7 | Added the job model; two operations in this design cannot run inside an HTTP request. |
| 3.1 | Added `format_profile`, `transaction_source`, `finding_evidence`, `dismissal_rule`, `transfer_link`, `transfer_rule`, `job`, `tombstone`. Split `finding_state`. Added the columns §6.5 and §6.3 require. |
| 3.2 | Added indexes and constraints; the original specified none, including the `dedupe_key` index the merge rule cannot work without. |
| 3.3 | Froze `collapse_v1` and versioned it; added the near-duplicate pass, refund pairing, and last-source import deletion. |
| 3.4 | Added tombstones; a watermark re-index cannot see deletes. |
| 4.2 | Added the settled-series exception to the LLM auto-apply floor. |
| 5.1 | Added `impact_kind`, the emission budget, the $25 floor, thresholds-as-config; fixed the dismissal `evidence_hash` components. |
| 5.2 | Replaced amount-only clustering with the three-pass temporal grouping; replaced median-lookup cadence matching with residual fitting; added the four-weekly tie-break, `cadences_per_year`, the annual-subscription exception, per-account liveness, and a confidence formula that can reach Low. |
| 5.4 | Required concurrency (not just two clusters) for same-merchant multiplicity. |
| 5.5 | Made the "holds" requirement cadence-relative; replaced the noise floor with an annualized one; capped confidence by series confidence. |
| 5.6 | Merged two signals that were the same signal, dropped bare `FREE`, made no single weak signal sufficient, added suppression against `price_creep.v1`. |
| 5.8 | Debits only, exclusion list, reversal netting. |
| 5.9 | Added the $25 absolute floor and replaced the 95th-percentile global rule, which by construction flagged 5% of all transactions. |
| 5.10 | Added coverage restriction, excess-based dollar test, a volatility test on climbs, seasonality suppression, and emission caps. |
| 6.4 | Headline sums `savings` only. |
| 6.7 | `transactionSearch` no longer sends rows to the provider; added numeric post-validation. |
| 7 | New section: the cross-cutting rules that several sections were each getting wrong separately. |

## 9. Amendments from implementation — 2026-08-04

The CSV ingest path was built on 2026-08-04 (`docs/statement-parsing.md`). Writing it found
four places where this document was wrong or unimplementable as worded. All four are corrected
above; they are recorded here because a spec that quietly reshapes itself to match whatever got
built is worth nothing.

| § | Amendment | Why |
|---|---|---|
| 1 | Status is no longer "pre-implementation", and now says plainly that no *real* statement has been parsed — only synthetic fixtures. | The original status line would have read as calibration that has not happened. |
| 2.5 | `ParserPort.parse` returns `ParseResult`, not `RawRow[]`; `Uint8Array` replaces `Buffer`. | **The original signature was unimplementable against this document's own requirements.** §6.1's review screen needs unparsed rows, pending rows and the balance verdict, and §3.1's `statement_import` stores `rows_parsed`, `parser`, `parser_version` and `error_detail`. A row array carries none of it, so §2.5's review-before-commit rule could not have been built. |
| 3.3 | `collapse_v1` **substitutes** punctuation with a space instead of deleting it, folds diacritics, and trims after truncation. | Delete-semantics glued tokens together (`TST*THE PLANT CAFE` → `TSTTHE PLANT CAFE`) and hashed `AMAZON - PRIME` differently from `AMAZON PRIME`, so two exports of one transaction that differ only in punctuation would produce two keys and the merge rule would double-count — the precise failure §3.3 exists to prevent, arriving by a route the section did not anticipate. Amended **before the first import**, so no stored row was keyed under the old wording and the name `collapse_v1` still refers to exactly one definition. After the first import this would have required `collapse_v2` and a full re-key migration. |
| 4.1 | Stage 1 no longer strips punctuation; stage 4 keeps a URL's host label and does not strip the city. | Stage 1's punctuation stripping would have destroyed the `SQ *` / `TST*` / `PAYPAL *` markers that stage 2 matches on — every processor prefix would silently stop unwrapping while the chain kept producing plausible output. Stage 4's URL rule as worded deleted `NETFLIX.COM` entirely and resolved the descriptor to `CA`. Both were found by running the chain over fixtures and reading the output. |

Two thresholds introduced by the implementation are **uncalibrated** in the §7.6 sense and are
marked as such in the code: `SIGNATURE_SUGGESTION_FLOOR` (0.5) and `FUZZY_SIMILARITY_FLOOR`
(0.72).

## 9a. Amendments from implementation — 2026-08-07 (§6.3)

Building the Transactions page found four gaps between §2.3's API table and what §6.3's page
actually needs. All four are additions rather than corrections — nothing above was wrong — but
they are recorded for the same reason: §2.3's table is the contract, and an endpoint that exists
in code and not in the table is an endpoint nobody reviewed.

| § | Addition | Why |
|---|---|---|
| 2.3 | `GET /api/categories`. | §6.3 requires a category filter and an "assign category" inline edit, and §2.3's table has no way to read the `category` table — categories appear only inside `GET /api/insights/categories`, which is an aggregate. A dropdown cannot be populated from an aggregate. |
| 2.3 | `GET /api/jobs/:id` and `GET /api/jobs` were built; `POST /api/jobs/renormalize` was **not**. | §6.3 ends "the UI shows its progress rather than blocking", which needs the read. The producer is not needed because on this page a re-normalize is never something the user asks for directly — it is a consequence of a merchant correction (§4.3), enqueued by the transaction route that made the correction. The job **runner** remains unbuilt, so a job stays `queued`; the UI says so rather than animating a progress bar that cannot move. |
| 2.3 | `GET /api/transactions/:id` is now **in the table**, and returns `rawText` and a `sources` array alongside `coveringImports`. | The route was built on 2026-08-06 and §2.3's table never listed it, which is exactly the gap this section exists to close. On the payload: §6.3 asks for "the verbatim statement line and the imports that cover it", and `coveringImports` alone answers the second half. `sources` is §3.1's own argument for `transaction_source.raw_row_id` made good — "the same transaction is a different printed line in each statement that carries it" — so a row covered by two overlapping imports has two verbatim lines. |
| 4.1 | A seed category set (`SEED_CATEGORIES` in `normalize`), alongside `SEED_MERCHANTS` and `SEED_ALIASES`. | §3.1's `category.kind` CHECK enumerates the four kinds the design reasons about, but nothing seeded a single row, so §6.3's "assign category" had nothing to assign. Deliberately small and **uncalibrated** in the §7.6 sense, with the same caveat `SEED_ALIASES` carries: it is a starting point, not a taxonomy. `overlap_group` is left unset on every row, because guessing which services overlap before §5.4 exists would be inventing the answer to that analyzer's hardest question. |

One implementation detail is worth recording because it is load-bearing for the generated
client. Every route now declares an explicit `operationId` and every shared response shape an
explicit `$id`; `tools/generate-api-client.mjs` invents no names and errors on a route without
one. Two tests in `apps/ledgerline-api/src/contract.spec.ts` fail the build if `openapi.json`
drifts from the route schemas, or if the committed client drifts from `openapi.json`.

## 9b. Amendments from implementation — 2026-08-11 (§6.1)

Building the Import page found one place where §6.1 asks for a check this codebase cannot
currently make, and one place where §6.1's wording understates what the UI has to do. Neither
is a correction to a rule; both are recorded for the reason §9a gives — a requirement that
quietly becomes unimplementable is worth more written down than silently dropped.

| § | Amendment | Why |
|---|---|---|
| 6.1 | **"Dates outside the detected period" cannot fire today, and the page says where the period came from.** The check is implemented against `statement_import.period_start`/`period_end`, which is the contract; those two are currently derived by `NodeCsvParser` as the minimum and maximum `effective_date` of the rows that parsed, so no row can fall outside them by construction. | The requirement is right and the implementation is honest — the moment `detect` reads the period off the statement header, which the Northgate fixture prints two lines above its columns (`Statement Period: 01/01/2026 - 01/20/2026`), a row dated outside it is exactly the misparse this warning exists to catch. What the UI must not do is render a strip that cannot light up and let it read as a check that passed, so the review header labels the period as derived from the rows. The alternative — clustering the dates in the UI and flagging stragglers — was rejected: it puts an uncalibrated threshold (§7.6) in a `type:feature` lib and duplicates a judgment `type:parsing` owns. |
| 6.1 | **The account confirmation is a gate on the whole review, not a field on it.** The page shows no plan and no reachable Commit until `PATCH /api/imports/:id { accountId }` has landed. | §6.1 says the guess "must be confirmed" and reads as a form field, but §3.3's merge rule counts rows *within an account*: `GET /api/imports/:id` therefore returns `plan: null` and every disposition is `insert` until an account exists. A screen that showed a duplicate count before the account was chosen would be showing a count against no account — and the count is the number on which the reviewer authorises the commit. |

One implementation detail is worth recording because it is a trap rather than a choice.
**A `resource`'s params must not read that resource's own value.** The column mapper previews
a draft whose `columnMap` addresses columns by header name, and the header names arrive in the
preview response; deriving the draft from the response made the preview's params a consumer of
the preview's result. That cycle does not throw — the signal graph stops propagating, and every
dropdown change after the first previews nothing at all. The roles are keyed by header name
instead, which removes the read and matches what a saved `column_map` addresses anyway.

## 9c. Amendments from implementation — 2026-08-11 (§5.2)

Building `libs/ledgerline/analyzers` — the shared finding contract (§5.1) and the recurrence
rule (§5.2, §5.3) — found two places where §5.2's algorithm is under-specified in a way that
changes its output. Both are gaps being filled rather than rules being overridden, and both are
recorded because a threshold or a tie-break that only exists in code is a number nobody
reviewed.

| § | Amendment | Why |
|---|---|---|
| 5.2 | **The cadence fit needs a stated tie-break, and "best score wins" is not one.** Ties go to the cadence assuming the fewest missed cycles — the lowest mean `k`. | §5.2 scores a cadence by `median(\|r\|)` and allows `1 ≤ k ≤ 3` so that a missing statement does not lose the series. Those two rules together make exact ties the *normal* case rather than a rarity: a run of 14-day gaps fits **weekly** with `k = 2` and a residual of exactly zero, scoring identically to biweekly with `k = 1`. Every cadence is degenerate with its own multiples this way. Without a stated tie-break the implementation falls back to declaration order or to "shortest", either of which reads every biweekly series as a weekly one that skips and every four-weekly series as a biweekly one that skips — **halving the annualized cost of all of them**, which is the same class of error the four-weekly/monthly tie-break exists to prevent and 6× larger. Fewest assumed missing charges is the parsimonious reading: it does not invent eleven skipped charges that left no trace on any statement. |
| 5.2 | **The single-charge annual exception is scoped to the merchant, not to the amount cluster.** "A single large charge at a known-subscription merchant" means the merchant has one charge in the imported window. | Read as a property of the cluster, it fires once per cluster: a known-subscription merchant whose amounts are too spread to group produces several one-charge "possible annual subscription" series at once, all describing the same merchant. That is both wrong on its face and exactly the false-positive volume §5.1's emission budget exists to bound. |

One thing §5.2 leaves genuinely open is left open. "A single **large** charge" is not quantified,
and no threshold was invented for it: §5.1's absolute impact floor already decides whether the
resulting finding is worth showing, and it is a stated, configurable number. Adding a second
one here would be a threshold with no reasoning attached.

The `1 ≤ k ≤ 3` bound also has a consequence worth stating, because it is not obviously
desirable and it is implemented verbatim: a monthly series with a six-month hole fails the
monthly fit outright rather than fitting it with a larger `k`, so a subscription that paused
and resumed produces no series at all. That fails toward silence rather than toward a wrong
cadence, which is the direction §5.1's noise argument prefers — but it is a real miss, and
`recurrence.spec.ts` pins it.

## 9d. Amendments from implementation — 2026-08-11 (§5.4–§5.7)

Building the four rules that consume §5.2's series found one place where two sections
interact badly enough to hide §5.5's own worked example, and three places where a rule is
silent on something it cannot avoid deciding.

| § | Amendment | Why |
|---|---|---|
| 5.5 | **A price step is detected over the charge sequence, not over §5.2's amount clusters**, with its own "different price level" threshold (default $0.50) separate from the clustering tolerance. | Deriving steps from pass 1's clusters is the tempting reading — pass 2 merges them precisely because they are one subscription over time — but it silently bounds the smallest detectable step at `max(5%, $1.00)`. That hides **the example §5.5 uses to justify its own noise floor**: a $3.80 rise on a $200/month subscription is 1.9%, under the clustering tolerance, so it never becomes a step and the floor stated in cents never gets to judge it. §5.5 defines a step as "an amount change that **holds** for a cadence-appropriate number of consecutive occurrences", which is a property of the sequence; implementing it that way makes the section's own example work. A level shorter than the requirement *inside* the series is absorbed as proration noise; a short level at the *end* is the new price and is reported unconfirmed. |
| 5.2 | **`amount_stability` is measured over the newest price level that actually held**, not simply the newest. | §5.2 defines it as the CV "within its current price step". Once steps are sequence-derived, the newest level is often a single charge — and one charge has a coefficient of variation of exactly zero, which reports a series whose amount wobbles every month as perfectly stable and pushes it a band higher than the evidence supports. |
| 5.6 | **Halving confidence in the pre-window blind spot may not push a finding under §5.1's suppression threshold.** It floors at the bottom of the Low band. | §5.6 says confidence is halved and "The UI says so on the finding **rather than hiding it**" — but halving hides it, and in the ordinary case rather than a corner: the minimum emittable score is two points, which is 0.60, and 0.60 halved is 0.30 against a suppression threshold of 0.35. Taken literally the two sentences contradict each other for every two-point finding. |
| 5.6 | **`impact_kind` is `visibility`.** §5.6 does not state one. | `savings` is the intuitive reading — a converted trial is the classic "cancel this" case — but its impact would be the series' whole annual cost, and §5.4 already claims a duplicate series' annual cost as `savings` while §5.5 claims its price delta. Two of those three can describe one series, and §7.3 forbids two findings claiming the same dollars as `savings`. §5.1's three examples of savings pointedly do not include a converted trial. |

Two more resolutions worth naming, both of which fill a silence rather than change a rule.
§5.4's category overlap reads the **merchant's** `overlap_group` first and the charges'
categories second, because a series has a merchant but no single category and §3.1 puts the
column on both tables; the category path is dead today, since §9a records that
`SEED_CATEGORIES` leaves `overlap_group` unset on every row. And §5.7 emits **zero** impact
with the former cost in the detail, because a lapsed series is not money being spent and
claiming its cost would inflate every total with subscriptions that already stopped — which is
also what makes that rule's exemption from the $25 floor load-bearing rather than a nicety.

## 9e. Amendments from implementation — 2026-08-14 (§5.1, §2.7)

Wiring the analyzers to the app — §2.7's job runner, `buildSnapshot()`, finding persistence and
§2.3's analysis endpoints — ran §5's rules over stored data for the first time. Five places
needed a decision this document does not make. Four are silences being filled; one is a column
that §3.1 does not have and §5.1 requires.

| § | Amendment | Why |
|---|---|---|
| 3.1 | **`finding_state` gains `dismissed_config_hash`** (migration `002`). | §5.1 names two different reasons a dismissed finding comes back and asks that they be told apart — "changed since you dismissed this" for a moved evidence hash, and "re-evaluated with an improved rule", *"grouped separately"*, for a `config_hash` bump. The evidence hash cannot answer the second, and deliberately so: §5.1 fixes its inputs as `(rule_id, subject_id, amount, cadence_label, series_status)`, and a hash that absorbed the config would make every threshold edit read as a price change. So the config in force **at the moment of dismissal** has to be recorded, and §3.1's `finding_state` had nowhere to put it. Nullable, so a row written before the column existed does not resurface as "re-evaluated" on the strength of having no answer. |
| 5.1 | **A finding covered by a standing `dismissal_rule` is `suppressed`, a third lifecycle status alongside `active` and `resolved`.** | §5.1 gives absence exactly one meaning — "a finding present in the previous run but absent from the current one becomes `resolved`" — and §3.1 makes `dismissal_rule` "a standing filter applied at emit time", which produces absence from the emitted set. Taken together, dismissing a rule would mark its findings `resolved`, which is a claim about *the data* ("this stopped being true") being used to record a claim about *the user* ("stop telling me"). The two then become indistinguishable, and deleting a dismissal rule reads exactly like a cancelled subscription coming back. `suppressed` keeps the run's numbers current on a finding nobody is being shown, which is what makes lifting the rule restore precisely what it hid — `first_detected_at` included. |
| 2.7 | **The in-process runner holds a short window (250 ms, uncalibrated) before it drains.** | §2.7 asks for two things that only look like one. Coalescing — "a second renormalize request while one is queued merges into it rather than stacking" — requires a job to *stay* queued long enough to be found, and a runner that drains on the next tick gives it no such window. §2.7's own answer is a debounce, but it puts it in the UI: "Merchant corrections in the UI are debounced 5 seconds and batched." That covers the batching path and nothing else — a run of individual `PATCH /api/transactions/:id` corrections arrives as a run of requests however patient the page is, and each one would otherwise mean its own re-normalize **and its own full analysis**, which is the outcome the coalescing sentence exists to prevent. The window is far shorter than five seconds because it has a smaller job to do: the UI's debounce makes eight clicks one request, this one only has to make several requests one run. |
| 5.1 | **A series that a run stops producing is deleted with a tombstone, not resolved.** | §5.1's lifecycle is written about findings and `recurring_series` is not one. A finding that stops being true is information; a series that stops being produced is not a subscription that ended — §5.2 marks that one `lapsed` and still emits it. It is a series whose charges were re-grouped, almost always because a merchant correction merged two spellings (§4.3), and keeping the superseded row would show §6.5 a duplicate and hand §5.4's same-merchant multiplicity rule a finding built out of the user's own correction. The cost is real and is accepted rather than overlooked: §6.5's three user-owned columns — `cancellation_url`, `notes`, `user_status` — go with a series that re-groups. They survive every ordinary re-run, because §5.2's series id is derived from merchant, account and anchor date precisely so that it is stable. |
| 3.1 | **`recurring_series.cadence_days` and `cadences_per_year` hold fractional values despite being declared INTEGER**, as does `confidence` despite being declared TEXT. | §5.2's cadence table is fractional by design — `monthly` is 30.44 days and `weekly` is 52.18 a year, because a calendar month is not 30 days and a year is not 52 weeks — and §5.5's annualization multiplies by those figures. SQLite's INTEGER affinity stores a REAL it cannot losslessly narrow as a REAL, and TEXT affinity round-trips a number through its shortest decimal form, so every value survives and the repository converts at the boundary. Nothing is broken today. It is recorded because §3.4 plans an Elasticsearch re-index, and a mapping generated from these declared types would truncate `cadence_days` to 30 and turn a subscription's annual cost into a number 1.4% wrong — silently, and only for the calendar cadences. |

One further silence was left where it was found. §5.1 says a `rule_version` bump resurfaces a
dismissal alongside a `config_hash` bump, but every rule currently sets `rule_version` to its own
`rule_id`, so the two are one test in practice. That is the analyzers' business rather than this
phase's, and inventing a version string here would have been a number nobody reviewed.

The dataset these rules first ran over is generated in `apps/ledgerline-api/src/analysis-api.spec.ts`
rather than committed to `fixtures/`, and it is worth saying why, because §7.6 is about exactly
this. §5 needs *years* — a fitted series is three or more charges at a cadence, a price step has
to hold, and "lapsed" is measured in multiples of a cadence against §7.2's coverage end. The
committed fixtures are three statements covering two months and produce no series at all. The
generated statements are posted through `POST /api/imports` like any other file, so coverage comes
from `statement_import` and the merchant ids come from §4's chain — but they remain **synthetic**,
and §7.6's calibration against a hand-labelled year of real statements has still not happened.

## 9f. Amendments from implementation — 2026-08-21 (§2.6, §6.2)

Building §2.6's transfer matcher and §6.2's Accounts page together — the matcher because
nothing was setting `is_internal_transfer`, the page because §2.6's middle band has nowhere
else to appear — needed six decisions this document does not make. Two are columns the schema
does not have, one is a signal that turned out to be unreachable as specified, and three are
silences.

| § | Amendment | Why |
|---|---|---|
| 3.1 | **`transfer_link` gains `detail_json`** (migration `003`). | §6.2 asks the queue to show "proposed pairs with both rows, **the score's reasons**, and the dollar effect of confirming", and §3.1's `transfer_link` carries the score and nothing that explains it. The reasons are the half that matters: a queue of unexplained pairs gets confirmed by reflex, and confirming by reflex is §2.6's false-link path with extra steps. They cannot be recomputed at read time either — §2.6's signals are read off the snapshot *as it was when the pass ran*, and a merchant correction, a later import or the series a subsequent analysis produced all move them, so a re-derived explanation would show a user reasons that are not the reasons the pair was offered under. Free-shaped JSON, exactly as `finding.detail_json` is; nullable, because a row written before the column existed has no answer and inventing one would put words in the matcher's mouth. |
| 3.1 | **A link *group* is `(credit_transaction_id, state)`, and confirm and reject act on the group.** | §3.1 models a link as one debit and one credit; §2.6's partial-payment pass produces one credit against up to three debits, which is therefore two or three rows. `ix_transfer_link_credit` already exists and reads them back in one lookup, so the credit is the natural identity — and half a split payment linked and half not is a state no total could be computed from. The **state** is part of the key rather than the credit alone because one credit can legitimately carry a pair the user rejected last month *and* a different pair this run proposed; grouping on the credit alone would silently merge a live proposal with a dead rejection. |
| 2.2 | **The analysis snapshot gains `description_raw`**, for §2.6's `last4` signal alone. | §2.6 scores +2 when "either descriptor contains the other account's `last4`", and §4.1's stage 3 strips masked account numbers on the way to a merchant key — `ONLINE PMT CARDINAL CARD XXXX9012` reaches `description_normalized` as `ONLINE PMT CARDINAL CARD`. The corroborator was therefore unreachable as written: not weakened, *never able to fire*. The projection in `analyzers/src/lib/snapshot.ts` documents itself as "a strict subset of what the table stores", and this widens it deliberately, with the constraint stated on the field: **no §5 rule may group, cluster or total on it.** Grouping on the raw descriptor is what normalization exists to prevent — four spellings of one merchant become four series — and it is here for substring *evidence* about one pair of rows. |
| 7.2 | **§6.2's coverage bar has three states — covered, partial, missing — not two.** | §7.2 makes a month covered only when "a committed import's `[period_start, period_end]` spans it". The periods this app holds are the **first and last row dates the parser saw** (`node-csv-parser.ts` fills them from the parsed rows; no format profile reads a statement's declared period), so an ordinary January statement running the 3rd to the 30th does not span January. Collapsing that into "missing" would be the inverse of the mistake §7.2's own commentary warns about — a red cell over a statement sitting in the database. Collapsing it into "covered" would promise §5.10 and §5.11 a complete month they are entitled to refuse. `partial` is the honest third answer, and it is precisely the state those two rules decline to compute over, so naming it on the bar tells the user why a finding is absent. The strict boolean stays on the wire as `covered` and is what every analyzer's own `coveredMonths` agrees with; `state` is presentation. **The underlying gap is not fixed here**: making the bar mostly green needs the parser to read a declared period, which is parser work and a profile field. |
| 2.6 | **The partial-payment pass applies the propose floor.** | §2.6 says the second pass "always proposes, never auto-links" and is silent on whether a group still has to clear `score ≥ 2`. It does. Arithmetic is much weaker evidence on this path than on the first: an exact-amount one-to-one match is already a coincidence worth scoring, while *any* three debits in a week that happen to total a credit qualify for the subset search. A group with no corroborating signal at all is exactly the noise §2.6's asymmetry says to leave out, so the floor applies and the disposition is a constant rather than a comparison. |
| 6.2 | **An account merge re-points history; it does not deduplicate it.** | §6.2 asks for "merge two accounts", which in practice is one account imported twice under two names — so the two very often hold the same rows. They cannot be merged away: §3.3's `dedupe_key` hashes the **account id** into its material, so one charge in two accounts has two different keys, the merge rule cannot see them as the same row, and §3.2's `UNIQUE (account_id, dedupe_key, occurrence_index)` never even fires on the re-point. Recomputing the keys would be a rewrite of frozen key material, which §3.3 permits only through a migration inside one transaction. So the duplicates survive and the user deletes the redundant import, which §3.3 already does precisely. The endpoint and the page both say so before the merge runs. |

Three smaller shapes, decided rather than asked. **`GET /api/transfers` is added to §2.3**,
which names the three *verbs* — propose, confirm, delete — and no read; §6.2 then requires a
queue "with both rows, the score's reasons, and the dollar effect", and a queue that cannot be
listed is the same "nowhere to appear" problem §6.4 was built to fix. **`POST
/api/transfers/propose` is synchronous**, unlike `POST /api/analysis/run`: both read the whole
snapshot, but this one then runs a single bucketed pass rather than nine rules over it, and
§6.2's queue is what the user is standing in front of when they press the button — a job id
would make them poll for a list that is already computed. And **`DELETE /api/transfers/:id`
sets state `rejected` rather than deleting the row**, because a deleted row is one the next
pass re-proposes; "no, that is not a transfer" has to be a durable answer rather than one said
once a month forever.

Finally, an analysis run now loads **two** snapshots, and that is not a violation of §2.2's
"one snapshot per run, not one per analyzer". That rule is about the nine rules sharing one
load — "nine independent loads would be nine times the query cost". The link stage is not one
of the nine: it *writes* `is_internal_transfer`, which every rule in §5 reads and every number
on §6.4 sums over, so a snapshot taken before it is stale by construction. Running the rules
against it would price a $500 credit-card payment as spending, publish the number, and correct
it only on the next run. Two loads, and the second is what makes the first correct.

## 9g. Amendments from implementation — 2026-08-21 (§5.8–§5.11)

Building the four remaining rules completed §5's nine. Each is specified in more detail than
§5.2–§5.7 were, so most of what follows is not a gap in the design but a case two branches of
one rule both cover — and §5.1 is unambiguous about which cost matters: "False-positive volume
is the failure mode that gets a tool like this abandoned." Four of the six below were found by
running the rules over two years of generated statements and reading what came out.

| § | Amendment | Why |
|---|---|---|
| 5.9 | **The global branch needs a minimum sample (50) before it will take a percentile.** | §5.9 sets one for the merchant branch (5) and the category branch (15) and none for this one. A 99th percentile over six debits **is** the largest of them by construction, so without a floor the rule announces "the largest charges of 2026" to anyone who bought a laptop — the same vacuous output §5.9 rewrote this branch to avoid, arrived at from the other direction. |
| 5.9 | **The percentile is taken over the filtered candidates, not over every debit.** | §5.9's conditions — above the 99th percentile, above $200, not in a recurring series, not an internal transfer — read as one list describing the debits being ranked, and the order the filters are applied in decides whether the branch works at all. A household's twelve rent payments occupy the entire top of the distribution, so a percentile taken *before* excluding them sits above every one-off charge — and the one-off charge at a merchant with no history is the only thing this branch exists to find. Confirmed against the corpus: with rent inside the percentile, a $1,900 charge in a year of $2,200 rents is invisible. |
| 5.9 | **A charge flagged by both its merchant and its category is reported once, against the merchant.** | §5.9 lists the two as separate branches and does not say what happens when they agree. On real data they agree constantly — any category with one dominant merchant produces every finding twice. Over the corpus this was 15 findings where 8 were meant: the same seven charges as "$164 at Trader Joe's" and again as "$164 at Groceries". The merchant survives because it is the more specific comparison and the better sentence. |
| 5.10 | **A climb is a maximal run of increases, found once and measured end to end.** | §5.10 says "three consecutive monthly increases" and caps emission at five climbs. A category that rises for eight months satisfies that test in six overlapping windows, so one sustained climb fills the whole budget with one story — and each card reports an arbitrary three months of a longer rise. Making the run the unit fixes both: two separate climbs in a year remain two runs, and the reported figure is the whole rise. |
| 5.8 | **The rollup's impact is the avoidable subset; the total travels in the detail.** | §5.8 asks for "**one rollup finding per account**" and, in the same breath, for recurring maintenance fees to be "the part that carries `impact_kind = savings`; the rest is `visibility`". A `Finding` carries one `impact_kind`, so both cannot hold literally. Putting only the avoidable subset in the impact satisfies §7.3 exactly — the headline gets the money a waiver could recover and nothing else — while the full total stays on the card. An account with nothing avoidable emits the same one card as `visibility` with the total as its impact, because otherwise §5.1's $25 floor would suppress a real $340/yr fee total for having no recoverable part. |
| 5.11 | **A category that is one qualifying merchant restated is not a second finding.** | §5.11 says "Merchants **or** categories" and both are worth having: the merchant answers "how much at this one place", the category answers "how much on this kind of thing". They are the same finding when the category is one frequent merchant. Suppressed by the dominance test §5.10 already uses, at the same 80%. A category made of thirty small merchants — none frequent enough alone — survives, and is exactly the case the category half exists for. |

Two smaller decisions. **`fees.v1` annualizes over the span between the first and last fee**,
not over the account's coverage: a card with two years of statements and one $35 fee in its
first month must not report $420/yr. And **§5.8's reversal netting is left as literal as that
section states it** — same account, same amount, inside 60 days — rather than narrowed to
credits that also look like reversals. It can over-net: an unrelated $35 deposit inside the
window cancels a real fee. That direction is the one §5.8 chose and says why, because "a
refunded fee that still shows in an annual total is the kind of error that costs the whole tool
its credibility" and a missing line item is not.

**Two of the four cannot fire on today's data, and neither is a defect in them.** §5.10 and
§5.11 are gated on §7.2's fully-covered months, and §9f already recorded why almost no month
qualifies: `period_start` and `period_end` are the first and last row dates the parser saw, so
an ordinary statement running the 3rd to the 30th does not span its month. §5.10 needs a
category as well, and nothing assigns one — §2.5's `normalize` stage lists "Category assigned by
rule, then optionally by LLM" and only the merchant half is built. Both were confirmed by
running the rules over the corpus: with statements extended to the month boundary and categories
applied through §6.3's bulk path, both fire and produce the numbers §5.10 and §5.11 describe.
**Until the parser reads a declared statement period and the categorizer exists, those two rules
are correct and silent.**

The corpus is generated rather than committed, for the reason §9e gives and §7.6 insists on: it
is synthetic, and §7.6's calibration against a hand-labelled year of real statements has still
not happened. What it demonstrated is that the rules run over the real pipeline and that §7.3
holds with a new `savings` emitter in the set — the headline came to exactly the sum of the
three savings findings, with `micro.v1`'s $1,459/yr and `outlier.v1`'s $4,120 correctly outside
it. `micro.v1` reproduced §5.11's own illustration, $1,459/yr for coffee, out of the §4 chain's
own merchant grouping rather than a hand-built fixture.

## 9h. Amendments from implementation — 2026-08-23 (§2.5, §7.2)

Closing the two gaps §9f and §9g diagnosed — the parser never read a declared statement period,
and nothing assigned a category — made §5.10's `trend.v1` and §5.11's `micro.v1` emit. Neither
rule changed. Both were already correct; they were starved, and this is the food. The work
needed six decisions this document does not make: two are a field the schema does not have, one
is a filter §4.3 implies without naming, and three are silences.

| § | Amendment | Why |
|---|---|---|
| 3.1 | **`format_profile` gains `period_pattern`** (migration `004`), a regex with two capture groups matched against the preamble. | §7.2 makes a month covered when a committed import's `[period_start, period_end]` spans it, and §9f recorded that those two were the first and last **row dates** — so an ordinary January statement running the 3rd to the 30th did not span January, `fullyCoveredMonths` was empty for essentially every account, and the two rules gated on it were correct and silent. Where the fix belongs is not a judgment call: the period is a fact about *this bank's export*, printed above the header in the same block as the account number, and §2.5 already makes the profile "where every bank's disagreement gets absorbed". Scanning the preamble rather than the file keeps the search bounded to the handful of lines `skip_lines` already names and stops a pattern reading a period out of a transaction descriptor. |
| 3.1 | **The pattern locates the dates; `date_format` reads them.** | The obvious pattern spells the date shape out — `(\d{2}/\d{2}/\d{4})` — and that is two sources of truth for one fact, of which the copy inside the regex is the one nothing validates. `01/02/2026` is two different days depending on the bank and the string does not say which, which is the whole argument in `domain/dates.ts`; the profile already answers it once, in `date_format`, and the period is parsed through `parseDateToIso` against that answer like every row date. Keeping the groups loose also means a bank changing `-` to `to` is a one-token profile edit rather than a rewrite. |
| 2.5 | **Optional, and a *malformed* pattern is an error rather than a fallback.** | Most exports declare nothing: `profiles/cardinal-card.json` and `profiles/harbor-savings.json` both have `skip_lines: 0` and no preamble at all, so the row-date derivation stays and stays correct — it is the designed answer for a file with no declaration, not a legacy path. What must not share that answer is a pattern that was *supposed* to work: a typo falling back silently produces behaviour indistinguishable from correctness, and the symptom surfaces weeks later as months that will not go green, pointing at §7.2 rather than at the profile. `validateProfile` refuses it eagerly, beside a missing amount column. A pattern that compiles but finds nothing in a given file, or captures dates that do not read as `date_format`, is the third case — the profile is fine and this file is not — so it falls back **with a warning** rather than failing the import. |
| 2.5 | **The rule-based categorizer is one line: a resolved merchant's `default_category_id` is the transaction's category, stamped `category_source = 'rule'`.** | §2.5's `normalize` stage says "Category assigned by rule, then optionally by LLM" and specifies neither. The temptation is a keyword table — a second chain over the descriptor, with its own precedence and its own disagreements with §4 about what a row's merchant is. There is no need: the §4 chain already answers the hard question, `merchant_canonical.default_category_id` is already in the schema and already on the wire, and a category is a property of the merchant. The seed set carries the ids; a provisional merchant has no default and the rule says nothing rather than guessing. §7.6 governs every assignment exactly as it governs the merchant list itself. |
| 4.3 | **`TransactionQuery` gains `excludeUserCategorized`, and the re-normalize sweep uses it.** | §4.3 makes a user correction "permanent and beats everything", and the one place a rule could quietly overrule it is §2.7's re-normalize: a merchant correction repoints four years of history, and under this amendment the merchant's default category rides along. On a row the user categorized by hand it must not. A filter rather than a conditional `UPDATE`, because "which rows" is a filter question and because the merchant half of the same sweep still has to touch **every** row — a hand-picked category is not a reason to leave a merchant wrong. Two passes over one descriptor, selecting two different sets, says §4.3's precedence out loud instead of encoding it in SQL. |
| 4.3 | **A correction that lands on a merchant with no default *clears* the rule's category rather than keeping it.** | The alternative strands the old answer: a row moved from a merchant defaulting to `dining` onto one with no default would keep trending as `dining` under §5.10 forever, and the user's evidence that it was wrong is exactly the correction they just made. The rule now says nothing about that row, and saying nothing is a real answer — `category_source` returns to null and the row is uncategorized, which is where it would have started had the correct merchant resolved first. A `user` category is untouched either way. |

**§7.2 is unchanged, and `partial` is not.** This amendment makes more months *genuinely*
covered; it does not weaken the spanning test, which §9f already considered and rejected
weakening. §6.2's bar keeps all three states because the middle case is real — two half-month
statements of one month leave the middle unproven and §7.2 declines to guess, a mid-cycle export
covers what it covers, and a bank whose preamble no profile reads yet still lands on row dates.
What changes is the frequency: `partial` was every cell and is now the exception.

**Three smaller calls.** A **backwards declared period** — end before start — is treated as a
non-match and warned about, never silently swapped: which capture group is the start is the
profile's own claim, so a reversed pair means the profile is wrong about its file, and a period
that ends before it starts costs the import all of its coverage rather than some of it.
**§6.1's "dates outside the detected period" is now implemented** (`rows_outside_period`), and
only became askable here: against a period derived from the same rows it was true by
construction. The rows are kept — a late-posting charge is real — and the warning says coverage
is claimed for the declared window only. And **only `user` is protected from re-categorization**,
not everything §4.3 ranks above `rule`: nothing writes a `seed` category today, and §4.2's `llm`
stage when it lands must *lose* to a rule rather than beat it, so a general precedence ladder
here would be wrong in one direction or the other. `category_source` is what a later amendment
will read to make that call properly.

**The backfill question, decided both ways.** §6.1 refuses a re-parse on a committed import, so
neither gap fixes itself for statements already in the database — and leaving that ambiguous was
not an option. The two answers differ because the two backfills do:

- **Categories are backfilled, automatically.** The categorizer is a property of the merchant, the merchant was resolved when those rows were committed, and the answer for a two-year-old row is the answer it would get today — so there is nothing to re-derive and no file to re-read. It runs in the composition root beside the seeding, guarded on `category_source IS NULL`, which excludes both the rows a rule already did and the ones a human deliberately cleared. Idempotent, so the second boot matches nothing. A backfill nobody has to remember to run is one that has actually run.
- **Periods are not.** That one *is* a re-read of the stored bytes, and it would rewrite the reviewed period of an import a human already accepted — a second, narrower re-parse path beside the one §6.1 refuses, with the same objection against it. The honest answer is the one §3.3 already makes exact and lossless: delete the import and re-import the file. `DELETE /api/imports/:id` exists, and re-uploading is idempotent by file hash. Recorded here so that a coverage bar with old grey cells in it is a known state with a known remedy rather than a mystery.

## 9i. Amendments from implementation — 2026-08-25 (§6.5, §2.3)

Building §6.5's Subscriptions page and the three `/api/series` routes behind it needed six
decisions this document does not make. One is a column the schema does not have, one is a sign
convention that is not guessable from the field names, and four are silences — three of them
about what a *user* owns on a row every analysis run rewrites.

| § | Amendment | Why |
|---|---|---|
| 3.1 | **`recurring_series` gains `charges_json` and `price_steps_json`** (migration `005`). | §6.5's drawer asks for "the full charge history as a chart with price-change markers" and "the price-step table", and §5.3 already makes both part of the series contract — "a series exposes ... the ordered charge list, and the **price steps** derived in §5.5". `recurrence.v1` computes both on every run; §3.1 stored the scalar summary and dropped them. Re-deriving at read time is what §9f refused in the identical case of `transfer_link.detail_json`, and §5.3 refuses it outright — "a second implementation of cadence inference is a second set of thresholds to keep in sync". It would also answer with *today's* grouping rather than the run's: a merchant correction (§4.3), a later import, or a re-run under a different `config_hash` all move which charges a series is made of, so the drawer would chart a history the series was never fitted from and mark steps the analyzer never found. Free-shaped JSON, as `finding.detail_json` is; nullable, because a row written before the column existed has no answer and the next run fills it in. |
| 2.3 | **`amount_cents_current` is a magnitude; `charges[].amount_cents` is signed.** | Not guessable from the names, and getting it backwards is silent. §5.2 derives the series amount as "the median of the current price step", which is a price and therefore positive — the same convention §5.5 states for its steps. A charge is a transaction as stored, so it keeps §3.1's house convention where negative is money leaving. The consequence is that `annualCents` multiplies straight through and only `totalPaidCents` takes absolute values. Pinned by a test rather than left to a comment, because the failure mode is an annual figure that is negative, which also silently inverts the annual-cost ordering §6.5 is written around — two wrongs that agree with each other and so look right. |
| 2.3 | **`GET /api/series` computes `annualCents`, `monthlyCents`, `totalPaidCents` and `effectiveStatus`.** | §5.2 already fixes the reason for the first three: "`cadences_per_year` is stored on the series, not recomputed per rule, so §5.5's `delta × cadences_per_year` and the Subscriptions page's annual totals cannot disagree." A client-side multiplication would put that arithmetic in a second place and hand §6.5's default sort a number the API never saw. `effectiveStatus` is `COALESCE(user_status, status)` — §6.5's "a manual status always beats the computed one", resolved once so the page and §6.4's headline cannot disagree about how many subscriptions are active. `totalPaidCents` is deliberately **not** derived from the rate: §6.5's "total paid to date" is the sum of the charges actually observed, which is a different number from `annualCents × years` for every series that has ever changed price or missed a month. |
| 6.5 | **An omitted field on `PATCH /api/series/:id` is left alone; an explicit `null` clears it.** | §6.5 names three user fields and does not say how one is unset. The distinction is load-bearing for `user_status` specifically: its fourth state is not the absence of a preference but a distinct choice — *let §5.2 decide* — and a shape that could not express it would let a user override a status and never get back to the computed answer. So the three fields are optional rather than nullable-required, no schema `default` is declared (Fastify would apply it to the body and make omitted indistinguishable from deliberate, which is the trap §9b already recorded for the column mapper), and `patchSeries` writes only the columns the patch names. In the UI the same distinction is three buttons rather than a checkbox, and clicking the status already in force clears the override. |
| 6.5 | **A user-entered `cancellation_url` must be `http` or `https`.** | §6.5 asks for "a user-entered cancellation URL" and the drawer renders it as a link, which makes a stored `javascript:` URL one click from executing inside the page. An allow-list of two schemes, not a blocklist: `javascript:`, `data:` and `vbscript:` are the ones anybody thinks of, and a blocklist is wrong the first time a browser ships a fourth. Empty and `null` are both accepted and both mean "no URL" — refusing them would leave a bad URL unremovable, and storing `''` would make "no URL" two values the page had to know about. |
| 6.4 | **"Open subscription" deep-links on `subject_id`, and the target overrides its own filter.** | §6.4 lists the action and §6.5 describes the destination; nothing says how one reaches the other. No lookup is needed — a series finding's `subject_id` **is** the series id, by §5.1's natural key — so the link carries it as a query parameter and the page opens that row's drawer. The wrinkle is that §6.5's ledger defaults to what is live, while §5.7's findings are very often *about* a series that stopped charging: arriving on a page that has filtered away the row you asked for reads as a broken link. A selected row is therefore always in the list whatever the filter says, and is still honestly labelled as not live. |

**Three smaller shapes.** §6.5's month strip places a subscription on the **modal day of its
observed charges**, not on `next_expected`: §5.2 measures that projection against the account's
coverage end, so for a lapsed series it is a date in the past that never happened, and for a
weekly one there is no stable day of month at all. Ties break to the earlier day, which is the
conservative reading for cash flow. All 31 cells render regardless of the current month's
length, because shrinking the strip would move the same series between positions month to month
and the shape staying put is the whole point. And the drawer's chart is deliberately **not
zero-based** — a rise from $15.49 to $17.99 is 16%, and against a zero baseline that is two
marks at the same height, which is the one thing the chart exists to show — so the axis frames
the range the prices occupy and the caption states both bounds.

Finally, **the ledger arrives sorted and the page does not re-sort it.** §6.5 names the ordering
and the reaction it is after: "sortable by annual cost, which is the view that produces the *I
pay what for that?* reaction". Since `annualCents` is computed server-side from the stored
`cadences_per_year`, sorting in the page would mean deriving it in the page as well — so the API
returns the list in that order and the page renders what it was given.

## 9j. Amendments from implementation — 2026-08-25 (§2.2)

Two decisions from one bug. `nx build ledgerline-ui` had never been run by anything, and the
first time it was, its production configuration failed — at the §6.5 commit that surfaced it
and at every commit before it. The failure was real and the fix is a boundary, not a flag.

| § | Amendment | Why |
|---|---|---|
| 2.2 | **`domain` ships two entry points, split by platform.** `@metrum/ledgerline-domain` is loadable in any runtime; `@metrum/ledgerline-domain/node` holds the half that is not, currently `dedupeKey` and `DEDUPE_KEY_VERSION`. | §2.2's hard rule for `domain` is "pure types and arithmetic, no I/O, no framework", and §3.3's key honours it — `createHash` is arithmetic over bytes, and the key lives in `domain` precisely so `data` can reach it without reaching the §4 normalization chain. What the tag graph cannot express is that a lib may legitimately *depend on* `domain` and still must never *load* half of it. One `export *` barrel put `node:crypto` in the import graph of all six §6 pages that import `formatCents`, and esbuild refused to resolve it for the browser. The entry point is named for the property that decides membership — reaches for `node:*` — rather than for the feature inside, so the next Node-only helper has an obvious home and each call site's import line says which half it asked for. Deliberately **not** `platform: 'node'` or a crypto polyfill: both ship a Node shim to a browser to support a function the browser must never call, which is this boundary violation with its only symptom removed. Nothing hashed changes — the material string, the field order and the literal separator §3.3 freezes are untouched, and `collapse.spec.ts`'s golden tests pin them unedited. |
| 2.2 | **`build` joins `lint`, `typecheck` and `test` in `npm run check`.** | This section already says a lint rule nobody runs is not enforcement; a build nobody runs is the same claim. `check` ran three targets and never a build, and the Angular `test` target bundles a *test* harness rather than the app, so no command in the repo or the local loop exercised the production bundle — which is how a broken build survived unnoticed. All ten projects are green under `nx run-many -t build`, so on a clean tree the addition is a cached no-op, and in exchange it catches the one class of error the other three targets structurally cannot see: a module that lints, typechecks and tests cleanly and still cannot be bundled for the platform it ships to. It also makes `ledgerline-ui`'s initial bundle visible at 502.75 kB against a 500 kB warning budget — a warning, not a failure, and now one that is reported on every run instead of never. |

## 9k. Amendments from implementation — 2026-08-25 (§6.8, §7.4)

Building §6.8's Settings page needed six decisions this document does not make, and one
admission it does not currently contain: **two of §6.8's six sections cannot be built at
all yet**, and a page that quietly shipped four of six would read as finished.

| § | Amendment | Why |
|---|---|---|
| 7.4 | **Every §5 rule gains `enabled` in its own config section, and the gate applies to the *emission* rather than the run.** | §6.8 asks for "per-rule enable" and §7.4 puts every other knob in the config object, so this belongs there too — §5.4 already had `sameMerchantEnabled` and `categoryOverlapEnabled` and set the precedent. Putting it in the config is what makes turning a rule off move `config_hash`, which is what makes §5.1 re-evaluate that rule's dismissals when it comes back; a switch stored anywhere else could not do that. Gating the emission and not the computation is the load-bearing half: §5.2's series feed §5.4–§5.7 and are the whole of §6.5's page, so a disabled `recurrence.v1` must silence its finding and leave the ledger standing, and §5.5's first-transition set feeds §5.6 the same way. A disabled rule emits **nothing** rather than suppressed findings, because §5.1's `suppressed` means "a standing dismissal rule hid this" and conflating the two would put a dismissal count on a rule nobody is running. |
| 2.3 | **`GET /api/settings` derives the editable surface from `DEFAULT_CONFIG` rather than declaring it**, and names what it refuses. | A hand-written list of tunable fields drifts the first time §5 gains a threshold, and the drift is silent — the new number simply never appears. Walking the defaults and reporting the scalar leaves cannot drift. The non-scalars are skipped deliberately and returned in `unsettable` with a reason each: §5.2's cadence table is a list of `(days, tolerance, per-year)` triples and §5.1's confidence bands are three cut points that must stay ordered, and both are §7.6 calibration decisions rather than a number with a box round it. Reporting them as refused, with the reason, is what stops the next person adding a text input for them. |
| 2.3 | **A threshold and a rule switch are the same write.** | §6.8 lists "per-rule enable [...] and threshold overrides" as two features; they are one operation, because a rule's switch *is* a boolean field in that rule's config section. So both travel as `{ section, key, value }`, both move `config_hash`, and both take the same validation. An explicit `null` removes the override and restores the shipped default — the same "explicit null clears, omission leaves alone" shape §9i settled for §6.5's series, and the reason the UI can offer a reset at all. |
| 6.8 | **The re-evaluation warning is a count, scoped to the rule whose own section changed.** | §6.8 says "changing a threshold warns that dismissed findings in that rule will be re-evaluated". A banner on every field is a banner nobody reads, and a global count would warn about §5.2's dismissals when someone edited §5.10. `PATCH` returns `dismissalsAffected` for the touched sections only, and the page states the number or says nothing. |
| 3.4 | **`FindingQuery` gains `userStatuses`, because "dismissed" is not "hidden".** | The count above needs dismissed findings per rule, and the nearest existing filter — `visibility: 'hidden'` — returns dismissed **and** snoozed together. They are different: a snooze expires on its own, while a dismissal is what §5.1 reopens when `config_hash` moves. Counting them as one would overstate what changing a threshold disturbs, in the one message whose whole job is to be believed. Note the trap this sits on: `finding.status` and `finding_state.status` are both called `status` and mean §5.1's two different questions. |
| 2.3 | **`DELETE /api/data` takes a backup first, keeps `settings`, and re-seeds the reference rows.** | §2.3 names the wipe and `routes/data.ts` deferred it to "the Settings UI that confirms it", which is this. A typed confirmation stops an accidental click and does nothing about a deliberate one someone regrets; taking a copy immediately before the delete turns the only irreversible operation in this API into a recoverable one, and it costs a file copy of a database that is about to be emptied. If the backup fails the wipe does not run, because the point of taking one is that it exists. `settings` survives on purpose — §7.4's thresholds are configuration, not data, and clearing statements should not clear an afternoon of tuning §5 against them. The reference rows (§4's aliases, §5's categories, the format profiles) are re-seeded, because a wiped database should be a *fresh install* rather than an empty one: without them the next import invents a provisional merchant for every descriptor §4 already knows. |

**Two of §6.8's six sections are not buildable, and two more are not built.** §6.8's **LLM
provider** and **Redaction** both require §2.4's provider seam, which does not exist in
any form — there is no `none` / `claude-cli` / `ollama` to choose between, no health
probe to call, and no text leaving this machine to redact. A picker over three options
that all do nothing would be a lie with a dropdown on it. **Merchant aliases** and
**Categories** need write endpoints §2.3 lists and §1 counts as missing: the LLM review
queue, and category CRUD with §5.4's overlap groups. All four are rendered on the page as
stated absences with their reasons, for the same reason the shell's rail renders an
unbuilt section as a span rather than hiding it.

**Three smaller shapes.** The wipe empties every table **except `schema_migrations` and
`settings`**, using `defer_foreign_keys` rather than a delete order — SQLite ignores a
`foreign_keys` change inside a transaction, so deferring the checks to COMMIT is what
makes the order irrelevant while still refusing to leave an orphan behind. The
confirmation phrase is **duplicated in the client rather than sent by the API**: a phrase
the server hands you is one the client can echo back without a human reading it. And
`POST /api/data/export` is the second route that cannot go through the generated client
— `request()` calls `JSON.parse` on every body and a CSV export is not JSON — so it uses
the same `fetch` escape hatch `uploadImports` documents, and returns a `Blob` the browser
saves rather than a megabyte of statement text held in a signal.

## 9l. Amendments from implementation — 2026-08-26 (§5.2, §5.5)

The first real statement — a Chase credit-card export, 326 rows over eight months — parsed
without a single failure and then showed that two of §5's rules were wrong in ways no
synthetic fixture had reached. §7.6 said this would happen and that the first corpus is what
settles the numbers; these are the two corrections it forced, and one tension it opened.

| § | Amendment | Why |
|---|---|---|
| 5.2 | **A fitted series must be a *fee*: at least half its charges must sit on an exact-amount plateau** (`feePlateauShare`, default 0.5). | §5.2 fits a cadence and asks nothing about what the amounts *are*, and on real data that is not enough to describe a subscription. Across 119 Amazon purchases in eight months, some subset always falls on a monthly rhythm — so §5.2 reported "12 active subscriptions, $553/mo" on a card whose real ones numbered five, and handed §5.4, §5.5 and §5.7 the same phantoms to build on. The test is exact-amount repetition rather than a dispersion, because that is what a fee *is*: the same number, over and over. A coefficient of variation cannot tell two tight plateaus from a narrow scatter, and §5.2's own `amount_stability` is computed *within the current price step*, which makes a one-charge step perfectly stable by construction — precisely the shape a scatter produces. A price change is still one series: two plateaus are both plateaus, so the measure stays at 1.00 across it. The two annual exceptions are exempt — a single charge cannot repeat, and an annual pair must already clear `amountStabilityCvCeiling`. |
| 5.5 | **A series whose price ended up *lower* is not price creep.** | Every part of the finding said "rose": the title, `impact_kind = savings`, and the money a cancellation would recover. A net decrease inverted all three and produced a card reading "Amazon price rose" carrying **−$1,875/yr**. §7.3 says only savings sum into a headline and never contemplates a negative one, so those findings did not merely look odd — they subtracted. On the first real statement roughly $4,435 of negative "savings" cancelled about $4,500 of genuine ones and left a headline of **$64.46/yr**. Individual steps may still fall, and the detail shows the whole path; the series has to be up on net to be creep. |

**What the two corrections did to that statement**, which is the measurement §7.6 asks for and
not a claim about correctness in general:

| | before | after |
|---|---|---|
| series fitted | 19 | 8 |
| "active subscriptions" | 12, $553.49/mo | 5, $231.23/mo |
| `duplicate.v1` findings | 2 (both phantom — "4 concurrent Amazon subscriptions") | 0 |
| `price_creep.v1` findings | 9, six of them negative | 2, both the same real price rise |
| `lapsed.v1` findings | 4, including "MCDONALDS appears cancelled" | 3 |
| §7.3 savings headline | $64.46/yr | $3,218.76/yr |

`outlier.v1` was unchanged at nine findings, correctly: it reads transactions rather than
series, and its output was already the most plausible thing on the page.

**Three things this did not fix, named so they are not rediscovered.** §5.2's pass 2 still
fails to merge one subscription's two price plateaus — the swim school appears as two series,
which is why it produces two `price_creep` findings and two `lapsed` findings for one thing.
Fixing that merge is also what would let `feePlateauShare` rise above 0.5: the one residual
false positive is a four-charge Amazon series where two charges happen to share an amount,
scoring exactly 0.50, and the same threshold that would exclude it currently excludes half of
the swim school. Second, `SAMSCLUB` and `SAMS CLUB` are one merchant in two — §4.3's user
correction is the designed answer and it has not been made. Third, `trend.v1` still emits
nothing: §9h's categorizer assigns a category from the resolved merchant's default, 62% of
these rows resolve to provisional merchants, and a provisional has no default — so there is
almost nothing to trend even with seven covered months.

## 9m. Amendments from implementation — 2026-08-26 (§5.2)

§9l named three things it had not fixed, and the first was that pass 2 still split one
subscription into two series. It was not that pass 2 failed to fire. Pass 2 fired on the wrong
pairs, and the merge it should have made was unreachable afterwards.

| § | Amendment | Why |
|---|---|---|
| 5.2 | **Pass 2's merge needs evidence about the amounts, not only about the rhythm.** Two groups that each fit a cadence and name the same one merge as before, unbounded. Where one side is too short to fit a cadence of its own, the two prices must be within `priceStepMaxAmountRatio` (default 3). | Pass 1 splits on amount and, until now, nothing after it looked at amount again: pass 2's whole test was "the union fits a cadence" plus an overlap bound. So any two groups of one merchant merged if their charges happened to land on a rhythm, whatever the charges were. On the first real statement a $14 fee and a $150 tuition charge merged because their union fit monthly with a median residual of 3.84 days against a ±4 tolerance, and a $150 purchase merged into three $8 ones by fitting biweekly with two missed cycles assumed twice. The bound cannot be unconditional, because an intro rate converting to full price is a genuine steep step and §5.6 suppresses its own finding only when §5.5 has seen that transition — hence the layering. Two runs that each fit are §5.2's literal test, "their independent cadence estimates agree"; the bound is what stands in for that test when one side has no rhythm to offer. |
| 5.2 | **`feePlateauShare` moves from 0.5 to 0.34.** | Both numbers that pinned it at half were products of the bad merge. §9l set it there because every genuine series scored 1.00 and the one surviving phantom scored exactly 0.50 — but that phantom was itself a bad merge, and pass 2 no longer makes it. Merged correctly, the subscription at issue turns out to be a **variable** monthly bill: only one of its amounts ever repeats, so it scores 0.40 and half threw it away entirely. Re-measured with the merge fixed, the phantoms score 0.29 and below and the genuine series 0.40 and above, so the threshold sits inside (0.29, 0.40] rather than on either edge. The test itself is unchanged — a fitted series must still sit on an exact-amount plateau. |

**The failure, in full**, because the shape is more instructive than the fix. The merchant has
eight charges: a monthly bill on the 25th, five of them, moving between roughly $150 and $250;
and three one-off charges on other days, an order of magnitude smaller. Pass 1 split that into
six amount groups. Pass 2 then walked the groups in ascending order of amount and merged the
first pair that fit — which was a fee group and a tuition charge, not two tuition groups. That
merge was not recoverable: it put charges a day apart into what became two rival clusters, and a
one-day gap fits no cadence in §5.2's table, so the two halves of the real bill could never
merge with each other afterwards. One subscription came out as two series, §5.5 and §5.7 read
each of them, and the hero page carried two "price rose" cards and two "appears cancelled" cards
for one thing.

**What the corrections did to that statement**, which is the measurement §7.6 asks for and not a
claim about correctness in general:

| | before | after |
|---|---|---|
| series fitted | 8 | 6 |
| series for the merchant at issue | 2, covering 7 of its 8 charges | 1, covering the 5 that are the bill |
| "active subscriptions" | 5, $231.23/mo | 4, $212.82/mo |
| `price_creep.v1` findings | 2, both the same thing | 0 |
| `lapsed.v1` findings | 3 | 2 |
| §7.3 savings headline | $3,218.76/yr | $0.00/yr |

The six series that remain are the five real subscriptions on the card and §5.2's single-charge
annual exception. Nothing genuine was lost; the two that went were the split halves becoming one,
and the four-charge phantom §9l had left standing.

**The headline going to zero is the correction, not a regression.** §9l's $3,218.76/yr was those
two `price_creep` findings and nothing else — one of them comparing a fee against tuition. The
merged series reports no step at all, and that is right twice over: no amount in it holds for two
consecutive occurrences, so §5.5 finds nothing confirmed, and the one level it can derive runs
from a median of $209 down to $200, which §9l's own net-increase gate declines. A card reading
"price rose" over a bill that went 168, 250, 150, 250, 200 would be inventing a direction the
data does not have. On this statement no subscription's price rose, and $0.00 is the honest
number.

**This resolves the first discrepancy in §10, as a matter of fact rather than by decision.** §10
recorded that §5.2's Low band was dead code again for fitted series, because §9l's fee test
admitted only series that were amount-stable by construction, leaving `amount_stability` pinned
near 1 and a quarter of the confidence formula's range unusable. At 0.34 that is no longer true:
a variable-amount bill qualifies and carries `amount_stability` **0**. The subscription at issue
scores 0.593 with that term at zero, and a three-occurrence bill whose amount will not settle
scores **0.493** — inside Low. Which is the honest band for it: "something bills me monthly and I
cannot predict what it will cost" is a real subscription and a weak one. §10's measured floor of
0.575 survives as the floor for a series whose amount is *flat*; `recurrence.spec.ts` pins both
numbers.

**Two things this did not fix.** `SAMSCLUB` and `SAMS CLUB` are still one merchant in two, and
§4.3's user correction is still the designed answer. The same fault has a second instance worth
naming: the merchant at issue loses its `ICP*` prefix in the last two months of the statement, so
its final two bills sit under a second merchant and the series reads as lapsed in May rather than
running to the end of the window. That is why the `lapsed.v1` finding for it is honest about the
data and wrong about the world. And `trend.v1` still emits nothing, for the reason §9l gives.

§7.6 still applies to every number here. This is one statement from one account, and
`priceStepMaxAmountRatio` in particular is a bound whose only evidence is that the steps it must
keep run 1.02×–1.67× and the merges it must refuse run 6.25×–18×.

## 9n. Amendments from implementation — 2026-08-27 (§4.1)

§9m named two things it had not fixed and called them both instances of one fault. They are
not. One is a gap in §4.1's stage-2 table and is fixed here; the other is what §4.3's user
correction exists for and stays that way.

| § | Amendment | Why |
|---|---|---|
| 4.1 | **`ICP*` joins stage 2's processor-prefix table**, and the stage gains a note about how a missing prefix fails. | The bank printed one merchant both ways across eight months — `ICP*GOLDFISH SWIM SCHOOL` on the first six charges, bare `GOLDFISH SWIM SCHOOL` on the last two — so §4.1 produced two merchants and §5.2 could only ever see part of the subscription. This is the exact shape §4.1 already documents for `TST*` and `SQ *`; `ICP*` was simply not in the table, which §4 says is "expected to grow". Worth stating because the failure is silent: stage 1 keeps punctuation so stage 2 can match on it, and an unmatched prefix then reaches stage 6's tidy, which turns `*` into a space. The chain does not error, does not warn, and emits a clean name with the processor welded to the front of it. Nothing short of the same merchant appearing *both* ways would have surfaced it. |

**What it did to that statement:**

| | before | after |
|---|---|---|
| merchants for the swim school | 2 (8 charges + 2) | 1 (10 charges) |
| its series | 5 occurrences, `lapsed` | **7 occurrences, `active`** |
| `lapsed.v1` findings | 2 | 1 |
| `price_creep.v1` findings | 0 | **1, and real** |
| "active subscriptions" | 4, $212.82/mo | 5, $462.82/mo |
| §7.3 savings headline | $0.00/yr | $450.00/yr |

The `lapsed.v1` finding that disappeared is the one §9m called "honest about the data and wrong
about the world": the bill never stopped, it only stopped being recognisable. And the price rise
this now reports is the first genuine `price_creep` finding on the corpus — $168 to a current
$250, +$37.50/mo, on a series whose plateau share is 0.43. Note what that number requires: at
§9l's `feePlateauShare` of 0.5 this series would still be discarded, so the two amendments are
load-bearing together rather than independently.

**`SAMSCLUB` and `SAMS CLUB` are deliberately not fixed here.** The two differ by a space in the
bank's own descriptor; both run the chain cleanly and neither is wrong. §4.1 stage 4 already
argues the general case — "over-stripping silently merges two merchants and every §5 rule groups
by merchant" — and closing whitespace inside a descriptor is exactly that kind of guess. A seed
alias was the other candidate and is declined too: `seed-aliases.ts` says in its own header that
it is "**not** an attempt at a merchant database", and a warehouse club on one person's statement
is not evidence about anyone else's. §4.3's user correction is the designed answer, the machinery
for it is built, and one correction repoints all 38 rows.

**A pattern rule was considered and declined.** `^[A-Z0-9]{2,6}\*` would generalise stage 2 to
every processor nobody has enumerated, and it is tempting precisely because the failure is
silent. But this corpus contains exactly one unknown prefix, which is n=1 to calibrate a rule
whose errors are the asymmetric kind §4.1 stage 4 describes — a false strip merges two merchants
invisibly. §7.6's answer applies: revisit when a corpus shows how often an unknown prefix
actually appears, and until then grow the table.

## 9o. Amendments from implementation — 2026-08-27 (§4.1)

§9n fixed one missing processor prefix and framed it as a gap in a maintained table. That was
the smaller half of the truth. The same statement carries a second instance of the *same
structural fault*, and it is the fault rather than either instance that this records.

| § | Amendment | Why |
|---|---|---|
| 4.1 | **Stage 3 un-glues the asterisk to a space**, and §4.1 stage 3 says so. | §4.1 keeps punctuation through stage 1 for exactly one reason, which it states: stage 2's prefix table holds "entries identified *by* their punctuation". Stage 2 is therefore the only consumer of the asterisk — and past it, an asterisk left in place stops being structure and becomes **glue**. Stages 3, 4 and 5 are every one of them written around whitespace boundaries, so anything a bank welds on with an asterisk is invisible to all three. `AMAZON MKTPL*5O6QH4PH1` reached stage 5 with its order reference attached, the trailing-reference rule wanted `\s+` in front of a run it never saw, and stage 6's tidy then spaced the string out after every cleaning stage had finished. One merchant became roughly 150 distinct descriptors. |

**Why it survived this long.** The output looks *right*. `AMAZON MKTPL 5O6QH4PH1` is spaced,
uppercase and readable, and nothing errors or warns — the chain reports success and the damage is
one table further down, where a merchant has a hundred names. This is the same shape as §9n's
missing prefix and the same shape §4.1 stage 1 already warns about in its own words: "the chain
goes on producing stable, wrong output". Stage 1 is not the only place that can happen.

**What it did to that statement:**

| | before | after |
|---|---|---|
| distinct merchant identities | 68 | **21** |
| descriptors for the marketplace merchant | ~150 | 2 |
| `trend.v1` findings | 0 | **1** |
| series fitted | 6 | 6 (unchanged) |
| §7.3 savings headline | $450.00/yr | $450.00/yr (unchanged) |

The series set is untouched, which is the result to want: this changes *identity*, not the
grouping built on it, so nothing genuine moved and no phantom appeared. `trend.v1` emitting at
all is the third item on §9m's did-not-fix list starting to move — §9l diagnosed it as starved
because "62% of these rows resolve to provisional merchants, and a provisional has no default"
category. Collapsing 68 identities to 21 is what fed it.

**This amendment invalidates stored data, and that is not yet handled.** `description_normalized`
is computed once at import and stored (§3.1), and `merchant-corrections.ts` documents the
assumption this breaks in as many words: "a merchant correction changes the *alias table*, not
the chain — so `description_normalized` comes back identical by construction". True of a
correction; false of a chain amendment. Every row imported before this commit still carries the
old chain's output, and §4.3's re-normalize job will not rewrite it, because it was designed on
the premise that it never needs to.

The designed home for the fix already exists on paper and not in code: §6.8's Merchant aliases
section specifies "a re-normalize trigger with job progress", and §2.3 lists
`GET /api/merchants/review-queue` among the endpoints §1 counts as missing. Until one of them is
built, **a chain amendment requires re-importing rather than re-analysing**, and that is a
statement about this build rather than about the design. Recorded here so the next chain change
does not rediscover it. `collapse_v1` is untouched throughout — §3.3's dedupe keys never call
this chain, which is the whole reason §4 opens by separating the two.

## 9p. Amendments from implementation — 2026-08-27 (§2.3, §4.1)

Three amendments in two days — §9m, §9n, §9o — all came out of one statement, and all three
made §4.1's chain cleverer. The chain still cannot say whether `SAMSCLUB` and `SAMS CLUB` are
one vendor, and no amount of further rule-writing will let it, because that question is not
about the descriptors. It is about what the user's world contains.

So §4.1 step 7's review queue stops being a phrase and starts being an endpoint. This is the
first amendment in the series that makes the chain *ask* rather than guess better.

| § | Amendment | Why |
|---|---|---|
| 2.3, 4.1 | **`GET /api/merchants/review-queue` carries merge candidates**, not only provisional merchants and LLM proposals: pairs of merchants the chain resolved separately and cannot itself distinguish, each with both transaction counts and sample descriptors. | §4.1 stage 4 already argues that the chain must fail toward two merchants rather than one wrong one, because "over-stripping silently merges two merchants and every §5 rule groups by merchant". That is the right default and it leaves a residue the chain is structurally unable to clear. Detection, though, is cheap where resolution is impossible — and the detector was already in the file: `trigramSimilarity` exists for step 6's fuzzy alias lookup, and the only new idea is running it *between merchants* rather than between a descriptor and an alias. |

**The rule**, stated so it can be argued with. A pair is proposed when trigram similarity over
the two canonical names is at least `MERGE_PROPOSAL_FLOOR` (**0.5**) and **both** merchants have
at least `MERGE_PROPOSAL_MIN_TRANSACTIONS` (**2**) transactions. Two shipped `seed` canonicals
are never proposed against each other — `AMAZON` and `AMAZON PRIME` are deliberately separate,
and §5.4's overlap groups are where that relationship belongs. The list is capped, for the reason
§5.1 caps findings per rule.

**Why this floor is lower than `FUZZY_SIMILARITY_FLOOR`**, which is 0.72 and sits in the same
file. That one bounds what the machine may do **silently** — a fuzzy alias resolves a descriptor
with nobody watching, and its own note says a wrong merge is "close to invisible". This one
bounds what is worth **showing a person**, where the cost of being wrong is that they read a card
and say no. Different questions, so different numbers.

**The count guard is doing more work than the floor.** Measured on the first real statement,
similarity alone at 0.4 produced 48 candidate pairs, of which one was real; requiring both sides
to recur left **exactly one pair, and it was the right one**. The long tail of a statement is
one-off descriptors, and those resemble each other in precisely the way trigrams measure.

**And it has a cost, which the test fixtures demonstrate better than the real statement does.**
The two checking fixtures hold one coffee shop under two provisional names — the January
spelling and a February one carrying a city, which is the split §4.1 stage 4 accepts on purpose.
The pair scores 0.586, over the floor, and is **still withheld**, because the January spelling
occurs exactly once. So the guard that removes the noise will also sit on a true pair until both
spellings recur. That is the trade at 2, it is stated rather than discovered, and it is the first
number anyone tuning this will want to move. `merchant-review-api.spec.ts` pins both halves.

**What it finds on that statement:**

| | |
|---|---|
| merchant identities | 21 |
| merge candidates proposed | **1** |
| the candidate | `SAMSCLUB` (24 charges) ← `SAMS CLUB` (14) at 0.583 |
| false positives | 0 |
| provisional merchants listed | 17 |

Worth recording what this would have caught: the merchant split §9n fixed by adding a processor
prefix scored **0.769** as a pair, above even the auto-apply floor. §9m, §9n and §9o were three
amendments, an algorithm change and a threshold recalibration; the queue would have put both
faults on screen as one card each, on the first import, with no code change at all. That is the
argument for the direction, and §7.6 still applies to both thresholds — they are two numbers from
one statement.

**LLM proposals stay empty and say why.** §2.3 lists them on this queue and §4.2 needs §2.4's
provider seam, which is not built. The field is present and the reason is on the response, rather
than the field being omitted and the response shape changing later.

## 9q. Amendments from implementation — 2026-08-27 (§2.3, §4.3)

§9p gave §4.1 step 7's queue something to propose. This is the answer coming back.

| § | Amendment | Why |
|---|---|---|
| 2.3, 4.3 | **`POST /api/merchants/:id/merge`**, taking `{ intoMerchantId }`: every descriptor spelling of the named merchant becomes a `user` alias pointing at the surviving one, and §4.3's re-normalize job sweeps the history and re-runs the analyzers. | §4.3 already describes this operation exactly — "correcting a merchant in the UI writes a `merchant_alias` row and enqueues a re-normalize job [...] So fixing `SPOTIFYUSA` once retroactively merges four years of charges into one series" — and the machinery has existed since §6.3's bulk path. What was missing is the ability to say it about a *merchant* rather than about a transaction the user happened to be looking at. A merge is that bulk correction with the descriptor list filled in from the store instead of from the screen. |

**Composed, not reimplemented.** The route calls `writeUserMerchantAlias` and
`enqueueRenormalize` unchanged, so the merge inherits §4.3's guarantees rather than restating
them: `user` precedence puts it above `seed`, `rule` and `llm`, a later re-seed or a better model
cannot undo it, and the sweep is coalesced so eight merges are one re-normalization.

**Both merchants survive the merge**, and that is deliberate. What changes is which merchant
their descriptors *resolve to*, not the existence of a row. So the operation is reversible by the
same mechanism that made it — correct one descriptor back and its rows follow — where deleting a
merchant would not be. It also means a merge reports `transactionsAffected: 0` on a second
attempt rather than failing, which is the honest answer: there is nothing left to move.

**The count is returned from the store, not from the job.** The job is asynchronous and the user
is owed a number immediately, which is the same argument §6.3 makes about its bulk count: it is
"the basis on which they authorise a permanent, precedence-topping change".

**What is still not built, and why it is not here.** §6.8 specifies "a re-normalize trigger with
job progress", and §9o showed why it now matters: a change to §4.1's chain invalidates every
stored `description_normalized`, and §4.3's sweep will not rewrite it. That sweep needs two
things this amendment does not touch — `TransactionPatch` cannot carry
`description_normalized` (§4.3's job was written on the premise that re-writing it is a no-op),
and `runRenormalize` skips a descriptor that resolves *provisionally* rather than through an
alias, which on the first real statement is 17 merchants of 21. A merge writes aliases, so the
merge path is unaffected; a chain amendment is not. Building half of it here would have shipped
a "re-normalize everything" button that silently does nothing for most merchants, which is the
failure §9n and §9o are both about. It gets its own change.

## 9r. Amendments from implementation — 2026-08-27 (§6.8, §6.1)

§9p built the question and §9q built the answer. Neither was reachable by a person. This puts
them on screen, which is where the whole approach either works or does not.

| § | Amendment | Why |
|---|---|---|
| 6.8 | **Merchant aliases stops being a stated absence.** The section carries §4.1 step 7's merge candidates as cards, the provisional merchants behind them, and the merge that resolves one. | §6.8 has named this section since the beginning and §9k rendered it as an absence because "the review queue for LLM proposals needs the endpoints §2.3 lists". Those endpoints now exist. The LLM half still does not and still says so. |
| 6.1 | **A commit that raises merchant questions says so**, appended to the commit report, pointing at Settings › Merchants. | The queue lives where someone goes to *look* for it, and nobody goes looking for a question they do not know exists. A statement is what creates these questions, so the import that created them is the honest place to mention them. Appended rather than raised as a second banner: the count that matters immediately is still the rows, and two strips competing is how a page teaches people to dismiss both. |

**Two decisions borrowed from §6.3's merchant edit**, because they are the same decision. The
counts on a card come from the API and are never computed from what the page happens to hold —
they are "the basis on which they authorise a permanent, precedence-topping change". And nothing
applies on selection: choosing a direction arms the merge, and a second explicit click performs
it.

**The direction is a control, not a verdict.** §9p's proposal picks a survivor — the larger
history, or the shipped canonical — and it is usually right and occasionally not, because the
bank's uglier spelling can be the one with more charges behind it. The card says which way it
points in words, and flipping is one click.

**The re-read has to wait for the job, and finding that out is the reason this is a separate
amendment.** The alias write is synchronous; the rows move in §4.3's re-normalize job. A queue
re-read issued the moment the merge returns therefore sees the old counts and re-proposes the
merge that was just made — the card sits there looking like the button did nothing, which is the
one failure that would make a person stop trusting the section. §2.7 already had the answer ("the
UI polls a job rather than blocking on it") and §6.4's Run analysis already ran the loop; the
merge now does too, and says "have been recalculated" or "are still recalculating" rather than
guessing.

**Measured on the first real statement**, through the built UI against a throwaway copy of it:

| | before the merge | after |
|---|---|---|
| the merchant | `SAMSCLUB` 24 charges · `SAMS CLUB` 14 | `SAMSCLUB` **38** · `SAMS CLUB` 0 |
| merge candidates in the queue | 1 | 0 |
| §5.9's baseline for it | "typical is $82" | "typical is $92" |
| outliers it reports | 2 | **3** |

That last row is the argument for the whole direction rather than a detail. Splitting one
merchant in two did not merely mislabel a card: it split the distribution §5.9 reasons against,
and a $326 charge that should have been flagged was sitting inside the smaller half looking
ordinary. One click fixed the analysis, not just the name.

## 9s. Amendments from implementation — 2026-08-28 (§6.8, §6.9, §6.1, §6.3)

§9r put §4.1 step 7's queue on screen and filed it under §6.8's Settings. That was the wrong
room, and the amendment half-admitted it in its own second row: it added a sentence to §6.1's
commit report because "nobody goes looking for a question they do not know exists" — and then
left the question behind the one door in this app that a person opens twice a year.

| § | Amendment | Why |
|---|---|---|
| 6.9 (new) | **§4.1 step 7's queue gets its own page**, and a badge in the rail carrying the number of questions waiting on it. | Settings is where the *app* is configured. This is where the *data* is corrected, and it is the only screen in the app that asks the user something it cannot work out for itself. The badge is the actual fix: a page is findable, but a queue has to be noticed. |
| 6.8 | **Merchant aliases keeps only the re-normalize trigger**, still unbuilt for the reasons §9q gives. | The queue and the user-correction list were the halves of that section that were about the data. A sweep that rebuilds derived state is maintenance, and maintenance is what the rest of that page is. |
| 6.1 | **The commit report points at Review**, not at Settings › Merchants. | Unchanged in substance, and worth keeping for the one thing the badge cannot do: the badge says a question exists, and only the import that raised it can say which one did. |

**It sits fourth in the rail, not last.** §6.9 is the newest section and so the last one
numbered, and putting it under Settings would have reproduced the burial in a different shape.
It goes with Import, Accounts and Transactions — the pages about your data — which is also the
order the work happens in: the questions Review asks are the ones the import raised, and
answering them is what makes everything below it correct.

**Where the count lives is the one real decision here**, and both obvious answers are wrong.
*The page publishes it* fails at the only moment that matters: the badge is addressed to
someone who has **not** been to the page, so a count published on load is a count you first see
when you no longer need it. *The rail reads it privately* fails immediately after: a merge
changes the count, and a rail that read once at startup goes on advertising work that is
finished — with the page saying "nothing to review" two inches from a rail saying `1`. Two
reads of one endpoint is two numbers that can disagree on one screen, which is worse than
either of them being briefly stale.

So the queue is held once, in a service both inject. The shell loads it at startup, §6.9
re-reads it on entry and after a merge, and §6.1's commit re-reads it because a statement is
what creates these questions in the first place — one request, moving the sentence and the
badge together. **Not a timer poll**: this is a single-user local app and nothing outside this
UI writes an alias, so a poll would spend a request every few seconds to be told what the page
that caused the change already knew. And a failed re-read keeps the last known queue rather
than emptying it, because "the API is not answering" and "you have nothing left to review" are
different facts and only one of them belongs in a badge that has just gone quiet.

**The badge counts questions, not context.** Merge candidates, and §4.2's LLM proposals when
they exist. Not the provisional merchants, of which the first real statement has seventeen: a
name the chain invented for itself is fine as long as it is spelled the same way every month,
which is what §6.9 says on the same screen that lists them. `18` would be a badge nobody reads,
and the number this one has to be right about is `1`.

**The copy stopped citing the spec at the reader** on the way across. The cards had said "this
is permanent and outranks anything the app works out on its own (§4.3)" and "§4.1 could not
match these"; they now say those things in English. That is the rule the previous change set
for §6.8's analyzer copy, and it applies here for the same reason — §-numbers are how this repo
keeps its reasoning attached to its code, and they have no business on a page someone is
reading about their own money.

**And one thing turned out to be true already.** The move was to carry a fix with it: §6.1's
import history was reported as showing the filename alone, which would make two statements from
one bank indistinguishable. It does not — it has shown filename, status, account, statement
period and row counts since it was built, confirmed in the running app against the real Chase
import. The list that does name an import without naming its account is **§6.3's row expander**,
under covering imports, where two cards at one bank exporting the same filename for the same
month are genuinely two identical lines. That is where the account went instead.
## 9t. Amendments from implementation — 2026-08-28 (§2.4, §4.2, §2.3, §6.8, §2.7)

§2.4's provider seam existed and nothing called it. This is everything that turned out to
be missing between "there are three providers" and "a model changes which merchant a
descriptor resolves to" — one contradiction, two tables, three endpoints, and a rule about
what a `rule` alias *is*.

| § | Amendment | Why |
|---|---|---|
| 4.2, 4.3 | **An `llm` alias may replace a `rule` alias, and nothing else.** Not `seed`, not `user`, not another `llm` row. | §4.2 says "The LLM never overwrites an existing alias", and applied to every source that makes §4.2's own auto-apply path **unreachable**: §4.1 step 7 writes a `rule` alias for every descriptor the chain could not place, so by the time §4.2 is asked about one it always already has an alias. A 0.99 proposal applied to nothing, ever. See below. |
| 3.1 | **`llm_degraded_call`** and **`llm_proposal`** (migration 006). | §6.8 asks for "the degraded-LLM-call log" and "the review queue for LLM proposals" and §3.1 gives neither a row. Both are read in Settings, which is a page someone opens tomorrow. |
| 2.3 | **`GET /api/llm/degraded-calls`** and **`POST /api/llm/propose-merchants`**. | §2.3 lists `GET /api/llm/health` and stops. The log needs a reader, and §4.2's stage needs something to start it — §2.7 is why that cannot be an HTTP request. |
| 2.3, 6.8 | **The provider travels on `PATCH /api/settings`, in an `llm` block beside `changes`.** It lands in its own settings key, `llm.provider`. | §2.3 puts config on one endpoint and §7.4 hashes the analyzer config into `config_hash`. Both stay true: one request, two keys, and choosing a model does not invalidate every dismissal in the database. |
| 2.7 | **The job runner is asynchronous.** | §2.4's providers are a subprocess and an HTTP call. `draining` is held across the awaits, so the property that sentence was protecting — one runner, no second drain claiming the next job — is unchanged. |

**The contradiction, stated plainly.** §4.1 step 7 makes every unresolved descriptor a
provisional merchant *and* a `rule` alias pointing at it. §4.2 then says the LLM never
overwrites an existing alias. §4.3 puts `llm` below `rule` in precedence. Taken together
the three mean §4.2 can never apply anything: the only descriptors it is allowed to
consider are precisely the ones that already have an alias it is not allowed to replace.

What resolves it is what a `rule` alias **is**. `seed` and `user` are judgements — one
shipped, one made by a person. A `rule` row is neither: it is a cache of the chain's own
deterministic output, written so a later import of the same spelling lands on the same
provisional merchant rather than creating a second one. Overwriting it discards no
decision, because nobody made one — the chain would recompute the identical answer from
the descriptor. So `llm` may replace it, and §4.3's precedence is untouched for
*resolution*, where `rule` still outranks `llm`. This is only about who may overwrite
whom, and `merchants.ts` says so where the rule is enforced.

**`llm_dependent` was true by vacuum and is now true by mechanism.** §2.4's "no silent
authority" held before this change only because nothing had ever written a `source='llm'`
alias, so `llmDependent: false` on every finding was correct. Landing §4.2 made it wrong.
The snapshot now carries `llmAttributedTransactionIds`, `applyEmissionPolicy` intersects
it with each draft's `evidenceTransactionIds`, and §2.4's cap — which already lived there
— finally has an input. **No rule reads it**: it is passed straight through by all nine
and consumed once, which is what keeps §7.5's "no analyzer branches on a `source` column"
true while making the invariant reachable. The set is joined on the *descriptor*, not the
merchant: going via `merchant_id` would cap four years of correctly-grouped Netflix
charges because one odd spelling was folded in, and a badge that is everywhere is a badge
that means nothing.

**T1's clause (a) is stricter than the reason §2.4 gives for it.** §2.4 justifies it as
catching a provider-gated rule — one that "only ever emits *because* a model grouped
something". But the literal test, *every rule that fires in the full run also fires in the
ablated one*, is tripped by an ordinary success: the first version of T1's fixture had the
model merge two coffee spellings whose four charges together fit a quarterly cadence, the
merge built a `recurring_series` neither half could carry, and a rule with a new subject
to report on fired in the full run and nowhere else. No rule was gated; a subject appeared.
The fixture was changed rather than the assertion — §2.4 governs — and the case is
recorded here because the next person to trip it will be looking at a green mechanism and
a red test. `llm-api.spec.ts` keeps both shapes, in two fixtures, and says why.

**§4.2 asks the model for a `category` and there is nowhere for it to go.** The schema is
`{ descriptor, merchant_name, category, confidence }`, and applying the category would mean
writing `transaction.category_source = 'llm'` — which §4.3's re-normalize, enqueued by the
alias write moments earlier, immediately overwrites with the *new* merchant's default
(§2.5's rule). Two mechanisms writing one column is how a category starts flickering. It is
stored on `llm_proposal` so the review card can show what the model thought, and applied to
nothing. Resolving it means deciding whether an LLM category outranks a merchant default,
which is a §4.3 precedence question this change does not need to answer.

**A redacted descriptor is not an alias key.** The model sees
`SQ *BLUE BOTTLE [redacted] PORTLAND` and echoes it back; the alias has to be keyed on the
real `BLUE BOTTLE 1234 PORTLAND` or it matches no transaction at all. The batch therefore
carries a map from sent text back to candidate, and **drops collisions** rather than
resolving them: two descriptors that redact to one string cannot be told apart in the
answer, and guessing which one a proposal meant would write a permanent grouping onto a
coin flip.

**Nothing in the suite starts a real provider.** `ClaudeCliProvider` sends merchant
descriptors to Anthropic, so a suite that spawned it would do so on every `npm run check`,
against whatever is in the developer's database; a real Ollama on 127.0.0.1 would make the
same test pass and fail on different machines. `LedgerlineContext.llmProviderFactory` is
the seam — the same one `fetchFn` and `spawnFn` already are, one level up, because the
providers are constructed from a settings row and a spec that only replaced `fetch` still
could not make `GET /api/llm/health` answer for a provider it is not allowed to start.

## 9u. Amendments from implementation — 2026-08-28 (§6, §6.4)

§6 opens with "dark-first to match the workspace look" and then lists nine pages, and both halves
turned out to be doing less than they read as. **Dark-first became dark-only** — there was no way
to choose, so the app was simply dark. And **nine sections is not an app**: with no front door the
app opened on §6.4, which is the right answer to a question it has only earned once you have
imported something and run an analysis. On a fresh database it is three em-dashes and no
indication that the next move is Import.

| § | Amendment | Why |
|---|---|---|
| 6 | **A theme system in `@metrum/ui`**: a token contract, a registration call an app makes at bootstrap with its own palette, and a switcher with two axes — theme, and light/dark/system. | "Dark-first" describes a default, and a default only means something where there is an alternative. Putting it in the shared lib rather than in this app is what makes it true of the next app for free, which is the whole reason that lib exists. |
| 6 (new) | **A home page at `/`**, and the app name in the header links to it. | The state you are in is a different question from what was found, and only §6.4 was answering the second one. The fresh-install case is the sharpest version: the app's first screen used to be an empty table. |
| 6.4 | **Findings is still the hero and is no longer the landing page.** The home page's headline figure is §6.4's savings total and links straight to it. | Nothing about §6.4 changed. What changed is that the number now has somewhere to be *before* you have decided to go looking at findings. |

**Two axes, not one.** A *theme* is an identity — one app's palette, registered by that app. A
*mode* is light or dark within it. They are independent because picking "Ledgerline" and picking
"light" are different questions, and collapsing them into one list of four options makes adding a
third app produce six. `provideTheming(LEDGERLINE_THEME)` is the whole app-side API: it registers
the palette, makes it that app's default, and puts it in the switcher beside the house theme.

**"System" reads `prefers-color-scheme`,** which is the honest answer — the OS already knows, and
asking the user to say it a second time is asking them to keep two settings in step. It is a
listener rather than a one-off read, because the OS can flip at sunset while the app is open, and
it loses to an explicit choice, because a choice is a choice. `color-scheme` on `:root` is kept in
step with the resolved mode: scrollbars, form controls and the caret are painted by the browser
from that property alone, and without it a light theme keeps dark native furniture and reads as
broken rather than as light.

**The choice is stored in `localStorage` and deliberately not in the API.** It has to be readable
synchronously at bootstrap — an async read reintroduces the flash it exists to prevent — and it
has to survive a reload. It is also a per-device presentation preference, and §2.3 backs up,
exports and wipes the database: a scrollbar colour has no business in a backup of someone's bank
records. The key is namespaced per app so two apps on `localhost` in development do not overwrite
each other's answer.

**The token contract grew, and that is what made a second palette possible at all.** §2.2's rule
that feature libs ship no palette was already almost true — almost, because `--warn` and
`--surface-1` were *consumed* thirteen and three times and *defined* nowhere, so every use fell
back to a hex literal, and because roughly a hundred and twenty more literals sat outside any
`var()` at all: a coral for danger, two bronzes for caution, a violet for §4.2's AI marks, a
near-black for text on a filled chip, and a dozen translucent tints. Every one of them would have
survived a theme switch. They are tokens now — `--danger`, `--danger-soft`, `--caution`,
`--caution-soft`, `--ai`, `--ai-soft`, `--on-accent`, and the tints as `color-mix` over the token
they were an alpha of.

**Contrast is checked rather than eyeballed.** The dark palette is comfortable because it was
tuned against a real screen over weeks; a light palette gets no such tuning before it ships, and
"looks fine on my monitor" is exactly the judgement that produces captions nobody else can read.
So the requirement list is executable: body text at 7:1 on every ground because this is a screen
of figures and a mis-read digit is a different kind of wrong, the accents and dim text at 4.5:1,
and the three border-weight colours at 3:1 under the non-text rule. Both themes are audited in
both modes, in the test suite, and an app that registers a palette runs the same audit over it in
one line.

**Ledgerline's own theme is a ledger.** Not "finance" in the abstract — the object this app
replaces: a ruled statement, ink on paper, money in a column down the right. That gives the two
modes something to *be* rather than one being the other inverted. Dark is ink: a deep navy ground
rather than the house theme's teal-black. Light is the paper: warm cream, not white, because
ledger stock never is, white panels on a white page lose every edge, and a screen of figures read
for half an hour is easier on cream. The accent is banknote green, which is the one colour that
already means *money you still have*. The second accent is gold, and it is the more considered of
the two: every use of that token is a figure or a chip that wants a second look — §6.4's flagged
savings, §6.8's indicator when the provider is remote — and in the house theme it is a green
sibling of the teal accent, so the headline number blends into the chrome it is supposed to stand
out from. The house teal stays in the list, one selection away, and is still what the dashboard
looks like; an app that looks exactly like the workspace dashboard has no identity of its own to
return to.

**The home page computes nothing.** It shows §6.4's savings figure alone and large, then three
facts about the state of the data rather than the money — active subscriptions, §6.9's questions
waiting, and when the analysis last ran with §7.4's warning if a threshold has moved since — and
then statement coverage per account, because §5.10 and §5.11 refuse to compute over a partial
month and every other rule degrades quietly across a gap, so "your findings are only as good as
your months" belongs beside the findings total rather than two clicks away on §6.2. The review
count comes from the holder the rail's badge reads, so the front door and the rail cannot show two
different numbers for one queue.

**It has no Run analysis button, and no rail item.** §6.4 owns that write along with §2.7's job
poll, the busy state and the failure text; a second button would be a second copy of all four, and
two of them on two pages can disagree about whether a run is in flight. The stale-config warning
links to Findings instead, which is where the button already is and where the result would be read
anyway. And the way home is the app name, which is the one navigation convention every user
already has — a tenth entry above §6's nine would make the front door look like a section it is
not.

## 9v. Amendments from implementation — 2026-08-28 (§2.7, §2.3, §6.8)

§9q deferred §6.8's re-normalize trigger and named two blockers. Both were real; one of
them turned out to have the wrong fix attached, and finding that out is most of what
this change is.

| § | Amendment | Why |
|---|---|---|
| 2.3 (new) | **`POST /api/jobs/renormalize`** — §2.3 lists it and nothing served it. Enqueues §2.7's full sweep and returns a job id and the row count it will walk. | §2.7 says "a full sweep is available explicitly from Settings", and **explicitly** is the whole of it: an *incremental* re-normalize is a consequence of a correction and never something a user asks for, so an endpoint for it would have been a button for a thing that already happens. |
| 2.7 | **The sweep's unit of work is the raw descriptor, one row at a time** — not the descriptor group the stored `description_normalized` defines. | §9q predicted the fix would be `TransactionPatch` learning to carry `description_normalized`. Building it that way would have been wrong; see below. |
| 3.1 | **`transaction.description_normalized` is writable**, by exactly one path. `dedupe_key` remains untouchable. | §4.3's job was written on the premise that rewriting the normalized form is a no-op, which is true of a correction and false of a chain amendment (§9o). |
| 6.8 | **Merchant aliases is built**, as the one thing §9s left it: a trigger with §2.7's job progress. | The queue moved to §6.9 because it is work on the data. A sweep rebuilds derived state, which is maintenance, which is what the rest of that page is. |

**Why the group is the wrong unit, which is the part §9q got wrong.** The incremental
path selects rows by their shared current `description_normalized`, runs the chain over
*one representative* raw descriptor, and applies the answer to the whole group. That is
sound while the chain is fixed, because the grouping was the chain's own work. It stops
being sound the moment the chain changes — which is the only reason to run a sweep at
all. Two raw descriptors the old chain merged may be two the new chain separates, and
one sample's answer written across the group would merge them **permanently**, in the
name of repairing them. Widening `TransactionPatch` would have shipped exactly that: a
sweep that looks like it worked and quietly destroys the distinction it was run to
restore. So the sweep reads rows rather than groups, and trusts nothing about the stored
grouping.

**The provisional skip bites in a narrower case than it sounds, and the case is the one
that matters.** §9q measured `runRenormalize`'s early return for non-alias resolutions
at "17 merchants of 21", which reads as though the incremental path is broken for most
of a ledger. It is not: §4.1 step 7 leaves a `rule` alias behind for every provisional
merchant it creates, so re-running the chain over a freshly imported ledger resolves
through those aliases and the skip never fires. What reaches it is precisely §9o's
condition — the chain changed, so it now produces a cleaned name that no alias covers.
The skip is therefore harmless in every case except the one a sweep exists for, which is
why it stayed invisible. `renormalize-api.spec.ts` reproduces it by deleting the alias,
because that is what "the chain's output is a name nothing has an alias for" looks like
without keeping two versions of the chain around.

**The sweep runs §4.1 step 7 itself.** A descriptor the new chain cleans but cannot match
becomes a provisional merchant, created here rather than at import. That is what makes a
sweep able to repair a chain amendment rather than merely re-point what the old chain
already grouped.

**Only rows that disagree with the chain are written**, and that is not an optimisation.
§3.4's watermark re-index reads `updated_at`; a sweep that stamped every row would hand
it the whole table to re-index for nothing, on an operation whose whole purpose is that
running it should be safe. A sweep over a converged database is a no-op that says so.

**Keyset paging, because the sweep writes to what it is reading.** An `OFFSET` walk over
rows the walk itself is updating either visits a row twice or skips it, and skipped is
the failure that leaves a descriptor on the old chain's output with nothing to say so.
`id > ?` cannot drift, because the sweep never writes `id`. The four sorts `search`
offers are all date-first and none of them is what this needs.

**The sweep and the incremental path share a job kind, and coalesce.** §2.7 coalesces
within a kind, and merging the two is lossless in one direction only: a sweep
**subsumes** incremental work, because it re-resolves every row rather than a key-space.
So `full` is OR-ed when payloads merge, and the incremental payload is still carried
rather than discarded.
## 9w. Amendments from implementation — 2026-08-29 (§2.3, §6.4, §5.1, §6.3, §2.6)

§6.4 asks for "a compact charge history or mini-table, **not a link to go find it**", and §5.1
hands it the material — evidence is "explicit transaction ids, materialized into
`finding_evidence`". The cards had the ids and rendered them as a number. The reader was told
"12 charges" and shown none of the twelve.

That was not an oversight and the component said so in its own header: `ListTransactionsQuery`
had no by-ids filter, so a card wanting its rows had to issue one `GET /api/transactions/:id`
per cited transaction. Twelve requests to rebuild a history the rule had already summarised is
a bad trade, and the honest response to a missing contract was to show the count and explain
the absence. The contract is the thing that was wrong.

| § | Amendment | Why |
|---|---|---|
| 2.3 | **`GET /api/transactions` gains an `ids` filter** — comma-separated on the query string, an array on `TransactionFilter`. Present but empty selects nothing. | It is the one selection this API could not express, and §5.1 produces exactly that selection on every run. Every other filter here describes a *shape* of row; this one names rows, which is what evidence is. |
| 6.4 | **Cards show the transactions they were built from**: date, descriptor, amount, most recent first, under the rule's own `detail` rows. | §6.4 asked for this from the start. What changed is that it can now be had for one request. |
| 5.1 | **A finding's `evidence_transaction_ids` are ordered by the transaction's `effective_date`**, id breaking the tie. | They were ordered by `transaction_id`, which is stable and means nothing: ids are `randomUUID`. Harmless while the only consumer was a count; wrong the moment a card shows six of thirty-two, because "six of" is a sample only if the list has an end that is the recent one. |
| 6.3 | **The transfer chip dims where §2.6's spend-category signal fires.** Dimmed, never disabled. | The chip is a manual override with no sense of how implausible it is, and offered "not spending" beside an Amazon purchase in the same tone as beside a credit-card payment. §2.6 already scores that −2. |
| 2.6 | **The spend-category signal moves to `domain`** as a single-row predicate; the matcher calls it. | It is the half of §2.6 that asks nothing about the counterpart, and §6.3's chip needs the same judgement on the far side of §2.2's boundary. One rule, two callers, rather than a copy in the UI that silently stops agreeing. |

**The id list is bound as one JSON value, not as `n` placeholders.** Every other list filter in
`buildFilter` expands to `IN (?, ?, …)`, which is right when the list is a handful of account or
category ids chosen from a picker. This one is sized by how much evidence a run happened to
produce — `micro.v1` cites every charge in a high-frequency group and `trend.v1` cites a month
of a category — so the placeholder count is *data*, and data that grows into SQLite's
`SQLITE_MAX_VARIABLE_NUMBER` (32,766 on the bundled build, 999 on an older one) fails at exactly
the sizes the filter exists for. `t.id IN (SELECT value FROM json_each(?))` takes the whole list
as one bound parameter and the statement's shape stops depending on the input.

Chunking was the alternative and it does not survive §3.4's own rule. `buildFilter` is written
once because `search`, `countMatching` and `applyBulk` "must agree exactly" — one filter, one
clause. A chunked `applyBulk` is several transactions where §6.3 promised one, and the promise
§6.3 makes is a count: "apply to all 47 matching."

**One request for the page, not one per card.** Per-card would have been defensible and is worse
in every direction that matters. Nine rules' worth of cards is nine to two hundred requests for
data that fits in one; the cards would populate raggedly as each landed; and a card that fetches
is a card that owns a resource, a loading state and an error state, which is the split §6.4's
page was built to avoid — "the container owns all state and every request." The page already
re-reads on its own revision counter, so the charges invalidate with everything else for free.

**Two caps, both visible.** A card shows at most **six** charges: §5.1 caps a *rule* at 25
findings and says nothing about how many transactions one finding may cite, and a card is not
the transactions page. Six covers a typical price-creep or lapsed finding outright, and a card
showing fewer than it cites says so — "6 most recent of 32" — because a reader who counts the
rows must not conclude the rule looked at six. The page as a whole sends at most **160 ids**,
about 5.9 KB against the route's declared 8 KB: `GET` is where this lives, Node caps a request's
whole header block at 16 KB by default, and an over-long URL fails as a socket error with no
route entered and nothing in the log. A declared `maxLength` turns that into the 400 every other
malformed query gets. The budget is spent in the page's own reading order — biggest group,
biggest card — so it runs out at the bottom, and a card past it renders exactly what every card
rendered before: its `detail` rows and its charge count.

**The charge fetch asks for rows a browse would hide.** §6.3 defaults internal transfers and
excluded rows off, and rightly: a credit-card payment is not spending. But an id list is an
explicit selection rather than a browse, and a rule cited these exact rows. If the user has since
marked one an internal transfer, the honest card is the one whose charges match its own count —
dropping it silently leaves "6 charges" above five rows with no account of the sixth. The
defaults stay where they are and the caller opts in, because the default is right for the page
that has one.

**The rule's `detail` payload stays primary.** The charges are an addition, not a replacement. A
price-step table says more than twelve rows of the same merchant, and §5.3 forbids re-deriving
downstream what §5 already computed — the mini-table is the evidence beside the conclusion, not
a second attempt at it. The one case where the charges are the whole of the evidence is a rule
with no `detail` renderer: `outlier.v1`, `micro.v1`, `trend.v1` and `fees.v1` showed no evidence
block at all before this, which is where "$290 at SAMSCLUB — typical is $82" was hardest to
believe.

**On the transfer chip: the complaint was about the chip and not about a bad link.** Checked
before assuming — `GET /api/transfers` over the real statement returns nothing and no row is
flagged, which is correct: §2.6's candidate generation needs a debit in A and a credit in B with
A ≠ B, and there is one account in the system. So nothing was mis-linking. What was wrong is
that the manual toggle had no opinion at all. It now reads §2.6's own predicate and recedes —
dashed border, less contrast, full hover state — where a row is a purchase at a real merchant in
a spend category. **Not disabled**: §4.3 puts a user's decision above every rule, a merchant can
be miscategorized, and refusing the toggle would make a wrong category unfixable from the page
whose job is fixing wrong categories. Only §2.6's *second* negative signal is applied. The first
— "already belongs to a `recurring_series` whose merchant is not transfer-kind" — needs series
membership per row, which is not on `TransactionSearchRow`; that is a second §2.3 change for a
case the second signal almost always catches anyway, since a series has a resolved merchant by
construction and a subscription charge lands in a spend category.

## 9x. Amendments from implementation — 2026-08-29 (§2.5, §4.2, §4.3)

§9t built §4.2's stage and left one field of its response schema with nowhere to go: the
model is asked for `{ descriptor, merchant_name, category, confidence }` and only three
of those did anything. The category was recorded on the proposal and applied to no row,
because §4.3's re-normalize would have overwritten it within seconds with the merchant's
default. Resolving that turned out to need a precedence rule §4.3 does not state.

| § | Amendment | Why |
|---|---|---|
| 2.5, 4.3 | **Category precedence is `user` → `llm` → `rule`**, which is *not* §4.3's alias precedence (`user` → `seed` → `rule` → `llm`). | §2.5 already orders them — "category assigned by rule, then optionally by LLM" — and "then" is the whole argument: the model is asked *because* the rule's answer was absent or generic, so treating its answer as the weaker of the two discards the thing that was wanted. |
| 4.2 | **A proposal's category applies only where its grouping applied.** Sub-floor and settled-series-blocked proposals write no category, at any confidence. | A classification resting on an identity nobody accepted is still something applied. §4.2 says such a proposal "applies to nothing", and a category is not nothing. |
| 4.2 | **A category name the taxonomy does not have is dropped, never created.** | §6.8 files the taxonomy under a Categories editor that does not exist yet. A model inserting rows into it would be the only write on this path with no human anywhere near it. |

**The two precedences differ because the two claims differ.** An alias claims *identity* —
this descriptor **is** that merchant — and on identity §4.1's chain is the better
authority, which is why §4.3 ranks `rule` above `llm` and why `upsertAlias` goes further
and refuses any `llm` overwrite at all. A category claims *classification*, and there the
rule's answer is a single inherited default with no view of the descriptor. Ranking the
two the same way in both places would mean either a model that cannot improve a category
or a model that can silently rename a merchant, and neither is what §2.5 and §4.2
describe when read together.

**`excludeUserCategorized` became `preserveCategorySources`.** The boolean encoded the old
assumption in its name, and a second boolean beside it would have been two overlapping
filters over one column. The list makes the sweep's rule legible at the call site, and
`PRESERVED_CATEGORY_SOURCES` is one constant so the incremental path and the full sweep
cannot come to disagree about who wins.

**A re-run is idempotent rather than a second write**, because `llm` is in the preserved
list and so a later proposal does not overwrite an earlier one. That falls out of the
precedence rather than being arranged separately, which is the reason to state the
precedence once rather than special-case the re-run.

## 9y. Amendments from implementation — 2026-08-29 (§6.7, §2.3)

§6.7 is the last section of §6 to be built and the only one whose central claim is a
*negative* — "no hallucinated numbers, no arbitrary database access from generated SQL,
and data minimization". Building it was mostly a matter of making each of those three
checkable rather than asserted, and two of them needed a decision §6.7 does not make.

| § | Amendment | Why |
|---|---|---|
| 2.3 (new) | **`POST /api/ask`**, answering `409 llm_disabled` when the provider is `none` — the one §2.3 specified and nothing served. | Ask is the only feature in this system with **no deterministic half**. Everywhere else a provider improves on an answer the rules already produced; here nothing but a model turns a sentence into one of §6.7's six queries. So there is no fallback to return and 409 is the honest status. |
| 6.7 | **`merchantHistory` is treated as row-level**, not as an aggregate — the same twenty-descriptor cap and redaction `transactionSearch` gets. | §6.7 names only `transactionSearch` in its data-minimization clause, but `merchantHistory` returns individual charges too. Applying the rule to the query's *shape* rather than to its name is the reading that survives a seventh query being added. |
| 6.7 | **The prose call sees `providerView`, never `rows`** — a separate structure built beside the result rather than a filtered copy of it. | A filter is a thing someone can forget to apply. Two structures built together, where only one is ever passed to a provider, is the same argument §4.2's batch type makes: the object handed to the model has no field the rows could travel in. |
| 6.7 | **Small integers (≤12) are exempt from numeric validation.** | They are ordinals and counts — "the top 3", "over 12 months" — far more often than they are claims, and anything at that scale which *is* a money figure is also below the scale at which being wrong matters. Without the exemption almost every well-formed answer fails. |

**The check has to allow rounding, and that is not a weakening.** §6.7 says every numeric
token "must appear in the returned rows or be a simple aggregate of them". Read strictly
that rejects "about $1,100" over a value of $1,099.40 — which is a model rounding, not
inventing, and rejecting it serves nobody. Comparison is therefore to two decimal places
with a 0.5% relative tolerance. A figure that is merely *close to nothing* in the result
still fails, which is the property that matters.

**Cents and dollars are the same number.** `amountCents: 109_900` has to admit
"$1,099.00", because cents are an implementation detail the prose has no reason to know
about. That conversion is the one scale conversion the check performs, and it is admitted
because §3.1 makes cents the only integer money scale in the system.

**Pairwise derivation is bounded and says so.** §6.7's four allowed forms include
differences and percentages "of two present values", which is O(n²). That is affordable
only because the input is small by construction — an aggregate result is category or
month totals, and a row-level one is capped at twenty descriptors before a model sees it.
`MAX_PAIRWISE` states the bound rather than inheriting it, so a future query returning
more rows degrades to "unvalidatable" instead of quietly spending a second there.

**An answer can be withheld three ways and the table is shown in all of them**: the model
was unreachable, its prose failed the numeric check, or the query returned nothing. §6.7
requires the third — "An answer with no visible data behind it is not shown" — and it is
enforced in the service rather than in the page, because an empty result with a confident
paragraph over it is the most misleading thing this feature can produce and the page
should not have to remember to guard against it.

## 9z. Amendments from implementation — 2026-08-29 (§7.6, §5.1, §6.4, §6.8)

§7.6 has been the standing caveat on every number in §5 since this document was written:
"Nothing in §5 has been run against a real statement. The first phase that ships
analyzers also ships a fixture corpus — a hand-labelled year of real statements with the
expected findings written down — and every threshold is re-derived against it before the
numbers in this document are treated as settled."

That corpus has not been built, and the reason is not that anybody forgot. It is an
afternoon of sitting with a year of statements writing out what *should* be found, before
seeing what was — a task with no partial credit and no natural moment to start. This
amendment builds the half that does have a natural moment: judging a finding while
looking at the evidence, thirty seconds at a time.

| § | Amendment | Why |
|---|---|---|
| 3.1 (new) | **`finding_label`** — one verdict per natural key, with the note, the rule id, and the evidence and config hashes in force when the judgement was made. | §7.6 describes the corpus as a file. A table is what lets it accumulate from use, and the hashes are what stop a judgement being counted after the claim it was about has moved. |
| 2.3 (new) | **`POST /api/findings/:id/label`**, taking `correct` / `incorrect` / `unsure`. | §5.1's `/state` already exists and answers a different question — see below. |
| 6.4 | **The card asks "was this right?"** beside the dismiss controls, and a "No" **does not hide the finding**. | A judgement that cost the reader the card would be a judgement nobody gives honestly. |
| 6.8 | **The tally sits beside each rule's thresholds** in Analyzers — "you marked 4 right, 1 wrong" — as counts, never a percentage. | §7.4 put the thresholds there so tuning is a normal afternoon; the evidence for a change belongs in the same place as the change. Eleven judgements do not support "82% accurate", and a figure that looks like a rate invites being acted on as one. |

**A label is not a dismissal, and conflating them would have been unrecoverable.**
`finding_state` records acknowledged / snoozed / dismissed, and it is tempting to read a
dismissal as "wrong" and save a table. The two come apart in both directions: a *correct*
finding about a subscription you have already decided to keep gets dismissed, and an
*incorrect* one sits unread at the bottom of the page for a month. Tuning §5 against
dismissals would therefore calibrate every threshold toward what annoys the reader rather
than toward what errs — and because the two verdicts would already be mixed in one
column, nobody could separate them afterwards. That is the whole argument for the second
table.

**`unsure` is a real answer, not a cop-out.** Some findings cannot be judged without a
bank statement to hand, and forcing those into `correct` or `incorrect` puts noise into
the one number tuning reads. It is recorded and counted separately.

**A label outlives the finding it judged**, which is why the table stands alone rather
than being a column on `finding`. §5.1 resolves a finding that stops firing rather than
deleting it, but a *threshold change* can remove it from every future run — and the
judgement about how the rule behaved at the old threshold is exactly what tuning wants to
look back at. `rule_id` is denormalised onto the label for the same reason.

**Staleness reuses §5.1's mechanism.** A label whose finding's `evidence_hash` has since
moved is a judgement about a different claim, so it is shown as "you called this correct,
before the amounts changed", excluded from the rule's tally, and counted separately. A
rule whose labels are mostly stale has an accuracy figure resting on a handful of current
ones, and a reader about to move a threshold on the strength of it should be told.

**What this cannot do, stated because the gap is easy to miss.** It measures
**precision** — of the findings that fired, how many were right. It cannot measure
**recall**, because the app has no way to show a reader what it *failed* to find, and
§7.6's corpus as described is recall-capable precisely because the expected findings are
written down before the rules run. So this instrument tunes a threshold **down** (too
many false positives) on real evidence, and says nothing about tuning one **up**. §7.6's
afternoon is still owed; what changes is that it is no longer the only source of
evidence, and the thresholds most likely to be wrong now announce themselves.

## 9aa. Amendments from implementation — 2026-08-29 (§6.6, §2.3, §5.8)

§6.6 was the last §6 page with nothing behind it. Building it is mostly §7.2's coverage
rule, which §6.6 states from the display side in one sentence: "Months that are not
fully covered are rendered hatched rather than omitted, so a gap reads as a gap and not
as a drop in spending."

| § | Amendment | Why |
|---|---|---|
| 2.3 (new) | **Five routes** under `/api/insights/*` — `categories`, `movers`, `fees`, `outliers`, `small-spend` — rather than one. | §2.3 lists them as one row, but they have different shapes and different costs. A single endpoint would make opening the page pay for four views nobody is looking at. |
| 6.6 | **`movers` compares the last two *covered* months**, not the last two. | Comparing a complete month against a half-imported one produces a table of enormous fallers that are all the same artefact — the exact distortion §7.2 exists to prevent, arriving through the comparison instead of through the total. |
| 5.8 (new) | **`classifyFeeCharge` is exported** from §5.8, and §6.6's rollup calls it. | See below. |
| 6.6 | **The outliers and small-spend views read §5.9's and §5.11's findings** rather than re-deriving them, and say so when no analysis has run. | Those two are *judgements* with thresholds §7.4 keeps in one config object. A second implementation in Insights would carry its own copy and drift the first time either moved. |

**The fee rollup has to use §5.8's predicate, and finding that out took a failing test.**
The first version filtered on `category.kind = 'fee'` and was empty on any fresh ledger
— because §2.5 assigns a category from the *merchant's* default, and a maintenance fee
normalizes to a provisional merchant that has none. The rows that most obviously are
fees are precisely the ones carrying no category. §5.8 had already solved this and says
so in its own words: "a fee whose category was never assigned is still a fee — and the
converse, a fee-kind category with no recognisable keyword, is still a fee." So the
predicate is exported and shared, while the *judgement* stays behind: §5.8 decides which
fees clear §5.1's floor and are worth a card, and a rollup is a sum that applies neither.
One definition matters more than it looks here, because the keyword list is §7.4
configuration a user can tune.

**Hatching is a footprint, not a short bar.** An uncovered month keeps its width and its
place on the axis; what changes is that the column is striped and the bar is *absent*. A
short solid bar would say "you spent a little", which is the false statement §6.6 is
written to prevent — the true one is "we do not know", and only an obviously different
mark says it.

**The axis is scaled over covered months only.** An uncovered month holds whatever part
of it happened to be imported, and letting that set the peak would shrink every complete
month beside it — §7.2's exclusion arriving through the scale rather than through the
sum, which is the same error in a place nobody would look for it.

**Coverage is the intersection across the accounts in scope**, per §7.2, which has a
consequence worth stating because it reads as a bug the first time it is seen: *narrowing*
the account selection can **widen** the covered window. A month where one account has a
statement and another does not is a month whose total is missing a card's worth of
spending, so it is not covered — until that account is deselected.

## 9ab. Amendments from implementation — 2026-08-29 (§7.6, §6.9, §4.3, §2.3)

§9z built half of §7.6's corpus and said plainly what it could not do: it "measures
**precision** [...] It cannot measure **recall**, because the app has no way to show a
reader what it *failed* to find." This is the other half, and it closes that gap by
labelling the **ledger** rather than the findings.

The distinction is the whole amendment. A finding that never fired leaves nothing to
judge — but a charge marked "this is part of a subscription", whose merchant has no
`recurring_series`, is a miss with a row number. §7.6 asks for "the **expected**
findings written down", and *expected* is the word that makes absence measurable.

| § | Amendment | Why |
|---|---|---|
| 3.1 (new) | **`transaction_label`** — per row: the merchant it really is, and nullable flags for recurring / fee / transfer / outlier. | §7.6 describes the corpus as a file. Against the rows it becomes something the app can score itself with. |
| 2.3 (new) | **`PUT`/`DELETE /api/transactions/:id/label`** and **`GET /api/calibration`**. | The write is the pass; the read is the scorecard, and a corpus whose effect nobody can see is a corpus nobody finishes. |
| 4.3 | **A merchant correction writes a label as a side effect**, capturing the chain's answer *before* the alias lands. | See below — without this, correcting destroys the evidence it produces. |
| 6.9 | **Review gains a second mode**: a keyboard-driven pass over the charges in date order, with the scorecard beneath it. | Both halves of §6.9 are work on your data, but they are opposite: the queue is the app asking you something, the pass is you volunteering what it never thought to ask. |

**Every flag is three-valued, and that is what makes recall real.** `NULL` means nobody
looked; `0` means somebody looked and said no. A schema that could not tell those apart
would count every unexamined transaction as evidence the rules are right — which is
exactly backwards, because the unexamined rows are where a miss hides. It is also why
the pass makes **"nothing special"** its primary action and gives it one key: a corpus of
nothing but positives scores every rule perfectly.

**A correction is the strongest ground truth this app gets, and it erases itself.**
Somebody looked at a row and said what it actually is — but the moment §4.3's `user`
alias lands, the chain resolves correctly and nothing remembers that it had not. So the
label is written first, carrying the merchant the chain *had* reached. Corrections are
recorded under `origin = 'correction'` and counted separately from a deliberate pass,
because they are by definition the rows the chain got wrong: totalling them together
would libel §4.1.

**Recall is refused before an analysis has run.** Every figure compares a label to what
the rules concluded, and with no run to compare against, "everything was missed" would be
a statement about the rules rather than about the corpus. §4's normalization accuracy is
reported anyway — it compares your answer to the chain's, which runs at import.

**A CORS preflight that did not list `PUT`.** The label route is the first `PUT` in this
API, and `access-control-allow-methods` had not grown one. Two hundred and ninety-seven
tests passed and the first keystroke in the real page failed, because `app.inject`
dispatches straight at the router and never sends a preflight. There is now a test that
asserts the header names the methods the routes use — the only kind of test that could
have caught it without a browser.

## 9ac. Amendments from implementation — 2026-08-29 (§7.6, §2.7)

§9ab stored, on every label, the merchant §4.1's chain had reached when the judgement
was made — and nothing ever updated it. That is right for "was the chain correct then"
and wrong for the question anyone tuning would actually ask, which is "is it getting
better". The normalization figure would have stayed frozen at its worst reading however
much §4 improved.

| § | Amendment | Why |
|---|---|---|
| 2.7 | **§9v's full sweep refreshes each label's record of the chain's answer**, and reports how many it brought up to date. | The sweep is the one operation that already re-derives every row's answer, so the refresh costs one extra resolve for the handful of rows that carry a judgement and no second traversal. |
| 7.6 | **The refreshed answer is resolved *without* `user` aliases.** | This is the whole of the change; see below. |

**A naive refresh would have been worse than the stale number.** A correction writes a
`user` alias, so once it lands the chain genuinely *does* resolve that descriptor to the
corrected merchant. Re-capturing the ordinary answer would therefore make every corrected
row agree with itself and report perfect normalization accuracy — confidently wrong,
where the stale figure was merely out of date. What is measured instead is what the app
reaches **without being told**: the same chain, over the same descriptor, with the
human's own aliases withheld.

**`llm` aliases are kept in.** The exclusion is of the human, not of the machinery: a
model's grouping is still the app concluding something, and §4.2 already gates it behind
a confidence floor and the settled-series exception. Excluding it would measure a chain
the app does not actually run.

**The sweep never edits an assertion.** It touches the two chain columns and nothing
else. A sweep is the app recomputing its own answer, and it has no business revising what
a person said about a row — there is a test named after that, because the alternative is
a corpus that quietly rewrites its own ground truth.

**A provisional resolution records `null`, not an invented id.** Where the unaided chain
cleans a descriptor but matches no merchant, the honest entry is that it could not place
it — which is a different fact from placing it wrongly, and §4.1 step 7's queue is where
that one belongs.

## 9ad. Amendments from implementation — 2026-09-01 (§6.8, §3.1, §2.3, §5.4)

§6.8's **Categories** section — "taxonomy editor and overlap-group assignment" — was the
last of that section's six with nothing underneath it, and §9k had rendered it as a stated
absence since 2026-08-25. Building it needed five decisions this document does not make,
one column §3.1 does not have, and one limitation worth naming rather than discovering.

The section is two things wearing one heading, and they are not the same weight. Renaming
a category and moving it under a parent is CRUD: worth having, because a taxonomy nobody
can edit stays wrong, but nothing downstream changes shape when "Dining & Coffee" becomes
"Eating out". `overlap_group` is not CRUD. §5.4 defines it as "a curated subset of
categories where redundancy is meaningful", and putting two categories in one group is the
claim **these describe the same spending** — the entire input to that rule's
category-overlap half. §9d recorded that path as dead, because §9a's `SEED_CATEGORIES`
deliberately left the column unset rather than guess at the answer to the rule's hardest
question. This is where it stops being dead, and the guess is still not the app's to make.

| § | Amendment | Why |
|---|---|---|
| 3.1 | **`category` gains a `source`** (`seed` / `user`, migration 009), and the boot re-seed may only overwrite a row that is still `seed`. | §3.1 gives `merchant_canonical` a `source` and `category` none, which was harmless while the seed was the only writer. It stops being harmless the instant a person can edit the taxonomy: the composition root re-upserts every row of `SEED_CATEGORIES` **at every boot**, by id. Without the guard, a rename lasts until the next restart and `overlap_group` goes quietly back to NULL, taking §5.4's only claim with it. §4.3 settled the identical question for aliases — "permanent, top-precedence, immune to a later re-seed" — and this is that rule's storage rather than a new idea. |
| 2.3 | **`POST /api/categories`, `PATCH /api/categories/:id`, `DELETE /api/categories/:id` and `GET /api/categories/usage`.** | §2.3 lists one category row, the `GET` §9a added for §6.3's dropdown. §6.8 names a section that cannot be built from a read. |
| 6.8 | **A `kind` change is reported, never performed silently:** the write returns how many charges move and which rules read the column. | §5.8's fee rollup and §6.6's Insights select `kind = 'fee'`; §5.10 trends only `kind = 'spend'`. Flipping one moves every charge in the category between those rules, and it is the one edit on that page whose entire effect is off-screen. A row returned as though it were a rename would be the most consequential invisible write in the app. |
| 6.8 | **A category in use cannot be deleted, and the refusal carries the counts and the way through** — `?reassignTo=` moves the rows first. | §3.2's `ON DELETE RESTRICT` would refuse anyway; the database is not the problem. The problem is that a foreign-key error names nothing the person can see, on a screen that offered them the button. Reassignment is not a second endpoint because it is not a second intention: nobody moves 42 charges to Groceries for its own sake, and splitting it in two would let the move succeed and the delete fail, leaving a merge nobody asked for. |
| 3.1 | **The taxonomy is capped at two levels: a parent must itself be a root.** | `parent_id` is in §3.1 and **nothing in §5 or §6 reads it** — no rule sums a child into its parent, and §5.10 trends each category id on its own. A deeper hierarchy would be structure the app displays and never uses. Two levels is the depth the editor can draw, and an editor that cannot draw what it can create is how a taxonomy becomes unnavigable. |
| 3.1 | **Category names are unique case-insensitively, enforced at the API rather than by a constraint.** | §3.1 puts no UNIQUE on the column and adding one now would need a migration over rows that may already violate it. Two categories called "Streaming" and "streaming" are one mistake rather than two categories, and the write is the place that knows which. |

**Editing a shipped category makes it yours, and that is one-way.** Any `PATCH` sets
`source = 'user'`, including on a seed row, because an edit the next boot reverts is worse
than no editor at all. There is no path back to `seed`. That is the same asymmetry §4.3
accepts for aliases: the alternative is a "restore the shipped version" affordance that
would have to decide what happens to the charges filed under the name being discarded, and
discarding your own edit is already spelled as editing it back.

**A reassignment does not rewrite `category_source`.** Moving 42 charges out of a category
that is about to be deleted is a *merge of two categories*, not a re-categorization of the
rows in them. The person who filed a charge under "Streaming" still filed it, and
overwriting their provenance to make the app look like the author would cost §7.6 the
distinction it measures normalization accuracy with.

**Subcategories are promoted to the top level rather than following the delete.** Only a
root may have children under the cap above, so promotion is always legal where re-parenting
under an arbitrary target would not be — the target may itself be a child.

**§5.4's primary path still has no editor, and this section is not it.** §9d records that
the rule "reads the **merchant's** `overlap_group` first and the charges' categories
second", because a series has a merchant but no single category. §6.8 files overlap groups
under **Categories**, so that is what was built, and it is enough to make the rule fire for
the first time. But the merchant-level column — the one that wins — is still writable only
by the seed. That is a gap in §6, not in this section: it belongs beside the merchant, and
§6.3's merchant edit or §6.9's Review is where it would go.

**Two `source` values, not §4.3's four.** Four things write aliases; two write categories.
`rule` and `llm` are absent deliberately — §9x settled that "a category name the taxonomy
does not have is dropped, never created", so no model has ever inserted a row here and
none may.

**Deletion writes a §3.4 tombstone**, which adds `category` to that table's closed entity
set. It is the first row type a person can delete outright rather than archive or merge:
§6.2 archives an account, §9q merges merchants by writing aliases so the losing row
survives as the explanation. A category has no such role to play once nothing points at it.

**§6.8 has no stated absences left.** §9k's "Not built yet" panel — five sections built and
one explained — is gone with this, and so is §1's count of what §2.3 lists as missing on
this surface.
## 9ae. Amendments from implementation — 2026-09-01 (§6.2, §6.1)

A fresh database could not be used. §6.1 refuses to commit an import until its account is
confirmed, and the picker it offers can only pick from accounts that already exist; §6.2
listed its actions as "rename, set type, merge two accounts, archive" and never said
*create*, because it was written assuming an account arrives with its first statement. So
the Import page asked for an account, the Accounts page told the user to import a
statement, and neither could go first. Everything behind a commit — findings, review,
insights, §7.6's labelling pass — was unreachable on a new install.

`POST /api/accounts` had existed since §2.3. Only the UI was missing, and the Import
page said so in as many words: "Create one with `POST /api/accounts`". A screen that
tells its user to open a terminal has not shipped the feature.

| § | Amendment | Why |
|---|---|---|
| 6.2 | **Create is a fifth action on the Accounts page**, and its form opens by itself when no account exists at all. | The four §6.2 lists are all edits to an account that is already there. On an empty database the form is not one option among several — it is the only way forward, and it should not have to be found first. |
| 6.1 | **The same form is offered inline at the account step**, and the account it makes is confirmed onto that import in the same action. | This is where the need is felt. Someone filling it in on the Import page is doing so because *this statement* has nowhere to go; making them navigate away and come back is a step that exists only because two sections have different owners. |
| 6.1 | **`GET /api/imports/:id` returns each row's real file line**, and every row number on screen is that. | See below. |

**One row was showing three different numbers.** §3.2 stores both a `rowIndex` — the
0-based position among data records, after the preamble, the header and any blank lines —
and a `lineNumber`, the 1-based line of the actual file, and `schemas.ts` already said
which is which: "1-based physical line, which is what a human can go and look at". The
review table printed the index, the warning strip printed the index, and every message
out of `type:parsing` said "Line N". A duplicate on file line 51 therefore read as *Line
51* in its own sentence, *row 49* immediately beside it, and *49* in the table. All three
were correct. None of them agreed, and on a bank export with one header row the gap is
two — small enough to look like an off-by-one in the parser rather than like two
coordinate systems on one screen.

`lineNumber` is now the only one displayed, because it is the one that can be acted on:
it is where the row is if you open the file. `rowIndex` stays exactly what it was — the
key in commit payloads, near-duplicate resolutions and the zero-amount refusal — and is
never printed. The two are attached in one place so a warning added later cannot forget
to carry both.

**The review was not returning a line number at all.** `import-service.ts`
answered `lineNumber: row.rowIndex` — a placeholder that made the field agree with the
column beside it and disagree with every warning. The value was never lost: `raw_row`
has no column for it, but `parsed_json` holds the parser's whole `RawRow`, so it has
been on disk since §2.5 and only needed reading back. No migration.

**And it cannot be recomputed, only read.** The Northgate fixture has three preamble
lines, then a blank, then its header — and the blank is dropped before mapping, so no
arithmetic over `skipLines` and the header recovers the offset. Only the number the
reader recorded while it was walking the file is right, which is why the test asserts
against a fixture that has one.

**A failed row's line comes from the parser's warning.** An unparsed row has no
`parsed_json` to read it out of. Its `unparsed_row` warning carries both numbers and
is emitted for exactly those rows, so the failures are matched up through it.

**Where a line cannot be resolved, none is shown.** Falling back to printing the
`rowIndex` would reintroduce the ambiguity in the one case nobody could check.

## 10. Open discrepancies — recorded, not resolved

Building the persistence and import-commit path on 2026-08-06 found one place where this
document contradicts itself. It is recorded here rather than amended, because resolving it
means choosing a number, and §7.6 makes choosing a number a calibration decision against real
statements rather than a bug fix. **The code implements what §3.3 specifies, verbatim.**

**~~§5.2's Low band is dead code again, for fitted series.~~ Closed by §9m on 2026-08-26** —
and closed by measurement rather than by any of the judgements below, which is why it is struck
here rather than deleted.

The discrepancy was that §5.2 lists four corrections made specifically so the Low band would
stop being unreachable, and §9l's fee test then removed `amount_stability`'s range from the
other end: every series it admitted was amount-stable by construction, so the term sat near 1
and a quarter of the formula's span was gone. A cadence-ragged three-occurrence series bottomed
out at **0.575**, just inside Medium. `regularity` could not make up the difference, because
`regularityOf` scales residuals by the cadence's own tolerance and monthly's is ±4 days: gaps of
27 and 34 days score 0.985.

What changed is the premise, not the formula. §9m found that the fee test at 0.5 was calibrated
against a corpus distorted by a pass-2 defect, and moving it to 0.34 admits a **variable-amount**
recurring bill — which carries `amount_stability` 0, the term §10 said had lost its range. Such
a series at three occurrences scores **0.493**, inside Low. The three ways out considered here —
reweighting the formula, making the fee test a partial-credit score, accepting that a
subscription which passes it is simply never Low — were all avoided; none was taken.
`libs/ledgerline/analyzers/src/lib/recurrence.spec.ts` pins 0.493 and keeps 0.575 as the floor
for a series whose amount is flat.

**§3.3's near-duplicate predicate cannot catch §3.3's own pending-to-posted example.** That
section names "a pending charge that later posts" as one of the three cases the near-duplicate
pass exists to cover, and illustrates it with "$50.00 on the 10th becomes $59.00 on the 12th
once a tip settles". The predicate it then states — `|Δ effective_date| ≤ 3` days, the same
`collapse_v1(description_raw)`, and an amount within **±$2 or ±3%** — admits neither: an 18%
tip is 900 cents and 18 percent. A tipped restaurant meal pulled mid-cycle therefore lands as
two rows, and the month over-counts by the authorization amount until the pending row is
superseded by something else or removed by hand.

The failure direction is the one §3.3 prefers — "over-counting is visible and losing a real
transaction is not" — so this is a miss, not a corruption. Widening the band to cover tips
(20–25% of the amount, or an absolute floor in the tens of dollars) would also make any two
same-merchant charges in one week near-duplicates of each other, which is a review queue full
of choices nobody wants to make. A tip-shaped rule would more likely key on the pending flag
than on the amount: *an existing pending row whose posted successor is larger by up to 30%* is
a narrower predicate than a wider symmetric band. That is a design decision, and it is open.

`libs/ledgerline/data/src/lib/import/import.spec.ts` pins the current behaviour with a test
named after this discrepancy, so whichever way it is resolved, the resolution is deliberate.

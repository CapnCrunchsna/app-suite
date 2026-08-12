# Ledgerline — Build Specification

The implementation contract for Ledgerline: Nx layout and module boundaries, the HTTP
API, the LLM provider seam, the parse-to-analyze pipeline, the SQLite schema, the merchant
normalization chain, the nine analyzer rules with their thresholds, and the page-level UI
contract. Everything here must be true of the code in this repository at this commit. The
concept, the locked decisions, the roadmap and the open questions live in the companion plan
artifact, `artifacts/plans/ledgerline-design.md`.

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
config-and-hash machinery, and the **recurrence rule** (§5.2, §5.3) that §5.4–§5.7 build on.

PDF ingest, the LLM stage of §4.2, **§5.4–§5.11's eight remaining rules**, §2.6's transfer
matcher, §2.7's job **runner**, the analysis and findings endpoints of §2.3 and the other six
pages of §6 are **not** built. Nothing yet *runs* the analyzers: there is no `buildSnapshot()`,
no finding persistence and no `POST /api/analysis/run`, so §5.2's series exist as a tested pure
function and have never been computed over stored data.
`docs/statement-parsing.md` records what has and has not been validated. §9, §9a, §9b and §9c
list the amendments implementation made to this document.

Every number in this document is still a *designed* threshold, not a measured one; the
calibration note in §7.6 says what has to happen to each of them once real statements are in
the database. **No real statement has been parsed yet** — the code was validated against
synthetic fixtures only, which is a weaker claim than §7.6's and is stated as such in
`docs/statement-parsing.md` §6.

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
| `GET` | `/api/merchants/review-queue` | Provisional merchants and sub-floor LLM proposals awaiting a decision. |
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
| `category` | `id`, `name`, `parent_id`, `kind` (spend/fee/transfer/income), `overlap_group` |
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
2. **Processor prefixes** — a maintained prefix table: `SQ *`, `TST*`, `SP `, `PAYPAL *`, `PP*`, `IN *`, `WWW.`, `POS DEBIT`, `ACH DEBIT`, `DEBIT CARD PURCHASE`, `RECURRING PMT`. Notably these often *hide* the real merchant behind Square/Toast/PayPal — the rule strips the prefix and keeps what follows.
3. **Store and terminal numbers** — `#0042`, `STORE 1234`, trailing 3–5 digit runs, and long numeric reference tails.
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
- **Merchant aliases** — the review queue for LLM proposals and provisional merchants, a list of user corrections, and a re-normalize trigger with job progress.
- **Analyzers** — per-rule enable (with the two halves of `duplicate.v1` toggled separately) and threshold overrides, plus rule versions and the current `config_hash`. Changing a threshold warns that dismissed findings in that rule will be re-evaluated.
- **Categories** — taxonomy editor and overlap-group assignment.
- **Data** — database path, backup, export to JSON/CSV, wipe, and the degraded-LLM-call log.

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

## 10. Open discrepancies — recorded, not resolved

Building the persistence and import-commit path on 2026-08-06 found one place where this
document contradicts itself. It is recorded here rather than amended, because resolving it
means choosing a number, and §7.6 makes choosing a number a calibration decision against real
statements rather than a bug fix. **The code implements what §3.3 specifies, verbatim.**

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

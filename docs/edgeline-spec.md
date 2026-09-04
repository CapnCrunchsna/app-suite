# Edgeline — Detailed Implementation Specification (v1.1)

**Type:** Plan · **Date:** 2026-07-06 · rev 2026-07-08 (Elasticsearch replaces SQLite, §4) ·
Companion to the [Architecture Plan](../../artifacts/plans/sports-betting-intel-system-plan.md) (2026-07-02)

---

## 0. How to Use This Document

This spec is written for an implementer (human or model) who should **follow it literally**
rather than make design decisions. Rules:

1. Execute phases **in order** (§15). Do not start a phase before the previous phase's
   checklist is fully checked.
2. Do not substitute technologies, rename tables/fields, or "improve" the algorithms. If
   something is impossible as written, stop and report the exact blocker to the user.
3. Every algorithm in §6 has a **golden test** in §14 with exact expected numbers. If your
   implementation doesn't reproduce those numbers, the implementation is wrong — not the test.
4. Anything in the **Prohibitions list (§16) is non-negotiable.**
5. Items marked `ASK USER` require user input before proceeding (collected list in §17).

---

## 1. Fixed Decisions (do not revisit)

| Decision | Value |
|---|---|
| Engine language | Python, latest stable (3.14 as of writing), pinned with `uv` |
| Web framework | FastAPI (pure JSON API — no server-side HTML rendering) |
| Database | Elasticsearch 9.x, single-node via Docker Compose, localhost-only, official async Python client (decision 2026-07-08; replaced SQLite) |
| UI | Angular + TypeScript app `config-ui` inside an Nx monorepo |
| Monorepo | The **existing** `app-suite/` Nx workspace (`@metrum/source`), not a new one; Python engine wired in via run-commands targets |
| Notifications | Discord bot (discord.py 2.x). Native Android app: NOT in scope for v1 |
| Odds provider v1 | The Odds API (`the-odds-api.com`), free tier for dev, ≤ $100/mo paid tier for production |
| First sport | MLB (`baseball_mlb`); NFL/NBA added later by config only |
| Bet placement | NEVER automated. The system only notifies; a human places every bet |
| Money representation | Integer **cents** everywhere (`stake_cents`, `pnl_cents`) |
| Odds representation | Decimal odds as REAL, ≥ 6 significant digits; American odds only at display edges |
| Time representation | UTC ISO-8601 strings everywhere; convert only in the UI |
| Mode | `paper_mode = true` until the user explicitly flips it (§7 gate) |

---

## 2. Repository Scaffold

### 2.1 Where this lives — DONE, do not re-scaffold

**Revised 2026-09-03 against the real workspace.** Edgeline does **not** get its own Nx
workspace. `app-suite/` is already the Nx monorepo for every Angular/TypeScript UI and
polyglot backend here (it is its own git repo, gitignored by the workspace), and its
`CLAUDE.md` already named Edgeline as a resident project. A second workspace would have split
the shared `ui` and `api-client` libraries away from the app that needs them.

The scaffold landed on 2026-09-03. **It exists — do not run `create-nx-workspace`.**

```
app-suite/                              the Nx monorepo (own git repo)
  apps/edgeline-api/                    Python engine — SCAFFOLDED
    pyproject.toml  .python-version     uv-managed, requires-python >=3.14
    project.json                        Nx targets: serve, worker, test-py, es-up, es-down
    docker-compose.yml                  single-node Elasticsearch + Kibana (§4.1)
    .env.example                        the §3.1 keys; .env is gitignored
    src/edgeline/__init__.py            package root
    tests/conftest.py                   ES-reachability skip for @pytest.mark.es
    tests/fixtures/                     recorded Odds API responses
```

Conventions this workspace already enforces, and that Edgeline follows: apps are
`<project>-ui` / `<project>-api`; libs are `libs/<project>/<lib>` plus `libs/shared/*`;
packages are scoped `@metrum/*`; project tags are `scope:el` + `type:app`, and `scope:el` is
registered in the root `eslint.config.mjs` `depConstraints` (may depend on `scope:el` and
`scope:shared`).

**Toolchain — complete as of 2026-09-04. All of this is done; none of it needs redoing:**

```bash
cd app-suite/apps/edgeline-api
uv sync                       # DONE — 50 packages against CPython 3.14.7; uv.lock committed
uv run pytest                 # DONE — 2 passed against a live datastore
nx run edgeline-api:es-up     # DONE — Elasticsearch 9.0.3 green, Kibana available
cp .env.example .env          # STILL NEEDED — fill ODDS_API_KEY (§17)
```

Both `uv` (0.12.9) and CPython 3.14.7 were installed with `winget`. **Do not use uv's managed
Python here:** `uv python install 3.14` downloads the interpreter then fails with "Missing
expected target directory for Python minor version link", reproducibly, `--reinstall` included.
`pyproject.toml` pins `python-preference = "only-system"` so `uv sync` uses the winget
interpreter. Versions are pinned in `uv.lock`, as intended — `pyproject.toml` deliberately
carries unpinned ranges.

**The datastore works, and getting there was the expensive part of 2026-09-04.** Docker Desktop
was stuck at 3.0.0 (Dec 2020), whose engine 20.10.0 denies the `clone3` syscall with `EPERM`
instead of `ENOSYS` — the ES 9 image's JVM calls it from `pthread_create`, so the container died
with `Error occurred during initialization of VM`. The engine is now 29.7.2 and the whole class
of problem is gone. Two things are worth keeping, because both cost real time:

- **An in-place upgrade from 3.0.0 hangs.** Every run logged `Existing installation found:
  build=50684, version=3.0.0`, showed an "Installing Docker Desktop" window, then sat at zero
  CPU indefinitely — through elevation, through a reboot, through a WSL update. **Uninstalling
  first and installing clean worked on the first try.** If a machine here is on an ancient
  Docker, uninstall before upgrading.
- **Don't trust a small container as a proxy for the real image.** `docker run --rm ubuntu:24.04
  bash -c "…"` succeeded on the broken engine, because `bash` forks via plain `clone` and never
  touches `clone3`. Only Elasticsearch itself reproduced the failure.

`edgeline-ui` **is scaffolded** (an app shell; its pages are Phase 3). `nx g
@nx/angular:application` refuses in this workspace — the Angular generator asserts against the
TypeScript project-references setup the monorepo uses — so it was generated with
`NX_IGNORE_UNSUPPORTED_TS_SETUP=true` and reconciled against `apps/ledgerline-ui/`. That
reconciliation is four specific fixes, listed in `apps/edgeline-api/README.md`; any regeneration
needs the same four.

### 2.2 Directory layout (final state)

```
app-suite/                        # the existing Nx monorepo (its own git repo)
  apps/
    edgeline-ui/                  # Angular app shell — SCAFFOLDED; pages are Phase 3
      src/app/pages/...           # pages per §11
    edgeline-api/
      pyproject.toml  uv.lock
      project.json                # Nx targets: serve, worker, test-py, es-up, es-down
      docker-compose.yml          # single-node Elasticsearch + Kibana (§4.1)
      .env                        # secrets (gitignored) (§3.1); .env.example is committed
      src/edgeline/
        __init__.py
        config.py                 # pydantic-settings; reads .env + settings document
        es.py                     # AsyncElasticsearch client factory + ensure_indices()
        indices.py                # index names, mappings, seeds (§4)
        schemas.py                # pydantic I/O models (§5)
        oddsmath.py               # conversions, devig, consensus, EV, arb, staleness (§6)
        staking.py                # Kelly + caps + guardrails (§6.7)
        providers/
          base.py                 # OddsProvider protocol + registry
          the_odds_api.py         # v1 adapter (§8)
        normalizer.py             # provider schema -> canonical rows (§7)
        engine.py                 # opportunity detection pipeline (§7)
        dedup.py                  # opportunity hashing/lifecycle (§7.4)
        deeplink.py               # link ladder assembly (§9.4)
        notify/
          discord_bot.py          # bot, embeds, buttons, handlers (§9)
        grading.py                # results + CLV job (§12)
        scheduler.py              # polling loops + closing-line capture (§13)
        api/
          main.py                 # FastAPI app; mounts routers; serves config-ui bundle
          routers/                # settings, providers, sportsbooks, opportunities,
                                  # recommendations, results, bankroll, matching, system
      tests/
        fixtures/                 # recorded The Odds API JSON responses
        test_oddsmath.py          # golden tests G1–G8 (§14)
        test_engine.py  test_staking.py  test_dedup.py  test_normalizer.py
  libs/
    shared/api-client/            # EXISTS — generated TS client (§11.3), today Ledgerline's
    shared/ui/                    # EXISTS — shared Angular components/theme
    edgeline/                     # Edgeline-only libs, when any are needed
```

`apps/edgeline-api/project.json` targets (all `nx:run-commands`, `cwd` = the project root):
`serve` → `uv run uvicorn edgeline.api.main:app --reload --port 8000`; `worker` →
`uv run python -m edgeline.scheduler`; `test-py` → `uv run pytest`; `es-up` / `es-down` →
`docker compose up -d` / `down`.

**Why `test-py` and not `test`:** the monorepo's green bar is `npm run check`
(`nx run-many -t lint typecheck test build`), and this target shells through `uv`. The original
reason — uv not installed — no longer applies. The rename is left to the first session that adds
real coverage, so it lands behind actual tests and makes `uv` on `PATH` a hard requirement of
`npm run check` at a moment someone is watching. The reasoning is recorded in the project's
`metadata.description`.

---

## 3. Configuration

### 3.1 `.env` (secrets only — never in git, never in the DB)

```
ODDS_API_KEY=            # ASK USER
DISCORD_BOT_TOKEN=       # ASK USER
DISCORD_CHANNEL_ID=      # ASK USER (numeric channel id for alerts)
ES_URL=http://localhost:9200
```

### 3.2 Settings — complete default set

All runtime-tunable values live in the single `"global"` document of `edgeline-settings`
(§4.3) and are editable from the UI. Seed exactly these defaults at bootstrap:

| key | default | meaning |
|---|---|---|
| `paper_mode` | `true` | recommendations recorded, alerts sent, but flagged PAPER |
| `kill_switch` | `false` | when true: polling continues, all alerting stops |
| `kelly_fraction` | `0.25` | fraction of full Kelly |
| `bankroll_start_cents` | `100000` | $1,000 default — ASK USER for real value |
| `ev_threshold_pct` | `2.0` | min EV% to alert |
| `min_edge_to_bet_pct` | `1.5` | below this: log opportunity, do not alert |
| `min_books_for_consensus` | `4` | markets quoted by fewer books never alert |
| `arb_min_profit_pct` | `0.5` | min arb profit after rounding |
| `max_stake_cents` | `25000` | hard cap $250/bet |
| `max_stake_pct` | `2.0` | hard cap % of current bankroll |
| `daily_exposure_cap_cents` | `100000` | sum of recommended stakes/day |
| `daily_loss_stop_cents` | `50000` | graded losses today ≥ this → auto kill_switch |
| `stake_rounding_cents` | `100` | round stakes to $1 |
| `devig_method` | `"multiplicative"` | one of multiplicative/additive/power/shin |
| `consensus_weights` | `{"default":1}` | per-book integer weights, e.g. `{"pinnacle":3}` |
| `staleness_sigma_floor` | `0.002` | σ floor to avoid divide-by-near-zero |
| `edge_improve_delta_pct` | `0.5` | re-alert same opportunity only if edge grew ≥ this |
| `alert_cooldown_s` | `300` | per market key |
| `sports_enabled` | `["baseball_mlb"]` | The Odds API sport keys |
| `markets_featured` | `["h2h","spreads","totals"]` | polled every cycle |
| `markets_props` | `["batter_home_runs","pitcher_strikeouts"]` | polled per §8.4 |
| `poll_interval_s` | `120` | featured-markets cycle (production) |
| `poll_interval_dev_s` | `21600` | dev/free tier: 4 polls/day |
| `props_poll_interval_s` | `600` | props, only for events starting within 6 h |
| `closing_capture_offset_s` | `300` | force snapshot at start_time − 5 min (CLV) |
| `quota_monthly_budget` | `500` | credits; raise when paid tier starts |

---

## 4. Elasticsearch Setup, Indices & Mappings

### 4.1 Running ES locally (dev)

`docker-compose.yml` at the monorepo root — copy exactly, pin the current 9.x tag at setup:

```yaml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:9.0.3
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false   # acceptable ONLY with the localhost-only binding below
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports:
      - "127.0.0.1:9200:9200"          # localhost only — never 0.0.0.0
    volumes:
      - esdata:/usr/share/elasticsearch/data
  kibana:
    image: docker.elastic.co/kibana/kibana:9.0.3
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    ports:
      - "127.0.0.1:5601:5601"
volumes:
  esdata:
```

Security is disabled only because both ports bind to `127.0.0.1`. If ES ever moves off this
machine (e.g. to the home server), enable auth + TLS **first** and move credentials to `.env`.
Kibana at `http://localhost:5601` is the ops window into every index — no extra tooling needed.

### 4.2 Bootstrap rules (`es.py` + `indices.py`)

- `es.py` exposes `get_client()` (an `AsyncElasticsearch` from the official `elasticsearch`
  package, pointed at `ES_URL`) and `ensure_indices()`, called at both engine and worker
  startup.
- `ensure_indices()` creates each missing index with the exact mapping derived from §4.3 and
  `"dynamic": "strict"` — unknown fields must fail loudly, never be silently indexed.
  Exception: `edgeline-settings` uses `"dynamic": false` (docs are read/written whole by
  `_id`; nothing needs indexing).
- Field-type conventions (apply mechanically to §4.3): ids/keys/enums → `keyword`;
  timestamps → `date`; money → `long` (cents); probabilities & decimal odds → `double`;
  flags → `boolean`; opaque JSON blobs → `object` with `"enabled": false` (stored in
  `_source`, not indexed).
- Every index name is prefixed `edgeline-`. Tests use the prefix `edgeline-test-` (§14).

### 4.3 Index catalog

| Index | `_id` | Fields |
|---|---|---|
| `edgeline-settings` | `"global"`, `"runtime"` | `global`: every §3.2 key (dynamic:false; partial-doc updates). `runtime`: worker heartbeat/last-run stamps, written only by the scheduler |
| `edgeline-providers` | provider key | display_name kw · enabled bool · config obj(enabled:false) · quota_used long · quota_budget long · quota_reset_at date |
| `edgeline-sportsbooks` | book key | display_name kw · md_licensed bool · enabled bool · priority integer · link_templates obj(enabled:false) |
| `edgeline-events` | `{sport_key}:{provider_event_id}` | sport_key kw · commence_time date · home_team kw · away_team kw · completed bool · home_score integer · away_score integer |
| `edgeline-odds-snapshots` | auto | event_id kw · book_key kw · market_key kw · selection kw · line double · price_decimal double · is_closing bool · @timestamp date |
| `edgeline-opportunities` | **`opp_hash`** (§7.4) | type kw(arb\|ev) · event_id kw · market_key kw · legs object[] (book_key kw, selection kw, line double, price_decimal double, devig_prob double, staleness double, bet_first bool) · edge_pct double · status kw(open\|alerted\|closed\|expired) · detected_at/expires_at/closed_at date · closing_edge_pct double |
| `edgeline-recommendations` | auto | opportunity_id kw (= opp_hash) · stakes obj(enabled:false, the §5 StakePlan) · paper bool · channel kw · sent_at date · message_ref kw |
| `edgeline-bets` | auto | recommendation_id kw · confirmed_via kw(button\|reaction\|ui) · stake_actual_cents long · odds_actual_decimal double · placed_at date |
| `edgeline-results` | **recommendation id** | bet_id kw · outcome kw(win\|loss\|push\|void) · pnl_cents long · clv_pct double · needs_manual bool · graded_at date |
| `edgeline-bankroll-ledger` | auto | book_key kw · delta_cents long · reason kw(deposit\|withdrawal\|bet_won\|bet_lost\|manual_adjust) · ref_result_id kw · @timestamp date — **no stored balance field** |
| `edgeline-unmatched` | auto | provider_key kw · raw obj(enabled:false) · reason kw · resolved bool · created_at date |

`legs` is a plain `object` array, NOT `nested` — no query correlates fields across two legs
of the same document, so nested overhead is unjustified.

### 4.4 Consistency & write rules (memorize these)

1. **Idempotency by `_id`.** Opportunities are keyed by `opp_hash`; results are keyed by
   recommendation id. Re-processing overwrites — it can never duplicate. There are no unique
   constraints to rely on; the `_id` IS the constraint.
2. **`refresh="wait_for"`** on every write that a same-cycle or same-request read depends on:
   opportunity upserts, recommendation inserts, bet confirmations, settings updates. Bulk
   snapshot ingestion uses default refresh — the detection cycle works from the in-memory
   batch it just fetched, never from an ES read-back (§7.1).
3. **Balances are aggregations, never fields.** Per-book bankroll =
   `sum(delta_cents) where book_key = X`; total bankroll = `sum(delta_cents)` over the whole
   ledger. Do not store a running balance anywhere.
4. **Optimistic concurrency** on opportunity status transitions: read `_seq_no` /
   `_primary_term`, write with `if_seq_no`/`if_primary_term`, retry once on conflict — the
   API process and the worker must not clobber each other.
5. **Deletes are rare and explicit:** only `edgeline-unmatched` resolution may delete;
   everything else is append/update only.

Seed `edgeline-sportsbooks` with (verify Maryland licensure before enabling — `ASK USER` to
confirm the final list): `draftkings, fanduel, betmgm, williamhill_us (Caesars), betrivers,
espnbet, fanatics, bet365`. All start `enabled: false`; the user enables from the UI.

---

## 5. Canonical Pydantic Schemas (engine-internal I/O)

```python
class BookOddsSnapshot(BaseModel):          # normalizer output, one price
    provider_event_id: str; sport_key: str; commence_time: str
    home_team: str; away_team: str
    book_key: str; market_key: str
    selection: str                          # canonical form, §7.2
    line: float | None
    price_decimal: float
    fetched_at: str

class OpportunityLeg(BaseModel):
    book_key: str; selection: str; line: float | None
    price_decimal: float; price_american: int
    devig_prob: float
    staleness: float | None = None
    bet_first: bool = False

class StakeLeg(BaseModel):
    book_key: str; selection: str; stake_cents: int
    to_win_cents: int; deep_link: str; link_level: str   # 'betslip'|'event'|'book_home'

class StakePlan(BaseModel):
    total_cents: int
    legs: list[StakeLeg]
    method: str                              # 'kelly' | 'arb_split'
    guardrails_applied: list[str]            # e.g. ['max_stake_pct']
```

---

## 6. Odds Math — Exact Algorithms

Implement all functions in `oddsmath.py` as pure functions (no I/O). Round only at display
time; keep full float precision internally.

### 6.1 Conversions

```
american_to_decimal(a):  a > 0 → 1 + a/100 ;  a < 0 → 1 + 100/abs(a)
decimal_to_american(d):  d ≥ 2 → round((d−1)*100) ; 1 < d < 2 → round(−100/(d−1))
implied_prob(d) = 1/d
```

Reference values (golden test G1): −110 → 1.909091 → 0.523810 · +105 → 2.05 → 0.487805 ·
+100 → 2.0 → 0.5 · −200 → 1.5 → 0.666667 · +250 → 3.5 → 0.285714.

### 6.2 De-vig (`devig(probs: list[float], method) -> list[float]`)

Input: raw implied probabilities of **all outcomes of one market at one book**.
- `multiplicative` (default): `p_fair[i] = p[i] / sum(p)`.
- `additive`: `p_fair[i] = p[i] − (sum(p) − 1)/n`.
- `power` and `shin`: implement later behind the same signature; v1 may raise
  `NotImplementedError` — the setting exists but defaults to multiplicative.

Golden test G2: Over −120 / Under +100 → raw (0.545455, 0.500000), sum 1.045455 →
fair **(0.521739, 0.478261)**.

### 6.3 Consensus fair probability (`consensus(book_probs: dict[str,float], weights) -> float`)

1. For each quoting book, take its de-vigged probability for the selection.
2. Repeat each value `weights.get(book_key, weights["default"])` times (integer weights).
3. Return the **median** of the expanded list.

Golden test G3: A(w=2)=0.520, B=0.510, C=0.515, D=0.505 → expanded sorted
[0.505, 0.510, 0.515, 0.520, 0.520] → consensus **0.515**.

### 6.4 +EV detection

For each book/selection with consensus available from ≥ `min_books_for_consensus` **other**
books: `ev_pct = (consensus_prob × price_decimal − 1) × 100`. Alert if
`ev_pct ≥ ev_threshold_pct`.

Golden test G4: consensus 0.545, price −110 (1.909091) → EV = 0.545 × 1.909091 − 1 =
**+4.05%** → alerts at the 2.0 default threshold.

### 6.5 Arbitrage detection & stake split

Across **different** enabled books, take the best price per outcome of a market (2-way or
3-way). Let `inv = Σ 1/dᵢ`.

```
arb exists  ⟺ inv < 1
profit_pct  = (1/inv − 1) × 100
stake_i     = B × (1/dᵢ) / inv          (B = total allocation from staking engine)
```

Then round each stake to `stake_rounding_cents` and **re-verify**: worst-case profit =
`min_i(stake_i × dᵢ) − Σ stakes` must stay ≥ `arb_min_profit_pct` of Σ stakes, else discard.

Golden test G5: Ravens +110 (2.10) at book X, Chiefs −102 (1.980392) at book Y.
inv = 0.476190 + 0.504950 = 0.981140 → profit **1.92%**. B = $100 → stakes **$48.53 /
$51.47**. After $1 rounding → $49/$51; payouts $102.90/$101.00; worst-case profit $1.00
(1.0%) ≥ 0.5% → accept.

### 6.6 Staleness — "which leg is more likely wrong"

For each arb leg (book b, selection s):

```
others   = de-vigged probs for s from all enabled books EXCEPT b
mu       = median(others);  sigma = max(stdev(others), staleness_sigma_floor)
staleness(b) = abs(p_b_devig − mu) / sigma
```

The leg with the **higher** score gets `bet_first = true`. Tie (Δ < 0.5): mark the leg whose
price most recently changed (compare the two latest snapshots per book).

Golden test G6: BetMGM p=0.476 vs others μ=0.511 σ=0.005 → staleness **7.0**; FanDuel
p=0.505 vs μ=0.512 σ=0.005 → **1.4** → BetMGM leg is `bet_first`.

### 6.7 Staking (`staking.py`)

**+EV (fractional Kelly):**

```
b       = price_decimal − 1
f_full  = (consensus_prob × price_decimal − 1) / b
f       = f_full × kelly_fraction
stake   = f × current_bankroll_cents
```

**Arb:** `B = min(max_stake_cents, max_stake_pct × bankroll)` fed into the §6.5 split.

**Guardrail order (apply after computing raw stake; record each applied rule in
`guardrails_applied`):**
1. `stake > max_stake_cents` → clamp.
2. `stake > max_stake_pct × bankroll` → clamp.
3. Today's Σ recommended stakes + stake > `daily_exposure_cap_cents` → clamp to remainder;
   if remainder < one rounding unit → suppress alert entirely.
4. Round to `stake_rounding_cents`.
5. Edge < `min_edge_to_bet_pct` → store opportunity, send nothing.
6. `kill_switch` or daily loss stop tripped → store opportunity, send nothing.

Golden test G7: p=0.545, price −110, bankroll $1,000, quarter-Kelly:
f_full = 0.040455/0.909091 = 0.044500 → f = 0.011125 → $11.13 → rounds to **$11**;
no caps triggered.

### 6.8 CLV (grading-time)

`clv_pct = (closing_consensus_prob × price_decimal_at_alert − 1) × 100` — the EV of the bet
re-evaluated at the closing consensus. Golden test G8: alerted at −110 (1.909091), closing
consensus 0.552 → CLV = **+5.38%**.

---

## 7. Pipeline Behavior

### 7.1 Poll cycle (per enabled sport)

```
if kill_switch → skip alerting but still poll (data continuity)
if provider quota_used ≥ quota_budget → skip cycle, log warning, surface in UI
snapshots = provider.fetch_odds(sport, markets)         (§8)
normalize → bulk-index edgeline-odds-snapshots + upsert events   (§7.2)
group the IN-MEMORY batch per (event, market, selection, book)   -- never read back from ES
run §6.4 and §6.5 over each market group
for each detection: dedup (§7.4) → staking (§6.7) → deep links (§9.4)
                    → Discord alert (§9) → index recommendation (refresh=wait_for)
```

### 7.2 Normalizer (v1 = thin, by design)

The Odds API already returns **consistent event and team names across bookmakers within one
response** — cross-book fuzzy matching is NOT needed while it is the only provider. v1 duties:

- Map provider JSON → `BookOddsSnapshot` rows.
- Canonical selection strings: h2h → team name exactly as provider gives it; totals →
  `"Over {point}"` / `"Under {point}"`; spreads → `"{team} {+/-point}"`; props →
  `"{player} Over {point}"` (player from the outcome's `description` field).
- **Line-match rule:** +EV compares only identical `(market_key, line)`. Arbs may pair
  opposite sides with different lines ONLY on spreads/totals when the pairing is strictly
  favorable to both sides (e.g. Over 8.0 vs Under 8.5, a middle) — v1: skip these, same-line
  only. Log skipped middles.
- Anything unparseable → insert into `unmatched_selections` with the raw JSON, never guess.

Keep the interface multi-provider-shaped (`normalize(provider_key, raw) ->
list[BookOddsSnapshot]`) so a premium feed can be added without touching the engine.

### 7.3 Quarantine

A row lands in `unmatched_selections` when: unknown market key, missing point where required,
unknown outcome name shape, or duplicate conflicting prices in one response. The UI (§11)
lists them; resolution is manual.

### 7.4 Dedup & lifecycle

```
opp_hash = sha256(f"{event_id}|{market_key}|{sorted(leg selections)}|{sorted(leg books)}")
```

The hash is the document `_id` in `edgeline-opportunities`: the existence check is a GET by
id, and every state change goes through the update API under optimistic concurrency
(§4.4 rule 4).

- Hash exists with status open/alerted: update `edge_pct`; re-alert ONLY if edge improved by
  ≥ `edge_improve_delta_pct` AND cooldown expired.
- Detection disappears next cycle → status `closed`, record `closing_edge_pct`.
- `commence_time` passes → status `expired`.
- Cooldown: at most one alert per `(sport, market_key)` per `alert_cooldown_s`, whichever
  detection has the highest edge wins the slot.

---

## 8. The Odds API Integration (`providers/the_odds_api.py`)

Base URL `https://api.the-odds-api.com/v4`. Auth: `apiKey` query param.

| Purpose | Endpoint | Cost |
|---|---|---|
| List sports | `GET /sports` | free |
| Featured odds | `GET /sports/{sport}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=decimal` | ≈ markets × regions credits |
| Event list | `GET /sports/{sport}/events` | free |
| Player props | `GET /sports/{sport}/events/{eventId}/odds?regions=us&markets={props}&oddsFormat=decimal` | ≈ markets × regions credits **per event** |
| Scores | `GET /sports/{sport}/scores?daysFrom=2` | 1–2 credits |

- **Always** read response headers `x-requests-used` / `x-requests-remaining` and write them
  to `providers.quota_used`. Treat the header as truth, not your own math.
- Request `oddsFormat=decimal` so no conversion ambiguity exists at ingest.
- HTTP handling: timeout 15 s; on 429 back off ×2 up to 4 tries; on 401 → kill cycle and
  surface "API key invalid" in UI; on 5xx → skip cycle, log.
- **Fixture recorder:** a debug flag writes every raw response to
  `tests/fixtures/{sport}_{endpoint}_{timestamp}.json`. Golden/integration tests replay these
  with `respx` — no live API in tests, ever.

### 8.4 Polling policy vs. budget

| Mode | Featured markets | Props | Approx credits |
|---|---|---|---|
| Dev (free, 500/mo) | every 6 h (4×/day → ~360/mo) | manual trigger only | ≤ 500/mo |
| Production (~$59–100 tier) | every 120 s | every 600 s, only events starting < 6 h | compute before enabling: `(86400/interval) × markets × regions × 30` and per-event prop cost; must fit `quota_monthly_budget` |

The scheduler must refuse to start a cadence whose computed monthly cost exceeds
`quota_monthly_budget`, and must log the computed figure at startup.

---

## 9. Discord Notifications

### 9.1 Setup (one-time, `ASK USER` for outputs)

Discord Developer Portal → New Application → Bot → copy token; enable **Message Content
intent** OFF (not needed), **Server Members** OFF. OAuth2 URL with scopes `bot applications.commands`,
permissions: Send Messages, Embed Links, Add Reactions. User invites bot to their server and
supplies the alert channel id.

### 9.2 Message formats (exact)

Use `discord.Embed` + `discord.ui.View` with **persistent views** (`timeout=None`, stable
`custom_id`s, views re-registered in `setup_hook` on every bot start — without this, buttons
die on restart).

**+EV embed:** title `⚡ +EV {ev_pct}% — {book} {market_key}` · color `0x2dd4bf` · description
line 1: `{selection} @ {american} · fair {fair_american}` · line 2: `Stake:` + stake in a
single inline code span (mobile long-press copies it) · line 3: `[Open {book} ➜]({deep_link})`
· footer: `PAPER` when paper_mode, else book + event start (user's local time, `ASK USER` for
tz, default America/New_York). Buttons: `rec:{rec_id}:bet` (✅ Bet placed),
`rec:{rec_id}:skip` (❌ Skip), `snooze:{sport}:{market_key}` (😴 1 h).

**Arb:** ONE embed when both legs fit, else two messages, **stale leg always first**:
title `🔀 ARB {profit_pct}% — bet leg 1 first`; leg lines
`1️⃣ 🔥 STALE — {book}: {selection} @ {american} → stake \`{$}\` · [Open ➜](link)` then
`2️⃣ {book}: ...`; final line: `Leg 1 deviates {staleness}σ from consensus; leg 2 matches
{n} books.` Each leg gets its own `rec:{id}:bet_leg1|bet_leg2` button.

### 9.3 Interaction handlers

`rec:{id}:bet` → insert `bets` row (`confirmed_via='button'`, `placed_at=now`,
stake/odds copied from the recommendation; user can edit them later in the UI) → edit embed
footer to `✅ bet logged`. `skip` → footer `❌ skipped`. `snooze` → suppress that
`(sport, market_key)` for 3600 s. Also treat a ✅ **reaction** on the message identically to
the bet button (`confirmed_via='reaction'`).

### 9.4 Deep-link ladder (`deeplink.py`)

`sportsbooks.link_templates_json` structure:

```json
{ "betslip": null,
  "event":   "https://sportsbook.draftkings.com/event/{provider_event_id}",
  "book_home": "https://sportsbook.draftkings.com/" }
```

Assembly: use the highest non-null level whose placeholders can all be filled; record the
chosen level in `StakeLeg.link_level`. **v1 reality:** The Odds API gives no book-native ids,
so `betslip` stays null for every book; templates for `event`/`book_home` must be verified
manually per book (open the book's site, copy a real event URL, generalize it). Do not invent
URL schemas — an unverified template stays null and the ladder falls through to `book_home`.

---

## 10. FastAPI JSON API (consumed by the Angular UI)

All routes under `/api`. Auto-generated OpenAPI at `/api/openapi.json` (feeds §11.3).

| Method & path | Purpose |
|---|---|
| `GET /api/settings` / `PUT /api/settings` | read/patch settings map (validate against §3.2 keys) |
| `GET /api/providers` / `PATCH /api/providers/{key}` | enable/disable, budget, quota status |
| `GET /api/sportsbooks` / `PATCH /api/sportsbooks/{key}` | enable, priority, link templates |
| `GET /api/opportunities?status=&type=&limit=` | opportunity table |
| `GET /api/recommendations?paper=&from=&to=` | history w/ joined opportunity + result |
| `POST /api/recommendations/{id}/confirm` | body `{stake_actual_cents, odds_actual_decimal}` → bets row (`confirmed_via='ui'`) |
| `GET /api/results/summary?group=day\|week` | pnl, hit rate, avg CLV, rec vs executed split |
| `GET /api/bankroll` / `POST /api/bankroll/adjust` | ledger view / manual deposit-withdraw rows |
| `GET /api/matching` / `POST /api/matching/{id}/resolve` | quarantine queue |
| `GET /api/system/health` | scheduler last-run, quota, kill_switch, paper_mode |
| `POST /api/system/kill` / `POST /api/system/resume` | flip kill_switch |

FastAPI serves the built Angular bundle as static files at `/` in production mode.
Summary and bankroll endpoints are thin wrappers over ES aggregations (`date_histogram` +
`sum` on `pnl_cents` / `delta_cents`) — do not recompute those in Python.

---

## 11. Angular `config-ui`

### 11.1 Routes/pages

| Route | Contents |
|---|---|
| `/dashboard` | health card (scheduler, quota, kill switch, paper badge), today's recommendations, bankroll figure, big KILL/RESUME button |
| `/opportunities` | live table (poll `GET /api/opportunities` every 15 s), filters status/type |
| `/recommendations` | history table; row action "confirm bet" dialog → confirm endpoint |
| `/results` | summary tiles (P&L, hit rate, avg CLV) + per-day table; rec-vs-executed toggle |
| `/settings` | reactive form over §3.2 (grouped: Staking, Thresholds, Polling, Safety) |
| `/sportsbooks` | table with enable toggles, priority, link-template editor + "test link" button |
| `/providers` | enable toggles, quota bar (used vs budget) |
| `/matching` | quarantine queue with raw JSON viewer and resolve action |

### 11.2 Conventions

Standalone components, Angular signals for state, no NgRx (overkill). Blue-green theme
consistent with the MetrumDigital palette (accent teal `#2dd4bf`, emerald `#34d399`) in
`libs/ui-kit`. All money rendered from cents; all times rendered in the user's tz.

### 11.3 Generated client

`libs/api-client` is generated from the running engine's `/api/openapi.json` (use
`openapi-ts` or `ng-openapi-gen`; commit the generated code plus an `nx run api-client:generate`
target). UI code imports ONLY from `libs/api-client` — no hand-written `HttpClient` calls.

---

## 12. Grading & CLV Job (`grading.py`, daily 06:00 UTC + on-demand endpoint)

1. Fetch scores (`daysFrom=2`) → update `events` scores/completed.
2. For each ungraded recommendation on a completed event (ungraded = no `edgeline-results`
   doc with its id — check with `mget`), settle each leg from the final score: h2h by winner;
   totals by `home+away` vs line (`push` on exact); spreads by adjusted margin (`push` on
   exact); props gradable from scores API are limited — anything not derivable →
   `outcome='void'`, `pnl_cents=0`, flag `needs_manual` for the UI. Write the result with the
   recommendation id as `_id` so re-running the job is idempotent.
3. `pnl_cents`: win → `stake × (price_decimal − 1)`; loss → `−stake`; push/void → 0.
   Arb recs: sum leg P&L.
4. CLV per §6.8, using `is_closing=1` snapshots (captured by the scheduler's closing-line
   task at `commence_time − closing_capture_offset_s`).
5. Executed recs (those with an `edgeline-bets` doc) also append `edgeline-bankroll-ledger`
   deltas; paper recs never touch the ledger.
6. If today's graded executed losses ≥ `daily_loss_stop_cents` (a filtered `sum` aggregation
   over today's executed `pnl_cents`) → set `kill_switch=true`, send a Discord notice
   `🛑 Daily loss stop hit — alerting paused`.

---

## 13. Scheduler (`scheduler.py`, separate process: `nx run engine:worker`)

APScheduler with asyncio. Jobs:

| Job | Cadence |
|---|---|
| `poll_featured(sport)` | `poll_interval_s` (or `poll_interval_dev_s` while quota_budget ≤ 500) |
| `poll_props(sport)` | `props_poll_interval_s`, only events with `commence_time − now < 6 h` |
| `closing_capture` | one-shot per event at `commence_time − closing_capture_offset_s` |
| `grade` | daily 06:00 UTC |
| `quota_reset` | monthly, day 1: zero `quota_used` |
| `heartbeat` | 60 s: update the `runtime` doc in `edgeline-settings` (read by `/api/system/health`) |

Startup sequence: compute projected monthly credit cost (§8.4) → refuse to schedule if over
budget → log the number → register jobs → start Discord bot in the same loop.

---

## 14. Golden Tests (must pass byte-for-byte on the numbers)

In `test_oddsmath.py`, tolerance `1e-4` unless stated:

| ID | Function | Input | Expected |
|---|---|---|---|
| G1 | conversions | −110, +105, +100, −200, +250 | decimals 1.909091, 2.05, 2.0, 1.5, 3.5; probs 0.523810, 0.487805, 0.5, 0.666667, 0.285714 |
| G2 | devig multiplicative | (−120, +100) | (0.521739, 0.478261) |
| G3 | consensus | A(w2)=0.520 B=0.510 C=0.515 D=0.505 | 0.515 |
| G4 | ev_pct | p=0.545, d=1.909091 | +4.0455 |
| G5 | arb | 2.10 / 1.980392, B=$100, $1 rounding | profit 1.9223%; raw 48.53/51.47; rounded 49/51; worst-case 1.00% → accepted |
| G6 | staleness | 0.476 vs μ 0.511 σ 0.005; 0.505 vs μ 0.512 σ 0.005 | 7.0 and 1.4; leg 1 bet_first |
| G7 | kelly stake | p 0.545, d 1.909091, bankroll 100000¢, frac 0.25 | 1100¢ ($11) after rounding |
| G8 | clv_pct | closing p 0.552, alert d 1.909091 | +5.3818 |

Plus: `test_staking.py` — each guardrail individually (cap hit, exposure remainder, suppression
below min edge, kill switch); `test_dedup.py` — same-hash update, edge-improvement re-alert,
expiry; `test_engine.py` — replay a recorded fixture set doctored to contain exactly one arb
and one +EV; assert both detected with expected edges; `test_normalizer.py` — prop `description`
parsing and one malformed payload → quarantined, not raised.

**ES in tests:** the math tests (G1–G8) are pure functions and must not touch ES. Tests that
need the datastore (`test_engine.py`, `test_dedup.py`, grading tests) run against the local
dev ES using the index prefix `edgeline-test-` — fixtures create the test indices fresh and
delete them on teardown. Mark them `@pytest.mark.es` and auto-skip when `ES_URL` is
unreachable, so the suite still passes on a machine without Docker running.

---

## 15. Phase Checklists (execute strictly in order)

**Phase 0 — Foundations**
- [x] **T0.1 Scaffold — DONE 2026-09-03.** `apps/edgeline-api` in the existing `app-suite` Nx monorepo per §2.1; `nx show project edgeline-api` lists all five targets; `scope:el` added to `eslint.config.mjs`; `.gitignore` covers `.env`, `__pycache__`, `.venv`
- [ ] T0.2 `.env` + `config.py`; `ASK USER` for Odds API key
- [ ] T0.3 `docker compose up -d` Elasticsearch + `ensure_indices()` bootstrap (§4) + settings/sportsbook seeds
- [ ] T0.4 The Odds API adapter + fixture recorder (§8); record ≥ 3 MLB fixture sets
- [ ] T0.5 Normalizer v1 (§7.2) incl. quarantine
- [ ] **Exit:** live MLB featured odds land in `edgeline-odds-snapshots` (visible in Kibana); `pytest` green incl. normalizer tests

**Phase 1 — Math engine**
- [ ] T1.1 `oddsmath.py` — G1–G4, G6, G8 pass
- [ ] T1.2 Arb + rounding re-check — G5 passes
- [ ] T1.3 `staking.py` with guardrail order — G7 + guardrail tests pass
- [ ] T1.4 `engine.py` pipeline + `dedup.py`; fixture-replay integration test passes
- [ ] T1.5 CLI paper mode: `uv run python -m edgeline.engine --once` prints detections
- [ ] **Exit:** all §14 tests green; 7 consecutive days of dev-cadence paper recommendations stored

**Phase 2 — Discord**
- [ ] T2.1 Bot setup (§9.1); `ASK USER` for token/channel
- [ ] T2.2 Embeds + persistent views (§9.2); restart-survival verified manually
- [ ] T2.3 Handlers → `bets` rows (§9.3); ✅ reaction path included
- [ ] T2.4 Cooldowns + edge-improvement re-alerts wired into dispatch
- [ ] T2.5 Line-death instrumentation: on each cycle, record whether previously alerted opportunities still exist (feeds the Android go/no-go)
- [ ] **Exit:** live detection → Discord alert → tap opens book page; button press logs a bet row

**Phase 3 — UI & grading**
- [ ] T3.1 FastAPI routers per §10, OpenAPI complete
- [ ] T3.2 `api-client` generation target; committed
- [ ] T3.3 Pages per §11.1 (dashboard, settings, sportsbooks, opportunities, recommendations first; rest after)
- [ ] T3.4 Grading job + CLV (§12) incl. closing-capture scheduler task
- [ ] T3.5 Bankroll ledger + daily loss stop → kill switch
- [ ] **Exit:** every §3.2 setting editable in UI; nightly grading produces results + CLV; kill switch works from dashboard

**Phase 4 — Production hardening**
- [ ] T4.1 `ASK USER`: approve paid The Odds API tier within $100/mo; set `quota_monthly_budget`
- [ ] T4.2 Production cadences (§8.4) with startup budget check
- [ ] T4.3 Manually verify `event` link templates for every enabled book (§9.4)
- [ ] T4.4 Run ≥ 200 paper recommendations; compute CLV distribution; report to user
- [ ] **Exit / go-live gate:** user reviews CLV report and explicitly sets `paper_mode=false`. The implementer must NEVER flip this flag.

---

## 16. Prohibitions (hard rules)

1. **Never** place, schedule, or simulate placing a real bet against a sportsbook — no
   sportsbook logins, no browser automation against books, no betslip submission.
2. **Never** flip `paper_mode` to false, raise stake caps, or disable guardrails without an
   explicit user instruction in that session.
3. **Never** guess a cross-book selection match or a deep-link URL schema — quarantine/null
   instead.
4. **Never** call the live The Odds API from tests, and never commit `.env`, tokens, or the
   Elasticsearch data volume. Never bind ES to anything other than `127.0.0.1` while
   security is disabled (§4.1).
5. **No scraping** of sportsbooks, X/Twitter, or Rotowire in v1 (future-work only, and only
   via licensed APIs when it happens).
6. **No features whose purpose is to disguise betting patterns** from sportsbooks.
7. Do not add providers, sports, or notification channels not listed here without user
   approval.

---

## 17. Inputs Required from the User (collect once, early)

| Item | Used in |
|---|---|
| The Odds API key | T0.2 |
| Docker Desktop available (or an existing local ES 9.x to point `ES_URL` at) | §4.1, T0.3 |
| Discord bot token + alert channel id | T2.1 |
| Real starting bankroll (per book if known) | §3.2 seed |
| Confirmed Maryland book list to enable | §4 seed |
| Display timezone (default America/New_York) | §9.2, UI |
| Paid-tier approval (≤ $100/mo) when leaving dev cadence | T4.1 |

---

*Spec v1.1 · 2026-07-06, rev 2026-07-08 (Elasticsearch replaces SQLite) · Companion to the
Architecture Plan (2026-07-02). If this spec and the Architecture Plan conflict, this spec
wins for implementation detail; the plan wins for intent and scope.*

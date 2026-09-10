# edgeline-api

The Edgeline engine: odds ingest, +EV/arbitrage detection, staking, and Discord alerting.
FastAPI serves the JSON API; a second process (`worker`) runs the polling, closing-line and
grading jobs.

**The governing document is the Edgeline implementation spec**, at
[`../../docs/edgeline-spec.md`](../../docs/edgeline-spec.md) — in this repo, so it versions with
the code it governs and lands in the same commit. It is normative — the golden test numbers in
§14 and the prohibitions in §16 are not suggestions. The non-negotiable one: **this system
recommends bets and never places them.** The architecture plan
(`../../../artifacts/plans/sports-betting-intel-system-plan.md`) stays a workspace artifact: it
informs the code without versioning against it.

## Toolchain

| Need | Why | State on this machine (2026-09-04) |
| --- | --- | --- |
| Python 3.14 | Fixed decision, spec §1 | ✅ 3.14.7 via `winget install Python.Python.3.14` |
| [uv](https://docs.astral.sh/uv/) | Dependency + interpreter management; every Nx target shells through it | ✅ 0.12.9 via `winget install astral-sh.uv` |
| Docker (working daemon) | Runs the single-node Elasticsearch in `docker-compose.yml` | ✅ Docker Desktop 4.89.0, engine 29.7.2 |
| Elasticsearch 9.x | The datastore (spec §4) | ✅ 9.0.3, cluster green; Kibana available on :5601 |

The toolchain is complete. `uv sync` resolves 50 packages against 3.14.7 with `uv.lock`
committed, and `nx run edgeline-api:es-up` brings up a green Elasticsearch with Kibana.

**Two hard-won notes from getting Docker working on 2026-09-04**, kept because each cost real
time and either could recur on another machine here:

- **Never upgrade Docker Desktop in place from a very old build.** This machine sat at 3.0.0
  (Dec 2020). Every attempt to upgrade logged `Existing installation found: build=50684,
  version=3.0.0`, opened an "Installing Docker Desktop" window, and then sat at *zero CPU*
  indefinitely — surviving elevation, a reboot, and a WSL update. Uninstalling 3.0.0 first and
  installing 4.89.0 clean worked on the first attempt. Every `4294967291` (-5) exit code seen
  along the way was just the cancel from closing that hung window.
- **A small container is not a proxy for the real image.** Engine 20.10.0 denied the `clone3`
  syscall with `EPERM` instead of `ENOSYS`, which killed the ES 9 JVM in `pthread_create`
  (`Error occurred during initialization of VM`) — but `docker run --rm ubuntu:24.04 bash -c "…"`
  ran fine on that same engine, because `bash` forks via plain `clone`. Only Elasticsearch
  itself reproduced it. Docker fixed this in 20.10.10; engine 29.7.2 is far past it.

Nothing about that blocks engine work, and the suite stays honest with no datastore up: the math
is pure functions, the Odds API adapter is tested against recorded fixtures, and
`tests/conftest.py` skips `@pytest.mark.es` tests rather than failing them. Verified both ways on
2026-09-04 — **151 passed** with ES up, **149 passed / 2 skipped** with `ES_URL` pointed at a dead
port.

**Do not use uv's managed Python here.** `uv python install 3.14` downloads the interpreter and
then fails with "Missing expected target directory for Python minor version link", reproducibly,
`--reinstall` included. `pyproject.toml` pins `python-preference = "only-system"` so a plain
`uv sync` uses the winget interpreter and never re-enters that path.

## Bring-up

```bash
uv sync                        # creates .venv, resolves and writes uv.lock
cp .env.example .env           # then fill in ODDS_API_KEY (spec §17)
nx run edgeline-api:es-up      # single-node Elasticsearch + Kibana on 127.0.0.1
nx run edgeline-api:test       # ES-backed tests skip themselves if ES is down
```

`.env` is gitignored, so a **git worktree does not inherit it** — copy it in from the main
checkout before running anything that needs the Odds API key.

Kibana lands on <http://localhost:5601> and is the intended window into every index — there is no
other admin UI, by design.

**A §3.2 default only applies to a datastore that has never been seeded.** §4.4 rule 1 writes the
settings document once at bootstrap and never overwrites it, so changing a default in `config.py`
leaves an existing install on the old value — silently, because both values are valid. That is
how the worker came to refuse to start on 2026-09-09 at 720 credits against a 500 budget: the
code had moved to a 12-hour dev interval when `us2` was added, and the seeded document was still
on 6 hours. Change a setting on a running install through the API, which validates it against
§3.2 and rewrites the document whole:

```bash
curl -X PUT http://127.0.0.1:8000/api/settings -H "Content-Type: application/json" -d "{\"poll_interval_dev_s\": 43200}"
```

`uv run python -m edgeline.scheduler --check-budget` prints what the **stored** settings cost, so
it is the fastest way to tell a stale document from a current one.

## Nx targets

| Target | Command |
| --- | --- |
| `serve` | `uv run uvicorn edgeline.api.main:app --reload --port 8000` |
| `worker` | `uv run python -m edgeline.scheduler` |
| `test` | `uv run pytest` |
| `es-up` / `es-down` | `docker compose up -d` / `down` |

**Stop the worker before running `npm run check`.** The suite and the worker share the one
single-node Elasticsearch on a 1 GB heap, and `_fresh_cluster` in `tests/test_engine.py` already
records what that cluster does under load: "index already exists" on a create that had just
checked, "no such index" mid-test, and a *different* test failing each run. Measured 2026-09-09 —
three `test_engine` failures with the worker up, each passing on its own, and the whole suite green
the moment the worker was stopped. The failures point at ES lifecycle code and look nothing like
the change under test, so this is worth knowing before debugging the wrong thing.

**`worker` polls once at startup, then on the cadence.** An APScheduler interval job first fires a
*full* interval after start — twelve hours at the dev cadence — so without a catch-up job a worker
run in short bursts on a laptop that sleeps would poll on the way to never. `poll_startup` runs a
cycle three seconds in, but only when one is actually due: §8.4's budget pays for the cadence, not
for how often the process is restarted, so it stands down if a poll already landed inside the
current interval.

**`test-py` was renamed to `test` in Phase 0 T0.5**, which is the moment the previous note in
this file reserved for it: the target now has 151 tests behind it rather than a smoke test.
The consequence is deliberate and worth stating plainly — `npm run check` runs
`nx run-many -t lint typecheck test build`, so **`uv` on `PATH` is now a hard requirement of the
workspace green bar**. A shell without it fails `check` for all 13 projects, not just this one.
If that ever bites, the cause is almost always a shell inherited from before uv was installed;
a fresh one has it.

## Layout

```
src/edgeline/
  config.py      ✅ pydantic-settings; .env + the settings document
  es.py          ✅ AsyncElasticsearch factory + ensure_indices()
  indices.py     ✅ index names, mappings, seeds (spec §4.3)
  schemas.py     ✅ pydantic models (spec §5)
  normalizer.py  ✅ provider payloads -> canonical rows (spec §7.2)
  providers/     ✅ odds provider adapters; the_odds_api.py first (spec §8)
  oddsmath.py    ✅ conversions, de-vig, consensus, EV, arb, staleness (spec §6)
  staking.py     ✅ fractional Kelly + guardrails (spec §6.7)
  engine.py      ✅ detection pipeline + the --once CLI (spec §7.1)
  dedup.py       ✅ opportunity hashing + lifecycle (spec §7.4)
  deeplink.py    ✅ per-book link ladder (spec §9.4) — returns no link until T4.3
  notify/        ✅ message.py + sink.py (spec §9.2, channel-agnostic)
                 …a channel adapter is still to come (spec §9.1/§9.3)
  grading.py     ✅ settlement, P&L, CLV, ledger, daily loss stop (spec §12)
  scheduler.py   ✅ polling, closing capture, grading, budget guard (spec §13)
  api/           ✅ FastAPI app + one router per §10 resource group
tests/
  fixtures/      ✅ recorded Odds API responses; tests never call the live API
```

✅ marks what has landed (Phases 0 and 1, plus §7.4's lifecycle and T2.4/T2.5). The rest appears
as its phase does; the tree is the destination, not the current state.

## The API

```bash
nx run edgeline-api:serve      # uvicorn on :8000
```

Every route is under `/api`, and OpenAPI is at `/api/openapi.json` — that document is what §11.3's
generated TypeScript client is built from, so it is the contract, not a by-product. Interactive
docs at `/api/docs`.

Two things worth knowing before using it:

- **`POST /api/recommendations/{id}/confirm` records that a human placed a bet.** It does not
  place one and cannot (§16.1). The stake and odds in the body are the *actual* ones you got,
  which will differ from what was recommended — that difference is why §10 asks for them.
  Recording a bet is what promotes a recommendation from paper to executed, which is what lets
  grading move the bankroll ledger.
- **`PUT /api/settings` rejects unknown keys** rather than storing them. The settings index is
  `dynamic: false`, so a typo would be saved, ignored by every reader, and look like it worked.

When a UI bundle has been built, it is served at `/`; set `EDGELINE_UI_DIST` to point elsewhere.

### The generated client

`libs/edgeline/api-client` (`@metrum/edgeline-api-client`) is emitted from `openapi.json`, and
§11.3 is strict about the consequence: **UI code imports only from it — no hand-written
`HttpClient` calls.** After changing a route:

```bash
cd apps/edgeline-api && uv run python -m edgeline.api.openapi
npx nx run edgeline-api-client:generate-client
```

Both artefacts are committed and both are checked by `npm run check` — a pytest compares
`openapi.json` against the live app, and the lib's `test` target compares the emitted client
against `openapi.json`. A stale client cannot reach a commit.

Every route carries an explicit `operation_id` because the emitter refuses to invent names: the
`operationId` *is* the client's method name, so `getSettings` is chosen rather than derived from
a function name and a path.

## The worker

```bash
nx run edgeline-api:worker                        # the long-running process (§13)
uv run python -m edgeline.scheduler --check-budget # what it would cost, without starting
```

Runs §13's jobs: featured polling per sport, a closing-line sweep, nightly grading at 06:00 UTC,
a monthly quota reset, and a heartbeat onto the `runtime` settings document.

**It refuses to start if the cadence would blow the credit budget**, and that refusal is the
point rather than a nicety. §8.4's production cadence costs ~64,800 credits a month against a
free tier of 500 — a worker started on the wrong interval exhausts the month in about four hours
and takes the system dark silently. `--check-budget` prints the §8.4 arithmetic and exits, so the
number can be seen before anything runs. The dev cadence (every 6 h, ~360/month) is selected
automatically while `quota_monthly_budget` is still the free tier's 500; raising it is T4.1 and
needs the paid tier approved.

## Alerting: the channel is not decided yet

Spec §1 names Discord, and §9.1 needs a bot token that does not exist. Rather than block, the
dispatch layer is **channel-agnostic**: `notify/message.py` renders §9.2's exact formats into an
`AlertMessage` (title, lines, footer, colour, buttons carrying §9.3's `custom_id`s), and
`notify/sink.py` defines `AlertSink` — a one-method protocol that is the only seam a channel
plugs into. `run_once(..., sink=...)` takes it.

`LogSink` is the default and writes fully rendered alerts to the log, so the seven days of paper
recommendations Phase 1's exit wants accumulate now rather than waiting on a token. Whichever
channel lands is one adapter over `AlertMessage`, not a rewrite. Changing the spec's named
channel needs the user's approval (§16.7).

**Decided 2026-09-08: stay on `LogSink` for now; Discord is the intended channel when logs stop
being enough.** While the system runs in short attended bursts, reading the log *is* the alert —
a push channel earns its keep only once nobody is watching the terminal. Discord is the fallback
of choice because it is what §1 and §9 already name, it has an official API with real buttons,
and it carries no maintenance treadmill. No spec change is needed to act on that; it is what §9
already says.

**Where the options stand (2026-09-08):**

| Option | Setup | Confirm tap | Notes |
| --- | --- | --- | --- |
| **Discord** (spec's choice) | Developer portal → app → bot → invite → token, ~10 min | Buttons, official | Holds a gateway websocket |
| ~~Telegram~~ | — | — | **Ruled out by the user, 2026-09-08** |
| **ntfy** | Pick a topic, no account | Weak — the button calls a URL, so it only works where the phone can reach this machine | Plainest formatting |
| **Signal** | Phone number + possible CAPTCHA, or link as a second device | Unconfirmed; would be the ✅ reaction path §9.3 already allows | See below |
| **Leave it** | Nothing | None | `LogSink`; alerts land in the log |

**On Signal specifically.** There is no official bot API — it would go through
[`signal-cli`](https://github.com/AsamK/signal-cli), which is community-maintained, unofficial,
and has a JSON-RPC daemon mode that would suit a worker. The disqualifying detail for unattended
use is in its own README: it *"needs to be kept up-to-date"* because **official Signal clients
expire after three months**. An alerting system that silently stops every quarter unless someone
updates it is a poor fit for the one job it has. Its real argument is privacy — Discord bot
messages are not end-to-end encrypted, and these alerts say what is being bet and how the
bankroll is doing.

## Running a cycle

```bash
uv run python -m edgeline.engine --once
```

Fetches one poll cycle, normalizes it, stores snapshots and events, runs +EV and arbitrage
detection, and prints what it found. It spends ~3 API credits and **never places a bet** (§16.1).

**Zero detections was the expected output for a while, and the reason was structural rather than
a quiet market.** Measured 2026-09-09 against a live `baseball_mlb` feed with §4.3's eight
Maryland books enabled: 784 snapshots, 15 events, **0 detections**.

The cause was a mismatch between who The Odds API returns and who you can bet with:

| `regions` | books returned | of which MD-legal | credits |
| --- | --- | --- | --- |
| `us` | 9 | **4** — draftkings, fanduel, betmgm, betrivers | ×1 |
| `us,us2` | 14 | **5** — adds espnbet | ×2 |

`bet365`, `fanatics` and `williamhill_us` (Caesars) appear in **neither** region for MLB, so the
seed list overstates real coverage by three books.

That collides with `min_books_for_consensus = 4`, which §6.4 measures against the *other* books:
with 4 MD books each one sees only 3 others, so **no selection is ever priced** and the gate can
never open. Replaying the committed fixture proves it — 724 selections priced across all 9 books,
**0** across the MD 4.

Three ways out, all of them the user's call under §16.2 — do not just lower a threshold:

1. **Add `us2`** (5 MD books, consensus becomes exactly satisfiable). Doubles regions, so §8.4's
   projection goes 360 → **720 credits/month against a 500 budget**, and the worker's budget
   guard will refuse to start. Pair it with a 12-hour dev interval and it lands back at 360.
2. **Lower `min_books_for_consensus` to 3**, which works on the current feed at no extra cost —
   but a fair value from three books is a weaker estimate, so expect more false edges.
3. Accept that MLB featured markets will not produce +EV at these settings.

**Resolved by (1), and by two books that came with it.** `us2` also surfaced `betparx` and
`ballybet`, both confirmed Maryland-legal by the user on 2026-09-09 and now seeded — which takes
the books actually present in an MLB response from five to **seven**, clear of the threshold
rather than exactly on it. The first cycle at that coverage produced **14 detections and 2
recommendations**, the first time the system found anything.

Not every book in the feed made it. `hardrockbet` is confirmed **not** MD-legal (user, same day);
`fliff` is a sweepstakes product, not a licensed sportsbook; and `bovada`, `lowvig`, `mybookieag`,
`betonlineag`, `betus` are offshore. §6.4/§6.5 filter all of them out, and `EXCLUDED_BOOKS` in
`indices.py` records the first two with their reason so the question is not re-asked.

Arbitrage is separate and genuinely rare rather than blocked: it needs only 2 books, and the
tightest market in the recorded fixture had an inverse sum of 1.000400 — the books keeping
0.04% of vig, four hundredths of a percent from being an arb.

## Fixtures

`tests/fixtures/` holds **real** The Odds API v4 responses for `baseball_mlb`, recorded
2026-09-04: featured odds (16 events × 9 books × h2h/spreads/totals), the event list, one event's
player props, and scores. Tests match them by glob and take the newest, so re-recording refreshes
what the suite replays without editing a test.

To re-record, set the debug flag and drive the adapter — it writes
`{sport}_{endpoint}_{timestamp}.json` (spec §8):

```bash
EDGELINE_RECORD_FIXTURES=1 uv run python -c "import asyncio; from edgeline.providers.the_odds_api import TheOddsApiProvider as P; asyncio.run(P().fetch_odds('baseball_mlb', ['h2h','spreads','totals']))"
```

That spends real credits (the featured call is ~3 of the free tier's 500/month) and is the **only**
thing here that may touch the live API. Tests never do — spec §16 rule 4. The recorder writes
response bodies only; the API key travels as a query parameter and must never reach a committed
file.

## The UI

`edgeline-ui` (Angular, spec §11) was scaffolded in commit bbd1125 and now has §11.1's eight
pages (T3.3). **`apps/edgeline-ui/README.md` is the one to read** for how to run it and how it
reaches this API — the short version is that the dev server proxies `/api` to `:8000`, so this
app needs no CORS middleware and the UI's base URL is the same empty string in dev and in
production, where §10 has FastAPI serve the bundle at `/`.

Getting it in took a bypass worth knowing about. `nx g @nx/angular:application` refuses in this
workspace: the generator asserts against Nx's TS solution setup, which is exactly what this
monorepo uses (a root `tsconfig.json` of project references over `tsconfig.base.json`, plus npm
workspaces). `ledgerline-ui` only exists because it predates that assertion. So the app was
generated with `NX_IGNORE_UNSUPPORTED_TS_SETUP=true` and then reconciled against `ledgerline-ui`,
which is the proven shape here. Four things the generator got wrong for this workspace, all
fixed in that commit:

1. Its `tsconfig.json` inherited the base config's `emitDeclarationOnly` (Angular rejects it,
   NG4006), a Node-only `lib` with no `dom`, and the `@metrum/source` condition that resolves
   workspace deps to `src/index.ts`.
2. It emitted a `lint` target on the deprecated `@nx/eslint:lint` executor instead of relying on
   the inferred `@nx/eslint/plugin`.
3. It never added the project to the root `tsconfig.json` references.
4. It never wrote the `package.json` that npm workspaces expects.

Do the same reconciliation if you ever regenerate it.

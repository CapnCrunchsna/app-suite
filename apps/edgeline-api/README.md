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

## Nx targets

| Target | Command |
| --- | --- |
| `serve` | `uv run uvicorn edgeline.api.main:app --reload --port 8000` |
| `worker` | `uv run python -m edgeline.scheduler` |
| `test` | `uv run pytest` |
| `es-up` / `es-down` | `docker compose up -d` / `down` |

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
  oddsmath.py    conversions, de-vig, consensus, EV, arb, staleness (spec §6)
  staking.py     fractional Kelly + guardrails (spec §6.7)
  engine.py      detection pipeline (spec §7.1)
  dedup.py       opportunity hashing + lifecycle (spec §7.4)
  deeplink.py    per-book link ladder (spec §9.4)
  notify/        Discord bot, embeds, interaction handlers (spec §9)
  grading.py     results + CLV (spec §12)
  scheduler.py   polling and job cadences (spec §13)
  api/           FastAPI app and routers (spec §10)
tests/
  fixtures/      ✅ recorded Odds API responses; tests never call the live API
```

✅ marks what has landed (Phase 0). The rest appears as its phase does; the tree is the
destination, not the current state.

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

`edgeline-ui` (Angular, spec §11) **is scaffolded** as of commit bbd1125 — an app shell that
lints, typechecks, tests and builds. Its pages are Phase 3 work.

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

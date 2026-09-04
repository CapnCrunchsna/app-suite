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

| Need | Why | State on this machine (2026-09-03) |
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

Nothing about that blocks engine work. The math is pure functions, the Odds API adapter is
tested against recorded fixtures, and `tests/conftest.py` skips `@pytest.mark.es` tests rather
than failing them — so the suite stays honest with no datastore up.

**Do not use uv's managed Python here.** `uv python install 3.14` downloads the interpreter and
then fails with "Missing expected target directory for Python minor version link", reproducibly,
`--reinstall` included. `pyproject.toml` pins `python-preference = "only-system"` so a plain
`uv sync` uses the winget interpreter and never re-enters that path.

## Bring-up

```bash
uv sync                        # creates .venv, resolves and writes uv.lock
cp .env.example .env           # then fill in ODDS_API_KEY (spec §17)
nx run edgeline-api:es-up      # single-node Elasticsearch + Kibana on 127.0.0.1
nx run edgeline-api:test-py    # ES-backed tests skip themselves if ES is down
```

Kibana lands on <http://localhost:5601> and is the intended window into every index — there is no
other admin UI, by design.

## Nx targets

| Target | Command |
| --- | --- |
| `serve` | `uv run uvicorn edgeline.api.main:app --reload --port 8000` |
| `worker` | `uv run python -m edgeline.scheduler` |
| `test-py` | `uv run pytest` |
| `es-up` / `es-down` | `docker compose up -d` / `down` |

**Why `test-py` and not `test`:** `npm run check` runs `nx run-many -t lint typecheck test build`
across the whole monorepo, and this target shells through `uv`. The original reason — uv was not
installed — **no longer applies**: uv is installed and `uv run pytest` passes (1 passed,
1 skipped). The rename is deliberately left to the first session that adds real tests, so it
lands with coverage behind it rather than against a smoke test, and so `uv` being on `PATH`
becomes a hard requirement of `npm run check` at a moment someone is watching.

## Layout

```
src/edgeline/
  config.py      pydantic-settings; .env + the settings document
  es.py          AsyncElasticsearch factory + ensure_indices()
  indices.py     index names, mappings, seeds (spec §4.3)
  schemas.py     pydantic models (spec §5)
  oddsmath.py    conversions, de-vig, consensus, EV, arb, staleness (spec §6)
  staking.py     fractional Kelly + guardrails (spec §6.7)
  providers/     odds provider adapters; the_odds_api.py first (spec §8)
  normalizer.py  provider payloads -> canonical rows (spec §7.2)
  engine.py      detection pipeline (spec §7.1)
  dedup.py       opportunity hashing + lifecycle (spec §7.4)
  deeplink.py    per-book link ladder (spec §9.4)
  notify/        Discord bot, embeds, interaction handlers (spec §9)
  grading.py     results + CLV (spec §12)
  scheduler.py   polling and job cadences (spec §13)
  api/           FastAPI app and routers (spec §10)
tests/
  fixtures/      recorded Odds API responses; tests never call the live API
```

Modules appear as their phase lands; the tree above is the destination, not the current state.

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

# edgeline-api

The Edgeline engine: odds ingest, +EV/arbitrage detection, staking, and Discord alerting.
FastAPI serves the JSON API; a second process (`worker`) runs the polling, closing-line and
grading jobs.

**The governing document is the Edgeline implementation spec**, today at
`../../../artifacts/plans/sports-betting-implementation-spec.md` in the workspace repo. It is
normative — the golden test numbers in §14 and the prohibitions in §16 are not suggestions. The
non-negotiable one: **this system recommends bets and never places them.**

> **Placement follow-up.** By `../../docs/README.md`'s own rule that is the wrong home: an
> implementation spec must version atomically with the code it governs, so it belongs at
> `app-suite/docs/edgeline-spec.md`. It has not been moved because it is a **registered**
> dashboard artifact and `scripts/new-artifact.mjs` registers by HTML path with no way to
> unregister the old one — a move would leave a duplicate card pointing at a deleted file.
> Doing it properly means teaching that script to retire an entry first. The architecture plan
> (`artifacts/plans/sports-betting-intel-system-plan.md`) stays an artifact either way.

## Toolchain

| Need | Why | State on this machine (2026-09-03) |
| --- | --- | --- |
| Python 3.14 | Fixed decision, spec §1 | ✅ 3.14.7 via `winget install Python.Python.3.14` |
| [uv](https://docs.astral.sh/uv/) | Dependency + interpreter management; every Nx target shells through it | ✅ 0.12.9 via `winget install astral-sh.uv` |
| Docker (working daemon) | Runs the single-node Elasticsearch in `docker-compose.yml` | ❌ client is 20.10.0 (2020) and `docker info` panics |
| Elasticsearch 9.x | The datastore (spec §4) | ❌ nothing answers on `localhost:9200` |

The Python half is done: `uv sync` resolves 50 packages against 3.14.7 and `uv.lock` is
committed. The datastore half is not, and that is a decision still to make — upgrade Docker
Desktop (needs WSL2), run Elasticsearch from its native Windows zip (it bundles a JDK, no
Docker required), or stand it up on the home server the workspace has been planning.

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

`edgeline-ui` (Angular, spec §11) is **not scaffolded yet** and is not needed before Phase 3.
`nx g @nx/angular:application` refuses in this workspace: the Angular generator does not support
the TypeScript project-references setup the monorepo uses ("The Angular framework doesn't support
a TypeScript setup with project references"). Two ways through when Phase 3 starts, neither
attempted yet:

1. Re-run the generator with `NX_IGNORE_UNSUPPORTED_TS_SETUP=true`, then reconcile the generated
   tsconfigs with the workspace's project-references layout.
2. Mirror `apps/ledgerline-ui/` by hand — it is a working Angular 22 app in this exact workspace,
   so its `project.json` and tsconfigs are proof of a shape that builds here.

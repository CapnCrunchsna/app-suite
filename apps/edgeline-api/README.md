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
| Python 3.14 | Fixed decision, spec §1 | ❌ newest present is 3.9.6 (`py -3`) |
| [uv](https://docs.astral.sh/uv/) | Dependency + interpreter management; every Nx target shells through it | ❌ not installed |
| Docker (working daemon) | Runs the single-node Elasticsearch in `docker-compose.yml` | ❌ client is 20.10.0 (2020) and `docker info` panics |
| Elasticsearch 9.x | The datastore (spec §4) | ❌ nothing answers on `localhost:9200` |

Nothing here blocks writing or unit-testing engine code — the math is pure functions and the
Odds API adapter is tested against recorded fixtures. It blocks only the steps that need a live
datastore, which is exactly why `tests/conftest.py` skips `@pytest.mark.es` tests instead of
failing them.

`uv` is the one that unblocks the most: it installs and pins CPython 3.14 itself
(`uv python install 3.14`), so it removes two rows from that table at once.

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
across the whole monorepo. Until `uv` exists on this machine, a target named `test` here would
turn the workspace-wide green bar red for a missing toolchain rather than for a real defect.
Rename it to `test` once `uv` is installed and the suite passes — that is a deliberate one-line
follow-up, not an oversight.

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

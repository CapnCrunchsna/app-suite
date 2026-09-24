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

**A key the stored document does not carry at all is the exception** — it reads as its default.
That is how `poll_schedule` (2026-09-23) reaches an install seeded before it existed: the worker
runs the default weekly plan from its first start on the new code. Write it once through the API
anyway, so the plan is in the document rather than in the code and a later change to the default
cannot move it silently. An **empty patch** does exactly that — it changes nothing, and the route
stores the merged document whole, filling in every key the document lacked:

```bash
curl -X PUT http://127.0.0.1:8000/api/settings -H "Content-Type: application/json" -d "{}"
curl http://127.0.0.1:8000/api/settings
```

The second command should show `poll_schedule` with the plan's seven rows. Edit it from
Settings → Polling afterwards, not by hand.

## Nx targets

| Target | Command |
| --- | --- |
| `serve` | `uv run uvicorn edgeline.api.main:app --port 8000` |
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

**A second `pytest` run does the same thing, and more directly — check for one before blaming
the worker.** `TEST_INDEX_PREFIX` in `tests/conftest.py` is a module constant with no env
override, so two runs against this machine's one Elasticsearch are creating and deleting the
*same* index names, not merely competing for heap. A worktree and the main checkout collide
exactly this way. Measured 2026-09-09 with **no worker running at all**: two `pytest.exe`
processes from the main checkout, `resource_already_exists_exception` on one run and
`index_not_found_exception` on the next, and 383 passed the moment they finished. Anyone who
reads only the paragraph above will stop a worker that is not running and still be red.

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ForEach-Object { '{0} :: {1}' -f $_.ProcessId, $_.CommandLine }"
```

Wait for it rather than killing it — it is usually another session's verification run, and the
suite is ninety seconds. `tests/test_api.py` already uses its own prefix and never
participates; giving the rest of the suite an env-overridable prefix would retire this whole
class and has not been done.

## Credits, and what actually spends them

Written down because three separate wrong guesses were made about this in one
session, each of which cost real credits or real time.

| Endpoint | Cost | Who calls it |
| --- | --- | --- |
| `/v4/sports` | **0** — free, and `x-requests-last: 0` confirms it | diagnostics only |
| `/v4/sports/{sport}/events` | **0** — every listed game with its start time | diagnostics only |
| `/v4/sports/{sport}/odds` | **markets × regions** (6 at current settings); **0 when the answer is empty** | `run_once`, `capture_closing_lines` |
| `/v4/sports/{sport}/scores?daysFrom=` | **2** | `grading.grade` |

**An empty `/odds` answer is free** (measured 2026-09-23: `baseball_mlb_preseason`, inactive,
returned `[]` with `x-requests-last: 0`). So a weekly-plan slot for a sport out of season costs
nothing — the NBA slots until its 2026-10-20 opener, or MLB slots left in after the World Series.
Careful what "empty" means: `basketball_wnba` had no games *upcoming* but three in play, returned
them, and cost 1.

Two consequences that are not obvious from §8.4:

- **The §13 budget guard counts only the featured poll.** `plan_budget` projects
  `(86400/interval) × markets × regions × 30`, or on the weekly plan
  `polls a week × markets × regions × 30/7`, and knows nothing about the closing
  sweep or grading. It reported a comfortable 360/500 while the real spend was
  about 6 credits a minute. Treat its number as a floor, not a bill.
- **Grading costs 2 credits a sport, but only when there is a bet to settle.** Until
  2026-09-23 every run fetched scores for every enabled sport — including the catch-up
  grade 15 seconds after each worker start — whatever there was to grade. With the
  weekly plan's four sports that would have been ~240 credits a month, so `_grade`
  now asks the datastore which sports have a recommendation on a started game with no
  result (`sports_awaiting_settlement`, free) and fetches scores for those alone.

**The enforcement is a pace guard, not the projection.** `_check_pace` in the adapter refuses a
request locally — nothing sent — when `x-requests-used` is past `quota_monthly_budget`, or past
`elapsed_month_fraction + 15%` of it. It compares two facts and models nothing, so it catches a
job nobody modelled, a second worker, or someone looping `--once`. On the failure that prompted
it — 80% of the budget gone with 30% of the month elapsed — it trips within the first hour. Free
endpoints are never refused, and the worker arms the guard at startup with a free `/sports` call
so its first *paid* request is already covered.

`uv run python -m edgeline.scheduler --check-budget` prints the projection.
Actual remaining credits only come from a response header — the dashboard at
<https://dash.the-odds-api.com/> is where the balance and the monthly reset date
live.

## Working with no credits

Set `offline_mode` (§3.2, in the UI under Safety, or by API):

```bash
curl -X PUT http://127.0.0.1:8000/api/settings -H "Content-Type: application/json" -d "{\"offline_mode\": true}"
```

No job makes a provider request; the worker, API, UI, grading and the §7.4
lifecycle all keep running on stored data. `--check-budget` reports 0, so any
cadence starts. Nothing new is ingested, including closing lines, which cannot be
recovered afterwards.

It is enforced at each seam that reaches the provider rather than by not
registering jobs, so an offline job still appears in the logs saying what it
declined to do. **The seams are not enumerated anywhere on purpose** —
`test_no_scheduled_job_touches_the_provider_while_offline` drives every
registered job against a recording provider and asserts it was never touched,
because enumerating them by hand is exactly what missed `grading.grade` the first
time.

**`worker` polls once at startup, then on the cadence.** An APScheduler interval job first fires a
*full* interval after start — twelve hours at the dev cadence — so without a catch-up job a worker
run in short bursts on a laptop that sleeps would poll on the way to never. `poll_startup` runs a
cycle three seconds in, but only when one is actually due: §8.4's budget pays for the cadence, not
for how often the process is restarted, so it stands down if a poll already landed inside the
current interval. On the weekly plan (below) it runs only a slot that came due in the last ninety
minutes — the grace a slot gets for a sleep, extended to a restart — so starting the worker at
14:00 buys nothing, and starting it at 17:45 on a Tuesday still buys the 17:30 slate.

**A slot that landed inside a sleep used to be dropped rather than delayed, and the worker looked
perfectly healthy while it happened (2026-09-15).** APScheduler's default `misfire_grace_time` is
*one second*: a run that fires later than that is discarded with a warning and rescheduled a full
interval away. This laptop sleeps for hours at a time — measured that day, 03:36–19:35 UTC — so the
14:01 poll slot fell inside the sleep and the worker then sat up for **21 hours on a 12-hour cadence
without polling once**. Nothing in `/health` said so, because the heartbeat is a separate 60-second
job whose missed beat is replaced a minute later: the stamp stayed fresh while the job that fetches
odds never ran. The nightly 06:00 UTC grade is inside a sleep most nights for the same reason, and a
`quota_reset` skipped for lateness is skipped for a *month*, after which the pace guard refuses every
paid request against last month's spend. Those four jobs now pass `misfire_grace_time=None`
(`RUN_WHEN_LATE`), so a missed slot runs on wake, with `coalesce=True` so a long sleep costs one
cycle rather than one per slot. The heartbeat deliberately keeps the default — it stamps *now*, not
its slot, so a late beat says nothing the next one won't.

**A cycle that fires on wake fires into a network that is not up yet, and used to lose the day for
it (2026-09-17).** The catch-up poll ran seconds after a resume and got `[Errno 11001] getaddrinfo
failed` from DNS — not a provider outage, just a lookup a minute too early. `_poll` logged the
traceback and APScheduler's next attempt was **ten hours away**, which on a 12-hour cadence is the
whole day's second cycle gone. `_poll` and `_grade` now book a one-shot retry at 60 s, 300 s and
900 s before giving up, and a retry whose own slot lands inside another sleep still runs on wake.
A pace-guard refusal is never retried: nothing was sent, and the guard will not answer differently
in a minute — it gets one warning line now instead of a traceback.

**The same sleep breaks whatever Elasticsearch request is in flight**, because the cluster is in a
container: a 21-second suspend timed out the heartbeat and the settings read beside it, ten seconds
apart, on a cluster that was up the whole time. The client now sets `retry_on_timeout`, and
`load_settings` treats **only** a `NotFoundError` as "not seeded" — anything else raises. It used to
answer §3.2 defaults for any exception, which is worse than an error: `kill_switch` and
`offline_mode` both default to off, so a blocked read could quietly resume a system someone had
paused, and it logged "no seeded settings" against a datastore that was fully seeded.

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
  deeplink.py    ✅ per-book link ladder (spec §9.4) — still returns no link; the
                 …rung that can be filled is `league`, and only a person can fill it
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
- **`POST /api/system/poll` runs one cycle now** — §8.4's manual trigger, added 2026-09-16, and
  the dashboard's "Poll now" button calls it. It exists because no cadence knows about the news
  that makes a cycle worth buying *now*, and §7.4 refuses an event that has already started. On
  the weekly plan it buys **today's sports in the plan** (Eastern calendar) — a Tuesday press
  buys NHL and NBA — and `sports_enabled` on a day the plan has nothing; the button names the
  leagues and prices them from `GET /api/system/health`'s `poll_plan`. It spends `markets ×
  regions` credits per sport through the usual pace guard, stamps `last_poll_at` and the
  per-sport stamps like any poll (a manual cycle *is* a poll, or `poll_is_due` pays for another
  at the next restart), answers 409 while one is already running, and 409 with the guard's own
  message when the guard refuses. The API process makes the provider request, so **the API has
  to be restarted to pick up a change here** — the button is in the UI bundle, the route is in
  the server.
- **A manual poll stands in for the next scheduled one of the same sport.** On the weekly plan, a
  slot stands down when a poll from outside the plan — this button, `engine --once` — bought its
  sport in the last three hours (§13, 2026-09-23). On the interval, `poll_realign` (added
  2026-09-16) moves each `poll_featured` job to one interval past `last_poll_at` instead.
  `engine --once` is seen by both since 2026-09-23; before that it stamped nothing, whatever this
  file said. **Both live in the worker**, so the worker needs restarting to get them.

When a UI bundle has been built, it is served at `/`; set `EDGELINE_UI_DIST` to point elsewhere.
So the whole app is two commands:

```bash
npx nx build edgeline-ui       # writes dist/apps/edgeline-ui/browser
npx nx run edgeline-api:serve  # serves the API and that bundle on :8000
```

**That path had never actually worked, and it failed three times over — each one
invisible in the server log (2026-09-12).** Worth knowing before debugging the Angular app,
which is where all three symptoms point:

1. **Wrong bundle path.** `DEFAULT_UI_BUNDLE` was app-relative
   (`apps/edgeline-ui/dist/...`) while Nx's `outputPath` is workspace-relative
   (`dist/apps/edgeline-ui`). `_mount_ui` checks `is_dir()`, finds nothing, logs at INFO and
   returns — so the API is healthy, `/api/*` answers, and every UI route is a 404.
2. **`StaticFiles(html=True)` is not an SPA fallback.** It serves `index.html` for a
   *directory* request and 404s everything else, so `/` worked and `/sportsbooks` did not.
   There is now an explicit fallback, which excludes `/api/*` so a mistyped API path stays a
   JSON 404 rather than becoming a page of HTML.
3. **`.js` is `text/plain` on this machine.** `mimetypes` seeds from the Windows registry,
   Starlette asks `mimetypes`, and a browser refuses an ES module served as text/plain. The
   page renders blank with a 200 in the network tab. `.css` is correct in the same registry,
   so the styles load and only the app is missing — which reads like an Angular bootstrap
   error. The types are now registered explicitly at mount time.

`tests/test_ui_bundle.py` pins all three, and needs no cluster.

**`serve` had `--reload` and it does not work on Windows — it kills the server (2026-09-13).**
Not "reloads unreliably": the watcher fires, tries to restart through the npm/batch wrapper,
and the wrapper asks `Terminate batch job (Y/N)?` of a console nobody is typing into. The
process then exits. What you see is an app that was fine a minute ago and is now refusing
connections, with the last log line a cheerful `WatchFiles detected changes … Reloading…`.
Editing any file under `src/edgeline/` did it, including files the API never imports — the
watcher covers the tree, not the import graph, so touching `scheduler.py` took down the API.

The flag is gone. Reload was never delivering anything on this platform, and this is the
process left running for weeks while paper recommendations accumulate. Restart by hand after
a change; `nx run edgeline-api:serve` is one command.

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
number can be seen before anything runs. The dev cadence is selected automatically while
`quota_monthly_budget` is still the free tier's 500; raising it is T4.1 and needs the paid tier
approved.

### The weekly poll plan (2026-09-23)

On the free tier the featured cadence is `poll_schedule` (§3.2): fixed **Eastern** times per sport
and weekday, one cron job each (`poll_scheduled:<day>:<HHMM>:<sport>`), replacing the 12-hour
interval that landed its two polls wherever the worker last started. The default, placed from
data in §8.4 — each poll about ninety minutes before its sport's first big window of starts:

| Day | Polls (ET) |
| --- | --- |
| Sun | NFL 11:30, NFL 15:00 |
| Mon | NBA 17:30, NFL 18:45 |
| Tue, Wed, Fri | NHL 17:30, NBA 17:30 |
| Thu | NHL 17:30, NFL 18:45 |
| Sat | NCAAF 10:30, NCAAF 17:30 |

14 polls a week at 6 credits is **360 credits a month**, what the interval cost, and
`--check-budget` prints it:

```
poll plan          14 polls/week at fixed America/New_York times
sports             4 (basketball_nba, americanfootball_nfl, icehockey_nhl, americanfootball_ncaaf)
markets x regions  3 x 2
projected credits  360/month
budget             500
verdict            OK
```

What to know before changing it:

- **It is a setting, and seasons are edits.** Settings → Polling edits it as rows and prices the
  result against the budget as you type. MLB is not in the default because its regular season
  ends 2026-09-27; its postseason is one row. An edit takes effect **when the worker restarts**.
- **Empty restores the interval** (`poll_interval_dev_s`, over `sports_enabled`); a budget above
  the free tier's selects the production interval and ignores the plan.
- **A slot runs up to ninety minutes late and no later.** A sleep across 17:30 still buys the
  slot on a 18:45 wake; a wake at 23:00 does not, because the games it was placed for have
  started. The Monday/Thursday 18:45 NFL slot, ninety minutes before its one kickoff, is why the
  ceiling is not two hours.
- **The button stands in for a slot, the plan never does.** A slot stands down when its sport was
  polled from outside the plan in the last three hours, or was already polled since the slot came
  due. Every poll stamps `last_poll_at_by_sport` and `last_poll_source_by_sport` on the runtime
  document for this.
- **The heartbeat stamps `next_poll_at` / `next_poll_sports`** from the jobs the running worker
  registered, and the dashboard shows it while the heartbeat is fresh — the stored plan and the
  running one differ until a restart, and this is the one that will actually fire.
- **Grading and the closing sweep follow along.** The sweep covers `sports_enabled` plus the
  plan's sports; grading covers whatever has a bet to settle.

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
rather than exactly on it.

**The detections that followed were not real, and this section said they were.** The first cycle
at that coverage produced 14 detections and 2 recommendations, recorded here and in `d1b411e` as
the first time the system found anything. It was not: **every one of the 27 opportunities ever
stored was detected after its event had already started**, by 8 to 158 minutes (measured
2026-09-11). They were dead pre-game lines books had not taken down — betPARX showing 7.5 on the
Marlins 3h40m after first pitch, against a market of 1.80. `detect_opportunities` now refuses an
event that has started, so the count above is the honest one: **this system has not yet detected
a real edge.** It has not had the chance — no cycle has run against a live pre-game market with
the current book coverage.

**Those five settled results are now excluded from every figure, and say so (2026-09-23).**
They were still most of the Results page — −$39.03 and a 33% hit rate over a real record of one
win — and that is the page the go-live report is read from. `python -m edgeline.audit` lists
results whose bet was detected after first pitch; `--apply` marks them `excluded_reason:
detected_after_start`. It decides from the data (opportunity `detected_at` against the event's
`commence_time`), never from a list of ids, and it marks rather than deletes: the rows stay, the
summary leaves them out, and `totals.excluded` lets the page say how many were set aside.

**It has now, and the first one won (2026-09-18).** A catch-up poll fired **70 seconds after the
laptop woke** — precisely the cycle the pre-2026-09-15 scheduler dropped — and priced Minnesota
Twins -1.5 at 2.63 across betrivers, ballybet and betPARX, **4h10m before first pitch**: +EV
2.39% against a de-vigged fair value of 0.363. §7.4's cooldown picked one book of the three,
staking put $4.00 on it at quarter-Kelly with no guardrail triggered, and §9.4's ladder produced
an `event`-level deep link rather than a bare homepage. It settled a **win** on 2026-09-20,
+$6.52, at **CLV +2.71%** — `derived`, measured against a price 4.2 hours old, because
`closing_capture_mode` is `off`; §12.4 is why that provenance travels with the figure rather than
being averaged into it. One bet is not evidence of an edge. What it is evidence of is that the
whole path — poll, normalize, de-vig, detect, stake, link, alert, settle, CLV — works end to end
against a live pre-game market.

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

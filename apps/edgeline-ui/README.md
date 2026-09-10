# edgeline-ui

Spec §11's `config-ui`: the Angular app that configures and monitors the Edgeline engine.
It **recommends bets and never places them** (§16.1) — that is an architectural boundary,
not a phase-1 limitation, and nothing in this app has a path to a sportsbook.

The app shell was scaffolded in Phase 0 (`apps/edgeline-api/README.md` records the
generator bypass it needed, which any regeneration will need again). §11.1's eight pages
landed in T3.3.

## Running it

Two processes. The API first:

```bash
npx nx run edgeline-api:serve
```

That needs Elasticsearch — `docker compose -f apps/edgeline-api/docker-compose.yml up -d`.
The API starts without it and reports the failure through `/api/system/health` rather than
refusing to boot, which the UI renders as "the engine is not answering".

Then the UI:

```bash
npx nx run edgeline-ui:serve
```

It comes up on **4201**, not 4200 — `.claude/launch.json` fixes that so it can run beside
`ledgerline-ui`, which takes 4200.

## How the UI reaches the API, and why it is a proxy

`proxy.conf.json` sends `/api` from the dev server to `http://127.0.0.1:8000`. The app's
API base URL is therefore the **empty string** — every request is a same-origin `/api/...`.

The reason is §10's last line: **FastAPI serves the built Angular bundle at `/` in
production.** So in production the UI and the API are one origin and a relative `/api` is
simply correct. With CORS instead, this app would need one base URL in dev and a different
one in production — a build-time switch, and a class of bug that only shows up after a
deploy. The proxy makes the dev arrangement match the production one, and as a bonus the
engine needs no CORS middleware at all, which is the safer default for a service bound to
loopback.

This used to be a deliberate departure from Ledgerline, which allowed the dev server's
origin and called `127.0.0.1:4310` cross-origin. It is not any more — that app's §9aj
moved it to this arrangement after the CORS-only bug its §9ab records, so the two now
differ in one detail: Ledgerline's proxy config is a `.mjs` because its port is
configurable, and this one is JSON because 8000 is a constant.

`EDGELINE_API_BASE_URL` is an injection token, so a test or a second dev server can point
elsewhere without editing `edgeline-api.service.ts`.

## Structure

§2.2 puts the pages in this app (`src/app/pages/... # pages per §11`), which is why there
is no `libs/edgeline/feature-shell` to match Ledgerline's. §2.2 reserves `libs/edgeline/`
for "Edgeline-only libs, when any are needed"; none are, for eight pages that no other
project imports.

```
src/app/
  app.ts .html .scss     shell — header, rail, PAPER badge, kill-switch banner
  app.routes.ts          §11.1's eight routes, lazy
  edgeline-api.service.ts the one seam to @metrum/edgeline-api-client (§11.3)
  system-status.service.ts GET /api/system/health, held once for the whole app
  formatting.ts          §1's odds edge — decimal to American, and only that
  pages/<name>/          one folder per §11.1 route
```

Money, percentages, times and the `—` convention come from `@metrum/ui`'s
`format.ts`, shared with Ledgerline: both apps store integer cents and UTC
ISO-8601 strings, so there is one implementation and one set of tests. What
stayed in this app is the conversion §1 allows only at a display edge and only
this app has — decimal odds to American. Putting that in the shared UI lib would
be exporting sports betting to a statement analyser.

**§11.3 is a hard rule: UI code imports only from `@metrum/edgeline-api-client`.** There
are no hand-written `HttpClient` calls, and `edgeline-api.service.ts` is the only file that
knows a transport exists. Every method on it is a pass-through; the moment one reshapes a
response it becomes a second, undocumented API surface that drifts from `openapi.json`.

If a response shape is wrong, change `apps/edgeline-api/src/edgeline/api/models.py`, then:

```bash
cd apps/edgeline-api && uv run python -m edgeline.api.openapi
```

```bash
npx nx run edgeline-api-client:generate-client
```

Both artefacts are committed and `npm run check` fails if either is stale.

## Styling

`provideTheming(METRUM_THEME)` — the house palette from `@metrum/ui`, not a theme of this
app's own. §11.2 asks for "accent teal `#2dd4bf`, emerald `#34d399`", and `METRUM_THEME`
already is those two hexes verbatim; a near-copy under another name would be twenty-eight
more WCAG pairs to keep honest for no visual gain. `app.spec.ts` pins both values so a
later edit to the shared lib cannot quietly move this app off the palette its spec names.

Layout primitives that seven of the eight pages share (`.page`, `.table`, `.tile`,
`.empty`, `.button`, `.field`) live in `src/styles.scss` rather than in each component.
Anything genuinely one page's problem stays in that page's `.scss`. The production build
caps a single component stylesheet at 4 kB, which is the other half of the reason.

## What the pages assume, which is mostly that there is nothing to show

Every table in this app is empty on a fresh cluster, and an empty table with no sentence
under it reads as a broken page rather than as a quiet market. So each page owns an
explanation, and the explanations are the part most worth not breaking:

- **Dashboard** computes _why_ nothing is being found — no books enabled, or too few for a
  consensus. The floor it quotes is `min_books_for_consensus` read from §3.2, not a
  literal 4; the arb floor of two is arithmetic and is a constant.
- **`null` is not zero.** `hit_rate`, `avg_clv_pct` and a result's `clv_pct` come back as
  `null` when nothing has settled or no closing line was captured. Results renders those as
  an em-dash with a sentence, never as `0.0%` — "no data yet" and "you lose every bet" must
  not draw identically.
- **`deep_link` is `""` and `link_level` is `"none"` on every leg** until T4.3 verifies URL
  templates book by book. §16.3 forbids inventing one, so a missing link renders as words,
  never as a dead anchor that looks tappable.
- **`edgeline-providers` is not seeded.** Unlike the sportsbook list, a provider row appears
  only when an adapter answers and reports its credit usage, so an empty Providers page is
  a normal state and says so.

## Guardrails in the UI

`paper_mode` and `kill_switch` are the two flags §16.2 reserves to an explicit user action,
and the app treats them differently from every other setting:

- The **PAPER badge is in the shell header**, on all eight pages. It reads PAPER until
  health says otherwise, including before the first read lands — the header must never
  claim live-money advice on evidence it does not have.
- **Settings keeps them out of the ordinary Save.** They stage a change, the page names the
  direction in words ("this removes a protection"), and a second, separately-labelled press
  applies it. A guardrail that saves alongside `poll_interval_s` is a guardrail that gets
  flipped while doing something else.
- **The dashboard's KILL is one press; RESUME asks twice.** Killing tightens a guardrail;
  resuming loosens one, and §12's daily loss stop may be what engaged it — so the
  confirmation says to check today's P&L first.

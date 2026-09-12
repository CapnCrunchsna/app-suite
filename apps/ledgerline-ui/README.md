# ledgerline-ui

Angular 22 shell for Ledgerline — standalone components, signals, zoneless,
SCSS, esbuild, vitest via `@angular/build:unit-test`. `scope:ll`, `type:app`.

Header, section rail for §6's nine pages, and a `<router-outlet>`. `appRoutes` is
`ledgerlineRoutes` from `@metrum/ledgerline-feature-shell` — the pages live there,
so adding one is a change in that lib rather than a change here plus a change
there.

Seven of the nine are built. Insights (§6.6) and Ask (§6.7) are rendered as spans
rather than links, so a rail item can never be clicked into a blank screen.

The app opens on the **home page** (§9u), which is not a §6 section and has no
rail item — the app name in the header is the way to it. Findings (§6.4) is still
the page §6 calls the hero, and the home page's headline figure is §6.4's savings
total and links straight to it.

**One process is enough.** `ledgerline-api` serves this app's built bundle at `/`
(§9aj), so the whole thing is at `127.0.0.1:4310`:

```bash
npx nx build ledgerline-ui    # writes dist/apps/ledgerline-ui/browser
npx nx serve ledgerline-api   # the app and its API, both on 127.0.0.1:4310
npm run seed:dev              # import the committed fixture statements
```

The API looks for the bundle at `dist/apps/ledgerline-ui/browser`
(`LEDGERLINE_UI_DIST` overrides it) and starts without one, serving the API
alone — building the UI is not a precondition for running the backend.

The dev server is for working *on* the UI, and needs the API up beside it:

```bash
npx nx serve ledgerline-ui    # localhost:4200, /api proxied to the API
```

`proxy.conf.mjs` forwards `/api` to the API, so the browser only ever talks to
one origin either way and the app's API base URL is the **empty string** in both.
That is what removed the CORS allow-list this app used to need: same origin, no
preflight, and nothing to keep in step with a new HTTP method — see §9ab for the
`PUT` that was missing from it and the bug that followed. The proxy reads
`LEDGERLINE_PORT`, so set the same value for both commands if you move the API
off 4310.

There is no `serve-static` target. The API is the one thing that serves
`dist/apps/ledgerline-ui/browser`, and a second server for the same directory
would hand you the app with no API behind it.

## Two things this project does that the generator does not

Angular does not support a TypeScript setup with project references
([angular/angular#37276](https://github.com/angular/angular/issues/37276)), and
this workspace is exactly that — npm workspaces, `composite: true`, and
`nx sync`-maintained `references`. `@nx/angular:application` refuses to run
against it without `NX_IGNORE_UNSUPPORTED_TS_SETUP=true`. It generates fine with
that flag set; these adjustments are what "at your own risk" actually costs.

**1. `tsconfig.json` overrides two base options.** `tsconfig.base.json` targets
Node libraries: `emitDeclarationOnly: true` and `lib: ["es2022"]`. Angular's
compiler rejects the first outright (`NG4006`) and the browser needs `dom`, so
both are overridden here. The `typecheck` target passes `--emitDeclarationOnly`
back on the command line, so declaration-only emit still holds where it matters.

**2. `project.json` has no `lint` target.** The generator emits the deprecated
`@nx/eslint:lint` executor; it was removed so the target is inferred from
`@nx/eslint/plugin`, the way every lib in this workspace gets one.

Nothing else is special. Workspace libs are imported by bare specifier and
resolve through `exports` with no `paths` entries, no custom esbuild
`conditions`, and no per-app configuration.

**3. `tsconfig.json` sets `customConditions: []`.** The workspace base sets
`["@metrum/source"]`, which resolves workspace deps to `src/index.ts`. This app now
reaches `@metrum/ledgerline-domain` through the feature lib, and that lib's
`dedupe.ts` imports `node:crypto` — a type a browser app has no business
declaring. It is also what the bundler does anyway: `@angular/build` applies no
custom conditions, so the source condition would be typechecking against code that
never gets loaded. `libs/ledgerline/feature-shell` overrides it for the same
reason.

## The `@metrum/ui` build guard moved

`app.spec.ts` used to carry a "binds through to the ui panel" test that guarded
`@metrum/ui`'s build rather than this shell. It now lives in
`libs/ledgerline/feature-shell`, because the guard has to sit wherever `ui-panel`
is actually rendered — and the pages render it now, not the shell.

The reasoning is unchanged and still worth knowing here, because it applies to
every `@metrum/…` import this app makes: `@angular/build:unit-test` hardcodes
`externalPackages: true`, so a bare specifier stays external and Vite resolves it
through `node_modules` to that lib's `dist/`. If `dist/` is ever plain `tsc` output
instead of ngtsc output, `TestBed` falls back to JIT-compiling the component from
its `@Component` decorator — and JIT cannot see initializer APIs, so **every
`input()`, `output()` and `model()` disappears while the component still
renders**. Bindings quietly stop working and nothing else notices. See
[`libs/shared/ui/README.md`](../../libs/shared/ui/README.md) for how that lib's
build avoids it.

The same resolution rule is why editing a page in
`libs/ledgerline/feature-shell` does not hot-reload this app: it consumes the lib
as built output. Rebuild the lib, then reload.

## Styling

Dark-first, per §6 — and dark-first now means a default rather than the only
option (§9u). The palette moved to `@metrum/ui` on 2026-09-11, when Edgeline got
an identity of its own and the suite settled on **each app defaults to its own
theme and offers every other one**. An app cannot import another app, so a
palette more than one app offers has to live in the lib they share:

```ts
providers: [provideTheming(LEDGERLINE_THEME, { also: SUITE_THEMES })]
```

`@metrum/ui` owns everything after that: it writes the tokens onto `:root` before
the first paint, keeps `color-scheme` in step, remembers the choice per app, and
renders the header's `<ui-theme-switcher>`. Three themes are offered — Ledgerline's
own, the MetrumDigital house palette that `artifacts/_template.html` and the
dashboard use, and Edgeline's amber — each in light and dark, with "system"
following `prefers-color-scheme`.

`src/styles.scss` holds structure and **two** colour literals: `--bg` and `--text`
at Ledgerline's dark values, as the ground painted between the browser reading
`index.html` and Angular's initializer running. They are the only tokens duplicated
anywhere, and `ledgerline.theme.spec.ts` asserts the duplicate matches — that
assertion is all that stayed behind, since only this app knows what its own
stylesheet declared.

Nothing else in this app or in `libs/ledgerline/feature-shell` names a colour.
Every rule in both used to be written `var(--token, #hex)`; those 660 fallbacks
are gone, along with three in `@metrum/ui`'s `ui-panel`, whose docstring already
promised it carried no palette of its own. Ten of the same kind survive in that
lib's `mode-toggle` and `theme-switcher`, which Edgeline renders too and which
this app therefore does not get to decide alone. None of them could ever fire —
`ThemeService` sets every token on `:root` before the first paint, so the only gap
they covered is the one `--bg` and `--text` above exist to cover — and they had
drifted into exactly the second, stale palette this work removed: `--warn` stood
at two different ambers, `--surface-1` at two different blues. Three themes in
light and dark is six palettes, and no literal is right in more than one of them.

A colour is therefore always a bare `var(--token)`, and a fallback in a colour
position should be read as a bug. Non-colour fallbacks are a different case and
stay: `--mono` and `--shadow` are declared nowhere, so there the fallback *is* the
value, and `--columns` and `--fill` are per-element properties set by the
component that owns them. `--radius` is the odd one — the service writes it like
it writes the palette, so `var(--radius, 10px)` is as dead as the colours were,
but it is shape rather than colour and is left for a pass of its own.

The WCAG audit moved with the palette: `theming.spec.ts` runs `auditTheme` over
every theme in `SUITE_THEMES`, because any app can now be painted in any of them.

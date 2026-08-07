# ledgerline-ui

Angular 22 shell for Ledgerline — standalone components, signals, zoneless,
SCSS, esbuild, vitest via `@angular/build:unit-test`. `scope:ll`, `type:app`.

Header, section rail for §6's eight pages, and a `<router-outlet>`. `appRoutes` is
`ledgerlineRoutes` from `@metrum/ledgerline-feature-shell` — the pages live there,
so adding one is a change in that lib rather than a change here plus a change
there.

One of the eight is built: **Transactions (§6.3)**, which is where the app opens.
The other seven are rendered as spans rather than links, so a rail item can never
be clicked into a blank screen.

```bash
npx nx serve ledgerline-api   # 127.0.0.1:4310 — the page has nothing to read without it
npm run seed:dev              # import the committed fixture statements
npx nx serve ledgerline-ui    # localhost:4200
```

The API and the UI are different origins in development, which is why the API
carries a loopback-only CORS allow-list (`apps/ledgerline-api/src/lib/server.ts`).

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

Dark-first, per §6. The palette in `src/styles.scss` is the MetrumDigital
artifact palette (`artifacts/_template.html`) so the app and the dashboard read
as one house. Everything downstream — including `@metrum/ui` — consumes
it as CSS custom properties, so a light theme is a token swap on `:root` and
nothing else.

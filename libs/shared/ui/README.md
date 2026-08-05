# ui

Workspace-wide presentational Angular components — the house style every app in
the suite sits on. `scope:shared`, `type:ui`, consumed as `@metrum/ui`.

§2.2 gives this lib the tightest dependency rule in the workspace —
`type:ui` may depend only on `type:ui` — so nothing here may import a domain
type, an API client, or anything app-shaped. Components take inputs, emit
outputs, and project content. Colours come from CSS custom properties the host
app defines; this lib ships no palette.

Stub contents: `Panel` (`<ui-panel>`).

## Why this lib builds differently from the others

Every other lib here is compiled by plain `tsc` through the
`@nx/js/typescript` plugin. This one **cannot be**, and the failure mode is
silent rather than loud, which is why it is worth writing down.

`tsc` output carries no Angular metadata. A consumer that resolves this package
to `tsc` output gets a class Angular falls back to JIT-compiling from its
`@Component` decorator — and JIT cannot see initializer APIs, so **every
`input()`, `output()` and `model()` disappears while the component still
renders**. Bindings quietly do nothing. `@angular/build:unit-test` hardcodes
`externalPackages: true`, so that is exactly what a consuming app's test build
does by default.

`build` is therefore an explicit `@nx/angular:package` (ng-packagr) target in
`project.json`, overriding the inferred `tsc` one and emitting real ngtsc output
in Angular Package Format. Two consequences:

- **`package.json`'s entry points are ng-packagr's paths**, not ones we chose —
  `dist/fesm2022/metrum-ui.mjs` and `dist/types/metrum-ui.d.ts`, both derived
  from the package name. npm workspaces symlinks `node_modules/@metrum/ui` at
  _this_ folder, so consumers read this manifest rather than the one ng-packagr
  writes into `dist/`. ng-packagr warns that it would override the
  `./package.json` subpath export; that only affects its copy in `dist/`, which
  nothing here reads.
- **`tsconfig.lib.json` emits to `out-tsc/lib`, not `dist`.** `dist/` belongs to
  ng-packagr; otherwise the inferred `typecheck` target would overwrite
  ng-packagr's declarations with metadata-free ones, non-deterministically,
  depending on which target ran last.

Consumers need no special configuration — a plain
`import { Panel } from '@metrum/ui'` resolves correctly through `exports` in
both an app's build and its tests. `ledgerline-ui`'s "binds through to the ui
panel" test is the regression guard for the silent-input failure above.

`@angular/core` is a **peer** dependency: this lib must compile against whatever
Angular the consuming app runs, and a second copy resolved into its own
`node_modules` would break DI and `instanceof` checks.

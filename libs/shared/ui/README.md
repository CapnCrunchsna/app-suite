# ui

Workspace-wide presentational Angular components — the house style every app in
the suite sits on. `scope:shared`, `type:ui`, consumed as `@metrum/ui`.

§2.2 gives this lib the tightest dependency rule in the workspace —
`type:ui` may depend only on `type:ui` — so nothing here may import a domain
type, an API client, or anything app-shaped. Components take inputs, emit
outputs, and project content.

Contents:

- `Panel` (`<ui-panel>`) — the titled surface every §6 page is laid out on.
- **Theming** (`src/lib/theming/`) — the token contract, the house palette,
  `provideTheming`, `<ui-theme-switcher>` and `<ui-mode-toggle>`.

## Theming

Two axes. A **theme** is an identity — one app's palette, registered by that app.
A **mode** is light, dark, or system within it. An app opts in with one call:

```ts
providers: [provideTheming(MY_APP_THEME)]
```

That registers the palette, makes it the app's default, and puts it in the
switcher beside the house theme. `ThemeService` writes every token onto `:root`
in an environment initializer — before the first paint, which is what an
`effect` could not promise — keeps `color-scheme` in step so native scrollbars
and form controls follow the palette, and remembers the choice in `localStorage`
under a per-app key.

**Colours still come from CSS custom properties, and this lib still ships no
palette of its own** beyond the house one. Nothing outside `theming/` names a
colour; components consume `var(--text-dim, …)` exactly as before. What changed
is that the properties now have somewhere to come from.

**A palette must be checked, not eyeballed.** `auditTheme(theme)` returns every
foreground/background pair that fails its WCAG threshold, in both modes, with a
readable message. It is exported rather than kept in this lib's spec so an app
that brings its own palette can assert on it in one line — `ledgerline-ui` does.
`contrast.ts` documents each threshold and why it is what it is.

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

`build` is therefore an explicit ng-packagr target in `project.json`, overriding
the inferred `tsc` one and emitting real ngtsc output in Angular Package Format.

The executor is `@angular/build:ng-packagr` rather than `@nx/angular:package`,
which is what it was until this lib acquired tests: `@angular/build:unit-test`
only accepts an `@angular/build` build target to read compiler options from, and
refuses against the Nx one with "not supported". Same ng-packagr underneath and
the same artifact out — `libs/ledgerline/feature-shell` has been on it since it
was generated, for the same reason.

Two consequences:

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

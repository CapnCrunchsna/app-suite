# ledgerline-ui

Angular 22 shell for Ledgerline — standalone components, signals, zoneless,
SCSS, esbuild, vitest via `@angular/build:unit-test`. `scope:ll`, `type:app`.

Currently a **wireframe**: header, section rail for §6's eight pages, and one
`<ui-panel>`. `appRoutes` is empty on purpose — the pages are components in
`libs/ledgerline/feature-shell`, and the rail becomes `routerLink`s when there
is something to link to.

```bash
npx nx serve ledgerline-ui
```

## Three things this project does that the generator does not

Angular does not support a TypeScript setup with project references
([angular/angular#37276](https://github.com/angular/angular/issues/37276)), and
this workspace is exactly that — npm workspaces, `composite: true`, and
`nx sync`-maintained `references`. `@nx/angular:application` refuses to run
against it without `NX_IGNORE_UNSUPPORTED_TS_SETUP=true`. It generates fine with
that flag set; these three adjustments are what "at your own risk" actually
costs.

**1. `tsconfig.json` overrides two base options.** `tsconfig.base.json` targets
Node libraries: `emitDeclarationOnly: true` and `lib: ["es2022"]`. Angular's
compiler rejects the first outright (`NG4006`) and the browser needs `dom`, so
both are overridden here. The `typecheck` target passes `--emitDeclarationOnly`
back on the command line, so declaration-only emit still holds where it matters.

**2. `tsconfig.json` has a `paths` entry per workspace lib this app imports.**
This is the load-bearing one, and it fails quietly if you skip it.

`@angular/build:unit-test` hardcodes `externalPackages: true`, so a bare
`@app-suite/…` specifier is left external in the test build and Vite resolves it
through `node_modules` to the lib's `dist/` — which the `@nx/js/typescript`
plugin produced with plain `tsc`. Plain `tsc` output carries no Angular
metadata, so `TestBed` falls back to JIT-compiling the component from its
`@Component` decorator alone. JIT cannot see initializer APIs, so **every
`input()`, `output()` and `model()` silently disappears** — the component still
renders, its bindings just do nothing. A `paths` entry resolves to a _file_
rather than a package, so esbuild inlines the source and ngtsc compiles it
properly.

`app.spec.ts` has a test named "binds through to the ui-kit panel" whose only
job is to fail if that entry is ever dropped.

The alternative is making `@app-suite/ui-kit` a real buildable Angular library
(ng-packagr, partial compilation), at which point `dist/` is consumable and the
`paths` entry goes away. That is the right move once `ui-kit` holds real
components; it is more machinery than a stub earns.

**3. `project.json` has no `lint` target.** The generator emits the deprecated
`@nx/eslint:lint` executor; it was removed so the target is inferred from
`@nx/eslint/plugin`, the way every lib in this workspace gets one.

## Styling

Dark-first, per §6. The palette in `src/styles.scss` is the MetrumDigital
artifact palette (`artifacts/_template.html`) so the app and the dashboard read
as one house. Everything downstream — including `@app-suite/ui-kit` — consumes
it as CSS custom properties, so a light theme is a token swap on `:root` and
nothing else.

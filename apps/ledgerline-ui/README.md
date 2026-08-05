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

## The one test here that is not about this app

`app.spec.ts`'s "binds through to the ui panel" guards `@metrum/ui`'s build,
not this shell. `@angular/build:unit-test` hardcodes `externalPackages: true`,
so a bare `@metrum/…` specifier stays external and Vite resolves it through
`node_modules` to that lib's `dist/`. If `dist/` is ever plain `tsc` output
instead of ngtsc output, `TestBed` falls back to JIT-compiling `Panel` from its
`@Component` decorator — and JIT cannot see initializer APIs, so **every
`input()`, `output()` and `model()` disappears while the component still
renders**. Bindings quietly stop working and nothing else notices. See
[`libs/shared/ui/README.md`](../../libs/shared/ui/README.md) for how that lib's
build avoids it.

## Styling

Dark-first, per §6. The palette in `src/styles.scss` is the MetrumDigital
artifact palette (`artifacts/_template.html`) so the app and the dashboard read
as one house. Everything downstream — including `@metrum/ui` — consumes
it as CSS custom properties, so a light theme is a token swap on `:root` and
nothing else.

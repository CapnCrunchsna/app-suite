# ledgerline-feature-shell

Ledgerline's §6 pages. `scope:ll`, `type:feature`, consumed as
`@metrum/ledgerline-feature-shell`.

Built so far: **Transactions (§6.3)**. The other seven sections are rail items in
`apps/ledgerline-ui` that route nowhere yet.

## The boundary is the point of this lib

§2.2 gives `type:feature` exactly three allowances — `type:domain`, `type:ui`,
`type:api-client` — and one hard rule: *"No direct `data`/`analyzers` imports —
everything through HTTP."* Which means:

- **`@metrum/ledgerline-data` is unreachable from here**, and not by convention.
  `@nx/enforce-module-boundaries` rejects the edge, `lint` is a required target in
  `npm run check`, and that was verified by adding the import and watching it fail
  rather than by assuming.
- **`@metrum/api-client` is the only way to the store.** It is generated from
  `apps/ledgerline-api/openapi.json` and framework-free by its own constraint, so
  `ledgerline-api.service.ts` is the one file here that makes it injectable — and
  the only file that knows a transport exists. Every method on it is a
  pass-through; the moment it starts reshaping responses it becomes a second,
  undocumented API surface.

## Layout

```
lib/
  ledgerline-api.service.ts     the one seam to the API
  routes.ts                     §6's pages as lazy routes, exported to the shell
  transactions/
    transactions-page.ts        the container — owns all state and every request
    transaction-filters.ts      §6.3's filter bar (presentational)
    transaction-detail.ts       the row expander (presentational)
    merchant-assign.ts          the merchant edit and its bulk offer
    virtual-window.ts           the windowing arithmetic, as a pure function
```

The container owns the state and the four children are presentational — except
`MerchantAssign`, which owns one dry-run count. That split is what keeps *the
filter the user is reading* and *the filter the bulk apply sends* the same object
rather than two that agree by inspection.

## Three things about the Transactions page worth knowing

**Server pagination, client virtualization.** `GET /api/transactions` pages and
the table windows within a page. A heavy household is ~58,000 transactions (§2.2);
neither alone would do — all rows in one request is a 60 MB response, and
virtualizing without paging still asks SQLite for all of it.

**The window arithmetic is a pure function with its own tests.** `virtual-window.ts`
is separated from the component because it is the only part of the table with an
off-by-one a screenshot would not reveal: a window one row short leaves a blank
stripe on a fast scroll, one row long is invisible. It also carries the expanded
row's height, because §6.3's row expander breaks the fixed-height assumption the
moment it opens — one variable-height row is in the arithmetic rather than patched
up afterwards.

**The bulk count is fetched, never computed.** It would be easy to count matching
rows in the page already loaded. It would also be wrong by however many pages the
user has not scrolled to, and that number is the basis on which they authorise a
permanent, precedence-topping change (§4.3). The scope is the *descriptor*, across
every account and date and including rows the internal-transfer and excluded
filters hide — a merchant correction is a statement about identity, and scoping it
to the visible filter would leave one descriptor resolving two ways in one
database.

## Why this lib builds with ng-packagr

Same reason as `libs/shared/ui` — see [its README](../../shared/ui/README.md) for
the silent failure that `tsc` output causes. Two differences here:

**`@angular/build:ng-packagr`, not `@nx/angular:package`.** `@angular/build:unit-test`
reads compiler options from the project's build target and only accepts an
`@angular/build` one; against the Nx executor it refuses with "not supported" and
then fails looking for a `development` configuration.

**`customConditions: []` in `tsconfig.json`.** The workspace base sets
`customConditions: ["@metrum/source"]`, which resolves workspace deps to
`src/index.ts`. That breaks twice over here: `@metrum/ledgerline-domain` is a Node
lib whose `dedupe.ts` imports `node:crypto`, which an ngtsc compile with
`types: []` cannot see; and the source condition would be a lie about what gets
bundled, because `@angular/build` applies no custom conditions and its unit-test
builder hardcodes `externalPackages: true`. Both resolve these to `dist/`, so
that is what this lib typechecks against.

## Iterating on a page

The app consumes this lib as a **built package**, so editing a component here does
not trigger an app rebuild — and Vite additionally pre-bundles it as an external
dependency, which survives a dev-server restart. After changing anything under
`src/`:

```bash
npx nx build ledgerline-feature-shell
```

then reload the browser. If the old code is still running, Vite's pre-bundle is
stale; `rm -rf .angular/cache` and restart the dev server.

## Tests

`transactions-page.spec.ts` runs against a stubbed `LedgerlineApiService` rather
than a served API: `apps/ledgerline-api`'s suite already drives the real HTTP
surface over real fixture bytes, and repeating that here would test the API twice
and the page not at all. What it tests is the part the API cannot see — that the
count and the apply use one filter, that the internal-transfer default is off, and
that money reaches the DOM formatted from cents rather than parsed from a string.

It also carries the `@metrum/ui` binding guard that used to live in
`apps/ledgerline-ui`. That guard has to sit wherever `ui-panel` is actually
rendered, which is now here.

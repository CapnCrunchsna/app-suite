# ledgerline-feature-shell

Ledgerline's §6 pages. `scope:ll`, `type:feature`, consumed as
`@metrum/ledgerline-feature-shell`.

Built so far: **Import (§6.1)**, **Accounts (§6.2)**, **Transactions (§6.3)**,
**Findings (§6.4)**, **Subscriptions (§6.5)**, **Review (§6.9)** and
**Settings (§6.8)**, plus the **home page** at `/` (§9u), which is not a §6 section
and has no rail item. Insights (§6.6) and Ask (§6.7) are rail items in
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
  routes.ts                     the pages as lazy routes, exported to the shell
  rule-copy.ts                  §5's rule ids rendered as English
  home/
    home-page.ts                the front door (§9u) — computes nothing
  imports/
    imports-page.ts             the container — owns all state and every request
    import-dropzone.ts          the dropzone and the staged file list
    review-table.ts             parsed rows, duplicates, the three-way choice
    review-warnings.ts          §6.1's warning strip, as a pure function
    column-mapper.ts            the inline mapper and its live preview
    import-history.ts           re-parse and delete
  accounts/
    accounts-page.ts            the container
    account-card.ts             §6.2's row and its four actions
    coverage-bar.ts             the month strip (presentational)
    transfer-queue.ts           §2.6's proposals and the auto-links beside them
  transactions/
    transactions-page.ts        the container
    transaction-filters.ts      §6.3's filter bar (presentational)
    transaction-detail.ts       the row expander (presentational)
    merchant-assign.ts          the merchant edit and its bulk offer
    virtual-window.ts           the windowing arithmetic, as a pure function
  review/
    review-page.ts              the container
    review-queue.service.ts     the queue, held once — the rail badges it too
    merchant-review.ts          §4.1 step 7's merge candidates (presentational)
  findings/
    findings-page.ts            the container
    findings-summary.ts         §6.4's three headline numbers
    finding-filters.ts          band, rule, account, minimum impact
    finding-card.ts             one finding and its four actions
    finding-evidence.ts         the inline charge history
  subscriptions/
    subscriptions-page.ts       the container
    month-strip.ts              which days charges land
    series-detail.ts            the drawer: history, price steps, user fields
  settings/
    settings-page.ts            the container
    analyzer-settings.ts        §7.4's thresholds and per-rule switches
    data-settings.ts            backup, export, wipe
```

Every page follows the same split: the container owns the state and every request,
and the children are presentational. Two children are the exception, for one
reason. `MerchantAssign` owns its dry-run count so that *the filter the user is
reading* and *the filter the bulk apply sends* are the same object rather than
two that agree by inspection. `ColumnMapper` owns its draft and the preview that
draft drives, because the draft is a dozen fields nothing outside it reads and the
preview refires on every dropdown change; the *write* still leaves through the
page.

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

## Three things about the Import page worth knowing

**A resource's params must never read that resource's own value.** The mapper's
preview takes the draft as its params, and the draft's column map is addressed by
header name — names that arrive *in the preview response*. Deriving the map from
that response made the params a consumer of their own result, and the failure is
silent: the signal graph stops propagating and the second dropdown change, and
every one after it, previews nothing. Keying the roles by header name rather than
by column position removes the read entirely, and is what a saved `columnMap`
addresses anyway.

**The account gate is a data rule, not a form field.** `POST /commit` refuses an
import with no account and `GET /api/imports/:id` returns `plan: null` until there
is one, because §3.3's merge rule counts rows *within an account* — there is no
duplicate count before the account is known. So the page shows no plan and no
reachable Commit until the `PATCH` lands, rather than showing a plan it would then
have to disown.

**Two fields are deliberately absent from the mapper's draft.** Detection reports
the delimiter and the preamble length on every preview, and the API's fallback
prefers what was detected over what was assumed — but only when the field is
absent. Sending them is how `,` silently overrides a detected `;`.

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

Both page specs run against a stubbed `LedgerlineApiService` rather than a served
API: `apps/ledgerline-api`'s suite already drives the real HTTP surface over real
fixture bytes, and repeating that here would test the API twice and the page not
at all. What they test is the part the API cannot see — for §6.3, that the count
and the apply use one filter, that the internal-transfer default is off, and that
money reaches the DOM formatted from cents rather than parsed from a string; for
§6.1, that Commit is unreachable until the account is confirmed, that a
near-duplicate's default is pre-selected and applied to nothing, and that the
mapper's draft omits the two fields detection already answered.

It also carries the `@metrum/ui` binding guard that used to live in
`apps/ledgerline-ui`. That guard has to sit wherever `ui-panel` is actually
rendered, which is now here.

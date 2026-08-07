# api-client

Generated TypeScript client for the `ledgerline-api` HTTP surface (spec §2.3).
`scope:shared`, `type:api-client`.

**Never hand-edited.** Everything under `src/` is emitted by
[`tools/generate-api-client.mjs`](../../../tools/generate-api-client.mjs) from
`apps/ledgerline-api/openapi.json`. Change the Fastify route schemas, rebuild the
API so it re-emits the contract, and regenerate:

```bash
npx nx generate-client api-client
```

That target `dependsOn` `ledgerline-api:build`, so the one command covers both
halves — you never regenerate against a stale contract.

## What stops this from going stale

A generated file with a "do not edit" banner is a convention. Two tests in
`ledgerline-api`'s suite (`src/contract.spec.ts`) make it a rule, and both run in
`npm run check`:

- `openapi.json` must equal what the route schemas emit right now.
- `src/` must equal what the generator produces from `openapi.json`.

They live in the API's suite rather than here because §2.2 gives this lib
`onlyDependOnLibsWithTags: []` — it cannot import the routes it is generated from,
so it could not check itself even in principle. The API owns the contract, so the
API owns the test that the contract is current.

## What the generator does and does not do

**It invents no names.** Every exported interface is a `components.schemas` key,
which is an `$id` chosen in
[`routes/schemas.ts`](../../../apps/ledgerline-api/src/lib/routes/schemas.ts).
Every method is an `operationId` declared on its route. An operation without one
is a generator error rather than a guess, so a bad name in this file is a bad name
in a route schema and the fix belongs there.

**It is dependency-free and framework-free.** `fetch`, not `HttpClient` — this
lib may depend on nothing, and an Angular import here would break that before the
lint ever ran. Wrap `LedgerlineApi` in an injectable in the feature lib that
consumes it; `libs/ledgerline/feature-shell` does exactly that.

**Response types are `readonly` and money is integer cents.** Every money field
on the wire is `amount_cents` (§3.1, §7.3). Format with `formatCents` from
`@metrum/ledgerline-domain` for display and never parse a formatted string back.

**Where a route has no declared response schema, the method returns `unknown`.**
That is honest rather than convenient: the contract genuinely says nothing about
those bodies. It currently applies to `POST /api/data/export` and to parts of the
import review surface, which is §6.1's work. `POST /api/imports` is multipart and
carries no described request body for the same reason — uploading files through
this client is not possible yet, and should not look like it is.

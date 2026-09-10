# format

The display edge for every app in this suite. `scope:shared`, `type:format`,
consumed as `@metrum/format`.

Both apps store money as integer cents and timestamps as UTC ISO-8601 strings.
This is the one place either turns those into something a person reads:
`formatCents` and its magnitude, whole-dollar and always-signed variants;
`formatPercent` and `formatRatioAsPercent`; `formatLocalTime` / `formatLocalDay`
/ `formatAge`; and `NO_DATA`.

## Why it is its own lib

It imports nothing — no Angular, no domain types, no API client — and that is
the point rather than an accident.

`tools/parse-statement.mjs` is a Node CLI that prints a statement to a terminal
and needs `formatCents`. `@metrum/ui` resolves to an Angular Package Format
bundle that imports `@angular/core`, so shipping these functions from there
would mean a command-line tool loading a UI framework to render a dollar sign.
`@metrum/ledgerline-domain` — where `formatCents` used to live — is `scope:ll`,
and Edgeline is `scope:el` and may not reach it at all.

So a dependency-free leaf is the only shape that serves a browser page, a Node
script and a second app at once. `type:format` has an empty allow-list in the
boundary contract for the same reason `type:domain` does, and appears in nearly
every other allow-list because a leaf is safe for anything to reach.

## Two rules the functions encode rather than document

- **`null` is not zero.** Every formatter takes `null | undefined` and renders
  `NO_DATA` (`—`). This earns its keep where an API distinguishes the two on
  purpose: Edgeline returns `null` for a hit rate when nothing has settled, and
  rendering that as `0.0%` would tell a reader with an empty database that they
  lose every bet.

  The `fallback` parameter is for the case where showing _the raw value_ beats
  showing nothing — Ledgerline's home page passes the unparsed timestamp to
  `formatLocalDay`, because if the API ever sends something this cannot read,
  seeing it is more use than hiding it. It is **not** an escape hatch for
  rendering a blank: the one page that did that now uses the em-dash like
  everything else, since a blank cell beside a real figure reads as a rendering
  gap or as zero. It is a parameter rather than a second function so that a
  caller departing from the convention has to say so at the call site.

- **A ratio is not a percentage.** `formatRatioAsPercent` is separate from
  `formatPercent` because confusing them is silent and severe: a 55% hit rate
  shown as `0.55%` reads as a catastrophe rather than a good week.

## What stayed behind

`@metrum/ledgerline-domain` keeps `parseMoneyToCents` and `isOutflow`. Reading a
statement's text and knowing which way money moved are things the ledger knows;
rendering a number for a person is not.

`money.spec.ts` in that lib keeps one assertion about this one: that
`formatCents` output parses back through `parseMoneyToCents`. That property
spans the two libs, so neither lib's own spec could check it — a formatter that
emitted a separator the parser choked on would be correct in isolation and wrong
in use.

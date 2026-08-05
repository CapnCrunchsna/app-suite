# ui-kit

Workspace-wide presentational Angular components. `scope:shared`, `type:ui`.

§2.2 gives this lib the tightest dependency rule in the workspace —
`type:ui` may depend only on `type:ui` — so nothing here may import a domain
type, an API client, or anything app-shaped. Components take inputs, emit
outputs, and project content. Colours come from CSS custom properties the host
app defines; this lib ships no palette.

Templates and styles are **inline**. The `build` target is plain `tsc` (the
`@nx/js/typescript` plugin, keyed on `tsconfig.lib.json`), which does not copy
sibling `.html` / `.scss` files into `dist/`.

Stub contents: `Panel` (`<ui-panel>`).

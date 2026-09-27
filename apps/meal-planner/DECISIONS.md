# Meal Planner — implementation decisions

The spec (`docs/meal-planner-spec.md` §0) asks for this file: every choice the spec left
open, recorded where the next implementer will look. Where the spec itself was wrong, it
was fixed in place instead, and its revision note says what changed.

## Platform and toolchain

- **`sql.js` is pinned to exactly 1.11.0.** jeep-sqlite 2.8.0 (the web build's SQLite)
  bundles sql.js's JavaScript glue from its own build, which was 1.11.0; the `.wasm` the
  app copies to `/assets` must come from the same release. With 1.14.2 the page failed
  with `LinkError: … function import requires a callable` and no database. Move this pin
  only together with a jeep-sqlite upgrade, and re-check that the web build opens its
  database.
- **Ionic 9 is imported from `@ionic/angular`**, not `@ionic/angular/standalone`: in v9
  the standalone build *is* the package root.
- **Zoneless Angular** (the workspace default). Ionic runs without `zone.js`; npm installs
  it only as Ionic's declared peer, and nothing imports it.
- **Android first; no `ios/` yet.** Nothing here can build iOS, and the app-suite
  `CLAUDE.md` names the app Android-first. `npx cap add ios` on a Mac is the whole step.
- **The Android project is committed** (`android/`), as Chip Away's is. Capacitor's own
  `.gitignore` keeps build output and the copied web bundle out. Gradle finds JDK 21
  through `~/.gradle/gradle.properties` — see `games/chip-away/scripts/README.md`.
- **The dev server is `meal-planner` in both launch configs** (workspace and app-suite),
  same command, same port 4203, so a session rooted in either repo can start it.
- **The dev server does not pre-bundle the three `@metrum/meal-planner-*` libs** (a
  pre-bundled copy went stale and lacked `PantryRepo`). They are served from `dist/`, so
  restart the server after changing one. jeep-sqlite must stay pre-bundled.
- **jeep-sqlite is registered from its custom-elements build**
  (`jeep-sqlite/dist/components/jeep-sqlite`), not its lazy loader, which collided with
  Ionic's Stencil runtime. Reasoning in `src/app/data/database.ts`.

## Scanning and lookup

- **Scanning uses the plugin's `startScan` with our own overlay**, for single and bulk
  scans alike, not its ready-made `scan()` UI — that one is experimental and Android may
  kill the app mid-scan and lose the result. See `src/app/platform/scanner.ts`.
- **The browser build takes typed barcodes** where the phone uses the camera, in the same
  overlay. It is not a feature so much as what makes the scan → Open Food Facts → pantry
  path testable on a laptop; it is shown only where there is no camera.
- **Bulk scan counts a barcode again only after 2.5 s out of view.** The scanner reports
  a code on every frame it can read it; see `src/app/pantry/bulk-scan-session.ts`.
- **A counted product from Open Food Facts takes OFF's per-serving values.** §4 forbids a
  per-100 basis on a `COUNT` product, and a carton of eggs' serving is usually one egg.
  When OFF has no kcal but has kJ, kJ ÷ 4.184 is used.
- **The Open Food Facts contact is `https://github.com/CapnCrunchsna`**, in
  `APP_CONTACT` (`src/app/platform/http.ts`). Change it there if the project gets a page.

## Pantry

- **A pantry row is one purchase**, so two cartons are one row of 24, and "of" in
  "21 of 24" is the whole packages the row still spans. A product sold singly shows a
  bare count. Reasoning in `libs/meal-planner/domain/src/lib/format.ts`.
- **A brand the name already contains is not shown twice** ("Nutella", not
  "Nutella · Nutella"): `distinctBrand` in the domain lib.
- **Edit's "Full" and "About half" measure the whole row**, so "about half" of two jars
  is one jar.

## Storage

- **Applied migrations live in `_migrations`, not `PRAGMA user_version`**, because the
  Capacitor SQLite plugin manages `user_version` itself. Reasoning in `migrations.ts`.
- **`SqlDb.transaction` passes the callback a scoped executor**, and the app's adapter
  runs every operation through one queue. Reasoning in `libs/meal-planner/data/src/lib/sql.ts`
  and `src/app/data/capacitor-sql-db.ts`.
- **The web build saves its database 200 ms after the last write**, and immediately when
  the page is hidden. jeep-sqlite otherwise keeps it only in memory.
- **Ids come from `crypto.getRandomValues`**, not `randomUUID`, which exists only in a
  secure context — so the app still works when opened over a LAN address to test on a
  phone.

## Look and navigation

- **Ionic's palette with the MetrumDigital teal as primary**, not `@metrum/ui` theming:
  Ionic's components read `--ion-*` variables, which the suite themes do not set. Dark
  mode follows the system (`dark.system.css`).
- **Today is the landing tab.** It is what the app is opened for, and the seeded library
  gives it something to plan with before the person has entered anything.

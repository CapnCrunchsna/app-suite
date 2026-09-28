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
- **Ionic 9 is imported per component** (`@ionic/angular/ion-button`,
  `@ionic/angular/toast-controller`), not from the package root; only type imports use
  the root. main.ts reaches the root barrel, so esbuild put every component any lazy page
  used into the initial chunk (1.12 MB, over the 1 MB budget). Per-component imports
  moved input, select, searchbar, toast and loading out of it (804 kB). The simple
  components share one file in Ionic's package and stay initial. Import new Ionic
  components the same way.
- **Testing Ionic in a hidden Browser pane stalls page transitions**: a hidden page gets
  no `requestAnimationFrame`, so tab switches and overlays never finish and pages look
  stuck on their spinner. It is not the app. Test with the pane visible, or use the
  `meal-planner-static` launch config (the production build, served on 4204).
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

- **`@capacitor/app` is installed** though §2 did not name it: without it Android's Back
  button bypassed Ionic entirely and closed the app from inside a modal. `src/app/app.ts`
  hands Back to Ionic and exits only when nothing is left to close.
- **First launch seeds the starter library over the native bridge**, a few hundred
  plugin calls that take seconds on the emulator. The pages show a spinner until their
  first read finishes rather than an empty state that would be wrong.

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

## Meals and import

- **The starter library is generated** by `tools/make-meal-planner-seeds.mjs` into
  `libs/meal-planner/data/seed/`. The eight T5 meals' "balancing" quantities are solved
  exactly and kept at full precision; the script's header says why rounding them would
  break T5.
- **Editing a meal keeps each untouched line's exact stored quantity and text**, and
  carries to-taste and unlinked lines through as text, so re-saving changes nothing the
  person did not change.
- **An imported recipe defaults to lunch and dinner**; the review shows the same slot
  chips as the builder. §10's review has no slot field, and "all four" would offer a
  lasagna at breakfast.
- **"1 can" of something sold by weight or volume reads as one package**, flagged as an
  estimate to confirm, like a cup of flour (§6 rule 3).
- **A recipe site answering 401/403 gets its own message.** Several large sites (in
  testing: AllRecipes, Simply Recipes, Budget Bytes, Cookie and Kate) refuse any client
  that is not a full browser; the app says the site refused rather than showing a status
  code. BBC Good Food and RecipeTin Eats imported fine.
- **The builder and the import review ask before Back discards their work**; their own
  Save and Cancel never ask. See `src/app/shared/discard-guard.ts`.

## Today

- **A row's Swap replaces that one meal**, holding every other placed meal where it is
  (slots a partial plan left empty are re-solved too). §10 lists Swap as a row action but
  describes it as "regenerates only unpinned slots", which is what Generate already does
  on a planned day; so on a planned day that button reads **Re-plan unpinned meals**, and
  the row action is the narrower one. Swap is disabled on pinned and cooked rows.
- **A card identical to the day's current plan is not offered.** The planner is
  deterministic (§13.7), so without this, re-planning a day that was planned from the top
  card would offer that same day again as the first choice.
- **Changing the meal or snack count makes a new plan** and soft-deletes the old one, pins
  included (see `PlansRepo`); the screen says so before you choose. Once a slot is cooked
  the counts are locked, so a cooked meal is never dropped with its plan.
- **The date selector stops at today.** §10 allows forward navigation; a past day's plan
  would only be a diary, which §13.5 rules out.
- **The planner runs on the UI thread.** It is synchronous and ~130 ms on a 200-meal
  library on the laptop; a worker would add a message boundary and nothing you could feel.
  Re-measure on a mid-range phone before moving it (Phase 3's < 1 s criterion).

- **Mark cooked is a third row button**, beside Pin and Swap. It uses
  `PlansRepo.cook`, which checks the slot is still uncooked inside the same transaction as
  the decrement, so a double tap cannot take two servings. Undo lasts 10 s (§10); the
  pantry's Remove keeps its 5 s.
- **Today refills its inputs when their source changes**: a new date, a plan appearing or
  going, or new Settings defaults. Otherwise, going back to the tab keeps what was typed.

## Settings and your data

- **Settings save as you change them**, with no Save button. A blank or out-of-range
  number keeps the stored value and says so.
- **The export is every row of every table, soft-deleted rows included**, as
  `meal-planner-YYYY-MM-DD.json` with a format tag and the schema version. It is a dump,
  so nothing the app knows is missing. **The USDA API key is left out**: it is a
  credential, and the file exists to be shared. On the phone it goes through the share
  sheet; the browser build shares it where it can and downloads it where it cannot.
- **Delete all data soft-deletes** every row (§2), and puts settings back to their
  defaults, which also forgets the USDA key. The starter library does **not** come back
  on the next launch: its version stays recorded, and the person asked for an empty app.
- **USDA search runs on a tap** ("Search USDA for …"), never per keystroke: every query
  spends the person's own API quota. Energy is nutrient 1008 as §7 says, falling back to
  the Atwater figures (2048, then 2047) that Foundation Foods carry instead. A picked
  food opens the product form with no package size, since USDA describes foods, not
  packages. The item that §7 describes as the product picker is the catalog search, which
  both the pantry and the Meal Builder use.

## Look and navigation

- **Ionic's palette with the MetrumDigital teal as primary**, not `@metrum/ui` theming:
  Ionic's components read `--ion-*` variables, which the suite themes do not set. Dark
  mode follows the system (`dark.system.css`).
- **Today is the landing tab.** It is what the app is opened for, and the seeded library
  gives it something to plan with before the person has entered anything.

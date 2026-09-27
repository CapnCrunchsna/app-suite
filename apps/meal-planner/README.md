# Meal Planner

Pantry-constrained daily meal plans: you keep a pantry and a meal library, set a calorie
and protein budget, and the app proposes days built only from what you actually have.
Ionic + Angular + Capacitor, Android first, all data on the device.

- **Contract:** [`docs/meal-planner-spec.md`](../../docs/meal-planner-spec.md). It is
  normative and wins over everything else, including this file.
- **Why it is shaped this way:** `../../../artifacts/plans/pantry-meal-planner-design.md`
  in the workspace.
- **Choices the spec left open:** [`DECISIONS.md`](DECISIONS.md).

## Layout

```
apps/meal-planner/          this app: pages, the Capacitor adapters, android/
libs/meal-planner/domain/   planner, nutrition, units, depletion — pure TS
libs/meal-planner/data/     schema, migrations, repositories over a SqlDb port
libs/meal-planner/import/   Open Food Facts, USDA, recipe-URL import — pure TS
```

## Running it

In the browser (the PWA build, for testing): start the `meal-planner` launch config, or

```bash
npx nx serve meal-planner
```

and open http://localhost:4203. The web build keeps its SQLite database in IndexedDB.

On Android (needs the SDK and JDK 21 set up as in `games/chip-away/scripts/README.md`):

```bash
npx nx run meal-planner:cap-sync
```

then build and install from `apps/meal-planner/android` with `./gradlew assembleDebug`,
or open that folder in Android Studio.

## Status

| Phase | State |
|---|---|
| 0 — Scaffold | Done. Boots on web and on the Android emulator; schema v1 migrates on both. |
| 1 — Products & pantry | Done, bar one check. Verified in the browser (typed barcodes through Open Food Facts, bulk scan with review, remove/undo, edit, catalog) and on the emulator (camera permission flow, scan overlay over a live preview, manual add persisting across restarts). **Still needs a real phone:** scanning an actual barcode, and the airplane-mode fallback. |
| 2 — Meal library | Not started |
| 3 — Planner | Engine done ahead of its UI: T5–T7 pass in `libs/meal-planner/domain` |
| 4 — Depletion & polish | Not started |

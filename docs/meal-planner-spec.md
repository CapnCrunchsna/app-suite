# Pantry Meal Planner — v1 Implementation Specification

**Type:** Plan · **Date:** 2026-07-06, revised 2026-09-27 · **Project:** Meal Planner App
**Companion:** `../../artifacts/plans/pantry-meal-planner-design.md` (design rationale). **If the two conflict, this spec wins.**

This spec lives beside the code it governs (`app-suite/docs/`) and lands in the same commits.
The 2026-09-27 revision, made as implementation began, fixed what building it exposed: §2
drops the `ui` lib and pins the `data` lib's storage port, §7 drops a contact email from a
request header, §8.1 reorders a regex whose fraction branch could never match, §9 defines
level 3 exactly, §10 caps the meal stepper at the three meal types that exist, and §14 T7
gets numbers.

## 0. How to use this document

This spec is written for an implementer (human or model) who was not part of the design
session. Follow it literally.

- Build the phases in §12 **in order**. Do not start a phase before the previous phase's
  acceptance criteria pass.
- Anything not listed in this spec is **out of scope**. Do not add features, screens,
  settings, or dependencies beyond those named here. §13 lists explicit prohibitions.
- Where the spec gives exact numbers (weights, thresholds, golden tests), implement them
  exactly. Golden tests in §14 must pass with the exact expected values.
- If something is genuinely unspecified, choose the **simplest** option consistent with
  §13, and record the choice in a `DECISIONS.md` at the app root.
- Package *versions* are not normative (use current stable); package *choices* and the
  project structure are normative.

## 1. Product summary

A mobile app (Android first, iOS once a Mac is available to build it, plus a PWA build
used for testing). The user maintains a
**pantry** (foods they own), a **meal library** (their meals with ingredients), and a
daily **calorie + protein budget**. The app generates candidate day plans — combinations
of meals from the library that fit the budget using only food actually in the pantry.
The user can pin a specific meal ("I want tacos today") and regenerate the rest.
Cooking a meal decrements its ingredients from the pantry.

Single user. All data on-device. No accounts, no backend, no LLM.

## 2. Workspace and project structure

Nx monorepo (the existing MetrumDigital workspace standard), Angular with Ionic
standalone components, Capacitor for native builds.

```
apps/meal-planner/            Ionic Angular app + Capacitor config (android/), the
                              Capacitor adapters (SQLite, HTTP, scanner), pages, and
                              presentational components under src/app/components/
libs/meal-planner/domain/     Pure TS, no Angular imports: entities, unit logic,
                              nutrition math, planner engine, depletion
libs/meal-planner/data/       Pure TS: schema, migrations, repositories, seed loader —
                              written against a `SqlDb` port, never a driver
libs/meal-planner/import/     Pure TS: OFF client, USDA client, recipe URL importer,
                              ingredient parser, product matcher
```

There is no `ui` lib: one app consumes these components, and an Angular component lib in
this workspace needs its own ng-packagr build (see `libs/shared/ui/README.md`). Extract
one when a second consumer exists.

The `data` lib owns every SQL statement but no driver. The app supplies a `SqlDb` over
`@capacitor-community/sqlite`; the lib's tests supply one over `better-sqlite3` (already a
workspace dependency), so migrations, repositories and the §11 decrement run against real
SQLite in Node.

Key dependencies:

| Purpose | Package |
|---|---|
| UI framework | `@angular/*`, `@ionic/angular` (standalone) |
| Native bridge | `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` (`@capacitor/ios` when iOS starts) |
| Barcode scanning | `@capacitor-mlkit/barcode-scanning` |
| Storage | `@capacitor-community/sqlite` (+ `jeep-sqlite` for the web build) |
| HTTP that bypasses CORS on device | `CapacitorHttp` from `@capacitor/core` |
| Unit tests | Vitest via Nx defaults (`better-sqlite3` for the `data` lib's port) |

Rules:
- `domain` and `import` libs must have **zero** Angular/Ionic/Capacitor imports so their
  logic is unit-testable in Node. Network and storage are injected as interfaces.
- All timestamps: ISO 8601 UTC strings. All IDs: UUID v4 strings generated on device.
- Soft delete only: set `deleted_at`; never hard-DELETE rows (future sync requirement).

## 3. Database schema (SQLite DDL — normative)

```sql
CREATE TABLE products (
  id              TEXT PRIMARY KEY,          -- UUID v4
  barcode         TEXT,                      -- nullable; not all products have one
  name            TEXT NOT NULL,
  brand           TEXT,
  package_unit    TEXT NOT NULL CHECK (package_unit IN ('COUNT','G','ML')),
  package_amount  REAL NOT NULL,             -- e.g. 12 (COUNT), 500 (G), 2000 (ML)
  nutrition_basis TEXT NOT NULL CHECK (nutrition_basis IN ('PER_100','PER_UNIT')),
  kcal            REAL,                      -- per 100 g/ml, or per single unit
  protein_g       REAL,                      -- same basis as kcal
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('off','usda','manual','seed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_products_barcode ON products(barcode);

CREATE TABLE pantry_items (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  quantity    REAL NOT NULL,                 -- in the product's base unit:
                                             -- COUNT -> units, G -> grams, ML -> ml
  expires_on  TEXT,                          -- YYYY-MM-DD, nullable (v1: stored, unused)
  acquired_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE meals (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  servings       REAL NOT NULL DEFAULT 1,    -- servings the ingredient list yields
  slots          TEXT NOT NULL,              -- JSON array, subset of
                                             -- ["breakfast","lunch","dinner","snack"]
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','import','seed')),
  source_url     TEXT,
  kcal_per_serving    REAL NOT NULL,         -- cached; recompute on ingredient change
  protein_per_serving REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE meal_ingredients (
  id           TEXT PRIMARY KEY,
  meal_id      TEXT NOT NULL REFERENCES meals(id),
  product_id   TEXT,                         -- nullable: unmapped / to-taste lines
  quantity     REAL,                         -- in unit below; null if to_taste
  unit         TEXT CHECK (unit IN ('COUNT','G','ML')),
  display_text TEXT NOT NULL,                -- original human text, e.g. "2 cups flour"
  to_taste     INTEGER NOT NULL DEFAULT 0,   -- 1 = exclude from nutrition & feasibility
  position     INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  plan_date      TEXT NOT NULL,              -- YYYY-MM-DD; UNIQUE among non-deleted
  kcal_budget    REAL NOT NULL,
  protein_target REAL NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE plan_slots (
  id        TEXT PRIMARY KEY,
  plan_id   TEXT NOT NULL REFERENCES plans(id),
  slot_type TEXT NOT NULL CHECK (slot_type IN ('breakfast','lunch','dinner','snack')),
  position  INTEGER NOT NULL,
  meal_id   TEXT,                            -- assigned meal, nullable
  pinned    INTEGER NOT NULL DEFAULT 0,
  cooked_at TEXT,                            -- set when user marks it cooked
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (                      -- single-row-per-key store
  key   TEXT PRIMARY KEY,                    -- e.g. 'default_kcal_budget',
  value TEXT NOT NULL                        -- 'default_protein_target',
);                                           -- 'default_slots', 'usda_api_key'
```

**Base-unit rule (critical):** every stored quantity is in `COUNT`, `G`, or `ML`. Cups,
tbsp, oz, etc. are converted at the input boundary (§6) and never stored — only echoed
back via `display_text`.

## 4. Nutrition math (exact)

For an ingredient with quantity `q` in base unit and its product `p`:

- `nutrition_basis = 'PER_UNIT'` (only valid for COUNT products):
  `kcal = q × p.kcal`, `protein = q × p.protein_g`
- `nutrition_basis = 'PER_100'` (G or ML products):
  `kcal = (q / 100) × p.kcal`, `protein = (q / 100) × p.protein_g`
- `to_taste = 1` or `product_id IS NULL`: contributes **0** kcal / 0 protein.

Meal per-serving values: sum over ingredients ÷ `servings`. Round only for display
(nearest whole kcal, protein to 1 decimal); store unrounded.

## 5. Pantry feasibility (exact)

A meal is **makeable** if for every ingredient with `to_taste = 0` and a non-null
`product_id`, total non-deleted pantry quantity of that product ≥ ingredient quantity
(for 1 serving of the meal: ingredient quantities are for the full recipe, so per-serving
need = `quantity / servings`; planning consumes exactly **1 serving** per slot in v1).
A *plan* is feasible only if the summed per-serving needs across all its meals fit the
pantry (a shared ingredient must cover all meals that use it, together).

## 6. Units and conversions

Canonical volume: 1 tsp = 5 ml, 1 tbsp = 15 ml, 1 fl oz = 30 ml, 1 cup = 240 ml.
Canonical mass: 1 oz = 28.35 g, 1 lb = 453.6 g.

Volume→mass needs a density. Ship this table as a constant (grams per US cup); scale
linearly for tsp/tbsp/fl-oz via the volume ratios above:

| Food (match by token) | g/cup | | Food | g/cup |
|---|---|---|---|---|
| flour | 120 | | rolled oats | 90 |
| sugar (granulated) | 200 | | brown sugar | 220 |
| rice (uncooked) | 185 | | butter | 227 |
| peanut butter | 256 | | honey | 340 |
| shredded cheese | 113 | | cocoa powder | 100 |

Conversion policy at input time:
1. Target product is ML-based and input is volume → convert directly.
2. Target product is G-based and input is mass → convert directly.
3. Target product is G-based and input is volume → look up density table by token match
   on the product name; if found, prefill the gram value **but require user confirmation**;
   if not found, ask the user for grams.
4. Target product is COUNT-based → input must be a count; anything else asks the user.

## 7. Barcode scanning and product lookup

Flow for a single scan (`@capacitor-mlkit/barcode-scanning`, camera permission requested
on first use with a one-line explanation):

1. Barcode string → look up local `products.barcode`.
2. **Hit:** show "Add ⟨name⟩ to pantry" sheet: quantity stepper (default 1 package),
   optional expiration date. Confirm → insert `pantry_items` row with
   `quantity = packages × package_amount`.
3. **Miss:** GET
   `https://world.openfoodfacts.org/api/v2/product/{barcode}?fields=product_name,brands,quantity,serving_size,nutriments`
   with header `User-Agent: MetrumMealPlanner/<version> (<contact>)` on native (browsers
   refuse to let a page set `User-Agent`, and OFF's API serves CORS, so the web build uses
   plain `fetch`). The contact is one constant in the app, and it is a project URL, not
   anyone's email address — every install would send it.
   Response `status == 1` → prefill the product form: `name` ← `product_name`,
   `brand` ← `brands`, kcal/protein ← `nutriments["energy-kcal_100g"]` /
   `nutriments["proteins_100g"]` with `nutrition_basis='PER_100'`; parse `quantity`
   (e.g. `"500 g"`, `"1 L"`, `"12"`) into `package_amount`/`package_unit`, leaving
   blank if unparseable. User reviews → save product (`source='off'`) → step 2 sheet.
4. **OFF miss or offline:** open the blank manual product form (same form, `source='manual'`).
   The form must be completable in under ~20 seconds: name, package unit/amount, kcal,
   protein, optional barcode (pre-filled from the scan).

**Bulk scan mode:** continuous camera session; each recognized barcode is added as
1 package using steps 1–3 (unknown products queue for review instead of interrupting);
running count shown; "Done" opens a review list (edit quantities, resolve queued
unknowns, remove mistakes) before committing all rows in one transaction.

**USDA FoodData Central (optional):** only if the user has entered an API key in
Settings. Used for *generic* food search in the product picker:
`GET https://api.nal.usda.gov/fdc/v1/foods/search?api_key=…&query=…&pageSize=10`.
Map kcal (nutrient 1008) and protein (nutrient 1003) per 100 g. No key → hide the option.

Cache every successful OFF/USDA result as a local product row; never re-fetch a barcode
that exists locally.

## 8. Recipe URL import

Platform note: recipe sites do not send CORS headers. Fetch pages with `CapacitorHttp`
(native). On the web/PWA build, if the fetch fails for CORS reasons, show
"URL import requires the mobile app" — do **not** ship a proxy.

Pipeline:

1. **Fetch** the URL (follow redirects, 15 s timeout).
2. **Extract JSON-LD:** collect every `<script type="application/ld+json">` block; parse
   each (tolerate arrays and `@graph` wrappers); find the first object whose `@type` is
   `"Recipe"` or contains `"Recipe"`. None found → error "No recipe found on this page"
   (v1 does not fall back to HTML scraping).
3. **Extract fields:** `name`; `recipeYield` (first integer found in it, default 1);
   `recipeIngredient` (array of strings); `nutrition.calories` / `nutrition.proteinContent`
   if present (numbers extracted from strings like `"240 calories"`).
4. **Parse each ingredient string** (§8.1).
5. **Match each parsed ingredient to a product** (§8.2).
6. **Review screen** (§10, Import Review) — nothing is saved until the user confirms.
   On confirm: create any "new product" rows, insert the meal (`source='import'`,
   `source_url` set) and its ingredients; compute nutrition per §4. If site-provided
   nutrition disagrees with computed by >25%, show both and let the user pick which to
   trust (store the choice in the cached per-serving fields; ingredients stay as mapped).

### 8.1 Ingredient parser (exact)

Input: one string. Output: `{ qty: number|null, unit: 'COUNT'|'G'|'ML'|null,
rawUnit: string|null, name: string, note: string|null, toTaste: boolean }`.

1. Trim; collapse whitespace. Replace unicode fractions (¼ ½ ¾ ⅓ ⅔ ⅕ ⅛) with decimals;
   `"1 ½"` and `"1 1/2"` both → `1.5`.
2. If the line matches `/to taste|for serving|for garnish|optional/i` → `toTaste = true`,
   and remove the matched phrase (with any comma before it) from the line.
3. Extract a parenthetical `\(([^)]*)\)` into `note` and remove it (e.g. `"(15 oz)"`),
   then collapse whitespace again.
4. Match leading quantity: `/^(\d+\/\d+|\d+(?:\.\d+)?)/` (fractions like `3/4` → 0.75).
   The fraction branch comes first: alternation takes the first branch that matches, so
   with the decimal branch first, `3/4` parses as `3`.
5. Match the next token against the unit table (case-insensitive, plural-tolerant):
   `cup(s)→cup, tablespoon(s)|tbsp→tbsp, teaspoon(s)|tsp→tsp, fl oz→floz,
   ounce(s)|oz→oz, pound(s)|lb(s)→lb, gram(s)|g→g, kilogram(s)|kg→kg, milliliter(s)|ml→ml,
   liter(s)|l→l, can(s)→can, slice(s)→slice, clove(s)→clove, pinch(es)→pinch`.
   Convert to base per §6 (`cup/tbsp/tsp/floz/ml/l → ML`, `oz/lb/g/kg → G`,
   `can/slice/clove/pinch → COUNT`), keeping the original in `rawUnit`. A quantity with
   no unit token is `COUNT` with `rawUnit = null`; no quantity at all leaves `qty`, `unit`
   and `rawUnit` null.
6. Strip a leading `of `; text before the first comma is `name`, after it appends to
   `note` (e.g. `", drained"`; several note parts join with `"; "`). `name` is lowercased
   and trimmed.

Golden cases (must pass exactly — see §14 T3).

### 8.2 Product matcher (exact)

- Normalize both ingredient `name` and product names: lowercase, strip punctuation,
  split on whitespace, drop stopwords
  `{fresh, large, small, medium, chopped, diced, shredded, sliced, minced, drained,
  rinsed, cooked, raw, of, the, a, an}`.
- Score = Jaccard similarity of the token sets: `|A ∩ B| / |A ∪ B|`.
- **Auto-map** when top score ≥ 0.5 **and** (top − second) ≥ 0.2. Otherwise the review
  screen shows the top 5 candidates plus "Search…", "Create new product",
  and "Mark as to-taste".

## 9. The planner engine (exact)

Pure function in `domain`:

```
generatePlans(input: {
  kcalBudget: number, proteinTarget: number,
  slots: SlotType[],                       // e.g. ['breakfast','lunch','dinner','snack']
  pinned: Map<slotIndex, mealId>,
  meals: Meal[], pantry: PantrySnapshot
}) -> { level: 0|1|2|3, plans: RankedPlan[] }   // up to 3 plans
```

**Constraint levels** — evaluate level 0 first; return the first level that yields ≥ 1 plan:

| Level | Calorie window (total kcal) | Protein constraint |
|---|---|---|
| 0 | `[0.9 × B, B]` inclusive | `total ≥ 0.9 × T` |
| 1 | `[0.8 × B, B]` inclusive | `total ≥ 0.9 × T` |
| 2 | `[0.8 × B, B]` inclusive | none (flag the deficit in the result) |
| 3 | Best effort, exactly one plan: see below | none |

**Level 3 (exact):** place each pinned meal first, if it is still feasible against the
pantry and fits the remaining budget. Then, for each unpinned slot in list order, take
the eligible, not-yet-used, still-feasible meal with the **highest** `kcal_per_serving`
that fits the remaining budget (ties: input order), reserving its ingredients. A slot
with no such meal stays empty, and the plan is flagged partial. It is scored with the
formula below using `lo = 0`.

**Candidate generation:** meals that are makeable (§5), filtered per slot by eligibility
(`slot_type ∈ meal.slots`). A meal may appear **at most once** per plan. Per slot, if
more than 40 candidates, keep the 40 whose `kcal_per_serving` is closest to
`slotShare × B`, where slotShare is: breakfast 0.25, lunch 0.30, dinner 0.35, and the
remaining 0.10 split equally among snack slots. (If the slot list differs from B/L/D,
normalize the shares of the present types to sum to 1.)

**Search:** depth-first over slots in list order. Pinned slots are fixed (their meal is
always a candidate even if slot-ineligible; pantry feasibility still applies). Maintain
a running ingredient-reservation map; skip a meal whose per-serving needs exceed
remaining pantry. Prune a branch when
`runningKcal + Σ min-candidate-kcal(remaining slots) > B`. Hard cap: 50,000 nodes
visited per level; on hitting the cap, proceed with plans found so far.

**Scoring** (per complete plan; window bounds `lo` per the active level):

```
calorieScore = 1 − (B − totalKcal) / (B − lo)          // 1.0 at budget, 0.0 at window floor
proteinScore = min(totalProtein / proteinTarget, 1.0)
score        = 0.6 × calorieScore + 0.4 × proteinScore
```

**Diversity selection:** sort passing plans by score descending, cap the pool at 10.
Greedily pick up to 3: first the top plan; each subsequent pick maximizes
`score − 0.1 × Σ_selected |sharedMeals(plan, selectedPlan)|`. Ties: earlier in the
sorted pool wins.

**Regenerate with pins:** identical call with `pinned` filled from slots the user locked;
assigned-but-unpinned slots are cleared and re-solved.

**Determinism:** no randomness anywhere. Same inputs → same outputs (required for §14).

## 10. Screens (Ionic tabs; v1 complete list)

Tab bar: **Pantry · Meals · Today · Settings**. No other top-level navigation.

**Pantry** — searchable list; each row: product name, remaining quantity formatted as
`"9 of 12"` (COUNT), `"420 g of 500 g"` (G), `"1.76 L of 2 L"` (ML). Swipe left →
**Remove** (sets `quantity = 0` and soft-deletes the row; one-tap, no confirm, with a
5-second undo toast). Swipe right → Edit (quantity, expiration). FAB "+" → action sheet:
*Scan barcode / Bulk scan / Search catalog / Add manually*. "Search catalog" searches
local products (+ USDA if key present).

**Meals** — list with name, kcal/protein per serving, and a makeable indicator (✓ or
"missing: X, Y" computed live from pantry). Header buttons: *New meal* (Meal Builder),
*Import from URL* (prompt for URL → Import Review). Meal detail: ingredient list with
`display_text`, per-serving nutrition, Edit, Delete (soft).

**Meal Builder** — fields: name; eligible-slot chips (multi-select, default all four);
servings stepper; ingredient rows = product picker (search + recents) + quantity + unit
picker limited to units valid for that product (§6 rules, with density-confirm dialog
when rule 3 applies); running kcal/protein per serving updates live. Save disabled until
name + ≥ 1 mapped ingredient.

**Import Review** — recipe name (editable), servings (editable), then one row per parsed
ingredient: original string, parsed qty/unit (editable), mapping status —
auto-mapped product (tappable to change), or "Choose…" with the top-5 list / search /
create-new / to-taste. Footer: computed kcal/protein per serving (live), site-claimed
values if present, Save / Cancel. Nothing persists on Cancel.

**Today** — date selector (default today; forward navigation allowed, plans are
per-date). Inputs: kcal budget, protein target (prefilled from settings defaults), slot
configuration (steppers: meals 1–3 → mapped to breakfast/lunch/dinner in order, snacks
0–3; three is the ceiling because those are the meal types that exist). **Generate** → up to 3 plan cards, each showing per-slot meals + totals
(`1980 kcal · 103 g protein`) and the constraint level if > 0 ("relaxed calories",
"protein short by Ng", "partial"). Selecting a card assigns it to the date. Assigned
view: one row per slot with meal name and kcal; row actions: **Pin/Unpin**, **Swap**
(regenerates only unpinned slots), **Mark cooked**. Mark cooked → decrement per §11,
snackbar "Pantry updated" with **Undo** (10 s, restores exact quantities).

**Settings** — default kcal budget (default 2000), default protein target (default
100 g), default slots (3 meals + 1 snack), USDA API key (optional), Export data (share a
JSON dump of all tables), Delete all data (typed confirmation "DELETE"). Nothing else.

## 11. Depletion (v1 behavior, exact)

On **Mark cooked** for a slot's meal: for each ingredient with `to_taste = 0` and a
product mapping, `need = quantity / servings` (one serving). Decrement pantry items of
that product, oldest `expires_on` first (nulls last), then oldest `acquired_at`;
clamp each row at 0 (soft-delete rows that reach 0). If total available < need, decrement
to zero anyway and include "⟨product⟩ ran short" in the snackbar. Set `cooked_at`.
Cooking is per-slot and idempotent (a cooked slot's button becomes disabled).

The pantry swipe-**Remove** (§10) is the only other depletion mechanism in v1. The
richer flows (per-ingredient "used it up / still have some", leftovers-as-pantry-items,
reconcile mode, expiration-aware planning) are **fast-follow — do not build them in v1.**

## 12. Build phases and acceptance criteria

**Phase 0 — Scaffold.** Nx app + libs per §2; SQLite schema §3 with a migration runner
(versioned, forward-only); tab shell renders on web; Capacitor builds run on at least
one native platform. ✓ when: `nx test` green, app boots with empty tabs.

**Phase 1 — Products & pantry.** Product CRUD, manual add, single scan flow (§7), bulk
scan, OFF integration + caching, pantry list with quantity formatting, remove/undo,
edit. ✓ when: scan a real barcode → pantry row appears with correct nutrition; airplane
mode → manual form fallback works; T1 tests pass.

**Phase 2 — Meal library.** Meal Builder with live nutrition (§4), seed content (§15)
loaded on first launch, URL import pipeline (§8) end-to-end with Import Review.
✓ when: T2 + T3 + T4 pass; importing a real recipe URL yields a saved meal with ≥ 80%
of ingredients auto-mapped or user-resolved.

**Phase 3 — Planner.** Engine per §9 in `domain` with zero UI dependencies; Today screen
with generate/assign/pin/swap. ✓ when: T5 + T6 pass byte-exact; generating on a
200-meal library completes < 1 s on a mid-range phone.

**Phase 4 — Depletion & polish.** Mark cooked (§11) with undo; Settings; data export;
empty states for every screen (each names the action that fills it, e.g. pantry empty
state has a Scan button). ✓ when: T7 passes; a full loop (scan → build meal → generate →
pin → cook → pantry decremented) works on device.

## 13. Hard prohibitions

1. **No LLM or AI-service calls of any kind.** Not optional, not behind a flag.
2. **No backend, no accounts, no auth, no analytics/telemetry.** Only permitted network
   calls: Open Food Facts, USDA FDC (only with user-provided key), user-initiated recipe
   URL fetches.
3. **No hard DELETEs** of user data rows; soft-delete only. No schema drift from §3
   without a migration.
4. **No storing non-base units.** `COUNT`/`G`/`ML` only; originals live in `display_text`.
5. **No food diary / logging features** (weight tracking, streaks, historical calorie
   charts). The product is pantry-constrained planning, not diet logging.
6. **No gram-perfect inventory ambitions:** never block a flow to demand precise
   quantities; estimates and defaults always acceptable.
7. **No randomness in the planner.**
8. **No features beyond this spec** (shopping lists, multi-day planning, leftovers,
   reconcile mode, receipt OCR, household sync are all explicitly future).

## 14. Required golden tests (unit tests in `domain`/`import`)

**T1 — Nutrition math.** Product eggs: COUNT, PER_UNIT, kcal 70, protein 6. Product
milk: ML, PER_100, kcal 42, protein 3.4. Meal "test" servings 1 with 2 eggs + 240 ml
milk → kcal = `2×70 + 2.4×42 = 240.8`, protein = `2×6 + 2.4×3.4 = 20.16`.

**T2 — Decrement.** Pantry: eggs qty 9, milk qty 2000. Cook a 1-serving meal using
2 eggs + 240 ml milk → eggs 7, milk 1760. Cook a 2-serving meal (4 eggs listed,
servings 2) → decrements 2 eggs → 5.

**T3 — Ingredient parser.**
| Input | qty | unit | name | flags/note |
|---|---|---|---|---|
| `2 cups shredded cheddar cheese` | 480 | ML→(density confirm) | `shredded cheddar cheese` | rawUnit `cup` |
| `1 (15 oz) can black beans, drained` | 1 | COUNT | `black beans` | note `15 oz; drained` |
| `3 large eggs` | 3 | COUNT | `large eggs` | — |
| `½ cup milk` | 120 | ML | `milk` | — |
| `1 1/2 lbs ground beef` | 680.4 | G | `ground beef` | — |
| `Salt to taste` | null | null | `salt` | toTaste = true |

**T4 — Matcher.** Ingredient `shredded cheddar cheese` vs products
[`Cheddar Cheese Block`, `Mozzarella`, `Milk`]: normalized tokens {cheddar, cheese} vs
{cheddar, cheese, block} → Jaccard 2/3 ≈ 0.667; second-best 0 → auto-map to
`Cheddar Cheese Block`.

**T5 — Planner, level 0.** Meal library (kcal, protein, slots — all makeable, ample pantry):
Oatmeal & banana (350, 12, B); Scrambled eggs (250, 13, B); PB&J (400, 15, B+L);
Chicken & rice (600, 45, L+D); Tuna sandwich (450, 30, L); Spaghetti bolognese
(700, 35, D); Greek yogurt (150, 15, S); Apple + peanut butter (280, 8, S).
Input: budget 2000, protein 100, slots [B, L, D, S], no pins.
Expected: level 0; exactly 5 passing plans with scores —

| Plan (B/L/D/S) | kcal | protein | score |
|---|---|---|---|
| PB&J / Chicken&rice / Spaghetti / Apple+PB | 1980 | 103 | **0.94** |
| Oatmeal / Chicken&rice / Spaghetti / Apple+PB | 1930 | 100 | 0.79 |
| PB&J / Chicken&rice / Spaghetti / Greek yogurt | 1850 | 110 | 0.55 |
| Eggs / Chicken&rice / Spaghetti / Apple+PB | 1830 | 101 | 0.49 |
| Oatmeal / Chicken&rice / Spaghetti / Greek yogurt | 1800 | 107 | 0.40 |

Diversity pick (k = 3) returns rows 1, 2, 3 in that order.

**T6 — Planner, pinned + relaxation.** Same library/inputs, lunch pinned to Tuna
sandwich. Level 0 yields nothing. Expected: level 1; top plan by raw score is
PB&J / Tuna / Chicken&rice / Apple+PB — 1730 kcal, 98 protein, calorieScore
`1 − 270/400 = 0.325`, score `0.6×0.325 + 0.4×0.98 = 0.587`.

**T7 — Plan feasibility.** Pantry has 3 eggs only. Meals A and B are each (500 kcal,
30 g protein, slots L+D) and each needs 2 eggs per serving; they are the whole library.
Budget 1000, protein 60, slots [L, D]. With ample eggs A+B is a level-0 plan (1000 kcal,
60 g, score 1.0). With 3 eggs no plan may contain both, so levels 0–2 find nothing and
the result is level 3: lunch = A, dinner empty, partial, 500 kcal. With 4 eggs the
level-0 plan returns.

**T8 — JSON-LD extraction.** Fixture HTML containing an `@graph` array with a `Recipe`
object → name, yield, and ingredient strings extracted; fixture with no recipe → the
exact error "No recipe found on this page".

## 15. Seed content

Ship `assets/seed/products.json` and `assets/seed/meals.json`, loaded once on first
launch (`source='seed'`; seeds are editable and soft-deletable like anything else).
~25 generic products (USDA-typical values) and ~24 meals covering all four slots
roughly evenly — plain, recognizable staples (oatmeal, scrambled eggs, PB&J, grilled
chicken + rice, spaghetti bolognese, tuna sandwich, yogurt, fruit + nut butter, etc.).
Every seed meal's ingredients must map to seed products so the planner works on first
launch with zero user input. Include the eight T5 meals with exactly the T5 numbers, so
the golden tests double as seed validation.

## 16. Explicitly future (do not build, but do not preclude)

Multi-day planning with inventory carry-forward; shopping list with checkoff → pantry;
leftovers as pantry items; per-ingredient post-cook adjustments; reconcile mode;
expiration-aware "use it up" scoring; household sync via backend (the soft-delete +
UUID + timestamp discipline in §2–3 exists for this); recipe search APIs; receipt OCR;
voice entry; optional gracefully-degrading LLM assist for meal drafting.

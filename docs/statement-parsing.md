# Statement parsing — what is built, how to run it, how to add a bank

Implementation notes for the CSV ingest path: the three libs it lives in, the format-profile
schema, the CLI, the places this code deliberately departs from `ledgerline-spec.md`, and an
honest list of what has never been run against a real statement. Companion to the spec, which
remains the contract; where this document and the spec disagree, the disagreements are listed
in §5 and are deliberate.

## 1. Status

Built: the `ingest → detect → parse → normalize` half of §2.5's pipeline, for **CSV only**.

| Piece | State |
|---|---|
| Nx workspace, `libs/ledgerline/{domain,parsing,normalize}` with §2.2 tags and `depConstraints` | done, lint-enforced |
| `collapse_v1` and the dedupe key (§3.3) | done, frozen, golden-tested |
| Money as signed integer cents; ISO dates; `effective_date` (§3.1, §7.1) | done |
| Header-signature detection and format profiles (§2.5 `detect`) | done |
| `NodeCsvParser` (§2.5 `parse`) | done |
| Seven-stage merchant chain (§4.1), deterministic stages only | done |
| `ParserPort` seam (§2.5) | done, one implementation registered |
| Running-balance reconciliation (§6.1), plus a sign-plausibility check for deposit accounts | done |
| PDF ingest | **not built** — v0.4 |
| UI (§6) | Angular shell scaffolded since — wireframe only, no pages. See `apps/ledgerline-ui/README.md`. |
| SQLite schema (§3.1, §3.2), idempotent re-import (§3.3), the API (§2.3) | built since, 2026-08-06, in `libs/ledgerline/data` and `apps/ledgerline-api` |
| LLM stage of §4.2, the analyzers of §5 | **not built** — out of scope for this build |

**Nothing in these three libs writes anywhere**, and that is still true now that a database
exists. Every entry point here takes values and returns values, per §2.1's "libs compute; the
app persists"; `libs/ledgerline/data` is the only lib that knows a store exists, and §2.2's
boundary lint refuses a `parsing → data` or `normalize → data` edge outright. The composition
root that joins them is `apps/ledgerline-api`.

## 2. Running it

```bash
npm install
npm run build
```

Parse a statement:

```bash
node tools/parse-statement.mjs fixtures/statements/northgate-checking-2026-01.csv
```

Useful flags: `--json` for the full machine-readable result (including each row's `dedupeKey`
and normalized merchant), `--trace <n>` to print the per-stage normalization trace for one row,
`--profile <id|path>` to force a profile instead of matching on the header signature, and
`--account <id>` to set the account id that dedupe keys are computed against.

The full pipeline — boundary lint, typecheck, tests — is:

```bash
npm run check
```

`lint` is part of that pipeline on purpose. §2.2 calls the module boundaries "the single most
load-bearing piece of the design", and notes that "a lint rule that nobody runs is not
enforcement".

## 3. Where real statements go

`data/` and `*.sqlite` are already in `.gitignore`. **Put real statements in `data/`**, never in
`fixtures/` — everything in `fixtures/` is committed. The files under `fixtures/statements/` are
synthetic and contain no real financial data.

## 4. Format profiles

A profile is JSON in `profiles/`, keyed on the hash of the header row. Fields mirror the
`format_profile` table in §3.1, so persisting one later is a column-for-column write.

| Field | Meaning |
|---|---|
| `id` | Unique. Used by `--profile` and recorded on the parse result. |
| `institution` | Display only. |
| `accountTypeHint` | `checking` · `savings` · `credit_card` · `null`. |
| `headerSignature` | sha256 of the normalized header tokens. Generated — do not type it by hand. |
| `headerTokens` | The normalized tokens, kept for fuzzy matching and diagnostics. |
| `hasHeader` | `false` means address every column by index. |
| `delimiter` | One character. |
| `skipLines` | Preamble rows to drop before the header. Blank lines do not count. |
| `dateFormat` | Explicit, never sniffed. Tokens: `YYYY` `YY` `MMM` `MM` `M` `DD` `D`, any literal separators. |
| `amountMode` | `single` (one signed column) or `debit_credit` (two unsigned columns). |
| `signConvention` | `as_is` or `invert`, applied *after* the mode produces a signed number. |
| `columnMap` | Role → column. A bare string is a header name, a bare number is a zero-based index. |
| `pendingValues` | Values in the status column meaning "not settled". Compared case-insensitively. |

Roles: `transactionDate`, `postedDate`, `description`, `amount`, `debit`, `credit`, `balance`,
`status`. `description` is required, and at least one of `transactionDate` / `postedDate`.

### The sign convention, which is the part that matters

§3.1 requires **negative = money leaving the account**, uniformly across checking and credit
cards. Banks do not agree, and the profile is where the disagreement is absorbed so that nothing
downstream ever asks which bank a row came from.

The two axes compose rather than multiplying into per-bank cases:

1. `amountMode` builds a signed number — `single` takes the column as-is; `debit_credit` computes `|credit| − |debit|`.
2. `signConvention: invert` flips it when the bank's idea of positive is the opposite of ours.

A checking export that prints a purchase as `-18.75` is `single` + `as_is`. A credit-card export
that prints the same purchase as `18.75` and a payment as `-500.00` is `single` + `invert`. The
bundled fixtures cover both, plus a `debit_credit` credit union, and a test asserts that a
$500 card payment comes out as `−50000` in checking and `+50000` on the card — equal and
opposite, which is what §2.6's transfer matching needs.

### Adding a bank

Point the tool at the file. An unrecognized header exits with the signature, the located header
line, sample rows, any similar known profiles, and a filled-in starter profile:

```bash
node tools/parse-statement.mjs data/statements/my-bank-2026-01.csv
```

Fill in the `CHANGE ME` fields, save under `profiles/`, and re-run. **Check the reconciliation
line.** If the file has a balance column and the profile is right, you get:

```
✓ running balance reconciles across 11 rows (ascending order)
  the amount column is mapped correctly and no rows are missing
  (this does not verify signConvention; balances look plausible for the account type)
```

That check is the reason to map `balance` even though it is optional — §2.5 notes that a
silently misparsed amount column "poisons every downstream finding, and it is very hard to
notice after the fact". Row order is tried both ways, so you do not need to know whether your
bank exports newest-first.

### What reconciliation cannot tell you

**It cannot verify `signConvention`,** and it is worth understanding why before trusting a
green line. `invert` is applied to the balance as well as the amount — it has to be, or a
credit-card export would never reconcile — so both sides flip together and
`(−b[n]) − (−b[n−1]) === −a[n]` holds exactly as well as the correct orientation. **A profile
with the convention backwards reconciles perfectly and inverts every number in the app.**

The separate check for that is `sign_convention_suspect`, and it only has signal on deposit
accounts: a checking or savings balance is money you have, so if most parsed balances come out
negative the profile is inverted — an account is not overdrawn for a whole statement. Credit
cards are deliberately excluded, because a card balance is a debt that different institutions
print with different signs and a genuine credit balance after a refund is legal; §3.1 fixes the
sign of `amount_cents`, not of `balance_cents`.

So for a **credit card** the sign convention is the one thing you have to eyeball. Confirm that
purchases came out negative and payments positive — the table the CLI prints shows both.

Detection **never auto-applies a profile it is not certain about.** A near match is offered as a
suggestion with a similarity score and nothing else; per plan question 2, confirmation is what
stops a one-column header change from silently re-mapping an amount column.

## 5. Where the code and the spec differ

**Nowhere**, for the parsing path. Building the persistence path later found one place where
the spec contradicts *itself* — §3.3's near-duplicate predicate cannot catch §3.3's own
pending-to-posted example — which is recorded in `ledgerline-spec.md` §10 and left open rather
than silently widened.

Building this found four places where the spec was wrong or unimplementable as
worded; all four were amended in the spec on 2026-08-04 rather than worked around here. See
[`ledgerline-spec.md` §9](ledgerline-spec.md) for the list and the reasoning — in short:
`ParserPort.parse` returning `RawRow[]` could not satisfy §6.1's own review screen; stage 1's
punctuation stripping would have destroyed the markers stage 2 matches on; stage 4's URL rule
resolved `NETFLIX.COM 866-579-7172 CA` to `CA`; and `collapse_v1`'s delete-semantics hashed
`AMAZON - PRIME` differently from `AMAZON PRIME`.

That last one was amended **before the first import**, which is the only moment it was free.
`collapse_v1` now substitutes punctuation with a space rather than deleting it, folds
diacritics, and trims after truncating. No row has ever been keyed under the old wording, so
the name still refers to exactly one definition. **From the first stored row onward that stops
being true**, and any further change means shipping `collapseV2` beside it plus a migration
that recomputes every key in one transaction.

### One implementation choice the spec leaves open

**`collapse_v1` lives in `domain`, not next to the §4 chain.** The spec says where the dedupe
*stage* runs (§2.5: in `data`) but not where the function lives. Putting it in `domain` falls
out of the boundary table: §2.2 lets `type:data-access` depend only on `type:domain`, so `data`
*cannot* reach the normalization chain even if someone wanted it to. That makes the separation
§3.3 demands a property of the module graph rather than a convention someone has to remember —
which matters, because §3.3 calls it "the correctness condition [...] most likely to be
violated by accident."

## 6. What has never been run against a real statement

Per §7.6 — "nothing in §5 has been run against a real statement" — the same honesty applies here,
and more sharply, because **no real CSV was available when this was written**. What that does and
does not mean:

**Validated against synthetic fixtures only, and therefore encoding my assumptions about how
banks behave rather than how yours actually does:**

- The three bundled profiles and the shapes they represent. They were written alongside the fixtures, so they prove the *mechanism* absorbs disagreement — not that any real bank matches one of them.
- Preamble detection, delimiter guessing, and header location.
- The processor-prefix table, the state-code list and the reference-debris patterns in §4.1's stages. These were derived from the three example descriptors in the spec plus common knowledge, and are the single most likely thing to need extending on contact with a real file.

**Genuinely validated, because it does not depend on a bank:**

- The money path: no float anywhere, exact integer sums, every negative form banks print, and loud refusal of ambiguous non-US formatting.
- Date parsing against a declared format, including rejection of impossible calendar dates and the demonstration that `01/02/2026` reads differently under `MM/DD/YYYY` and `DD/MM/YYYY`.
- `collapse_v1` golden values, and the test that growing the normalization chain changes `description_normalized` and leaves the dedupe input untouched — the §3.3 regression.
- The module boundaries, verified by a deliberate violation that lint rejected.

**Uncalibrated numbers**, both marked in the code:

| Constant | Value | Where |
|---|---|---|
| `SIGNATURE_SUGGESTION_FLOOR` | 0.5 | `parsing/detect.ts` — only gates what is *offered*, never what is applied |
| `FUZZY_SIMILARITY_FLOOR` | 0.72 | `normalize/alias.ts` — set conservatively on purpose |

The fuzzy floor is worth understanding before tuning: trigram similarity catches *truncation and
decoration*, which is how descriptors actually vary — `BLUE BOTTLE COFFE` against
`BLUE BOTTLE COFFEE` scores ~0.85. It does not catch typos; `STARBUKS` against `STARBUCKS` scores
~0.58 and stays below the floor deliberately, because a wrong merge is invisible in the findings
while a missed one is one click in the review queue.

**The first thing to do with a real statement** is run the CLI over it and read four things: the
reconciliation verdict, the row count, the warnings, and — for a credit card — whether purchases
came out negative. The first three catch most of the ways this goes wrong; the fourth catches
the one reconciliation is structurally blind to.

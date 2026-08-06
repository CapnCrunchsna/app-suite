-- ---------------------------------------------------------------------------
-- 001 — initial schema
--
-- Every table in ledgerline-spec.md §3.1, with every index and constraint in
-- §3.2. None of §3.2 is optional; the two on `transaction` are load-bearing:
-- `(account_id, dedupe_key)` is the difference between a 200 ms import and a
-- four-minute one, and `UNIQUE (account_id, dedupe_key, occurrence_index)` makes
-- the multiset merge rule a database invariant rather than application
-- arithmetic, so a retried commit cannot double-insert.
--
-- Conventions (§3.1):
--   * Every table carries a surrogate `id`, `created_at` and `updated_at`. The
--     repository layer sets all three on every write; there are deliberately no
--     SQL DEFAULTs for them, so a write that forgets is a NOT NULL failure
--     rather than a silently plausible timestamp. `schema-invariants.spec.ts`
--     asserts the three columns on every table, with no exemptions.
--   * Money is integer cents, signed, negative = money leaving the account.
--     No REAL column anywhere holds money.
--   * Dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 with a `Z`.
--   * Booleans are INTEGER 0/1, constrained.
--   * FOREIGN KEY ... ON DELETE RESTRICT everywhere (§3.2). Cascades would let
--     one bad import delete findings and series silently. Deletion goes through
--     the repository, which writes tombstones (§3.4).
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------- account ---
CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  institution   TEXT,
  account_type  TEXT NOT NULL CHECK (account_type IN ('checking', 'savings', 'credit_card')),
  last4         TEXT,
  currency      TEXT NOT NULL CHECK (currency = 'USD'),
  is_active     INTEGER NOT NULL CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- -------------------------------------------------------------- category ---
CREATE TABLE category (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES category (id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('spend', 'fee', 'transfer', 'income')),
  overlap_group TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX ix_category_parent ON category (parent_id);

-- ---------------------------------------------------- merchant_canonical ---
CREATE TABLE merchant_canonical (
  id                    TEXT PRIMARY KEY,
  canonical_name        TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  website               TEXT,
  default_category_id   TEXT REFERENCES category (id) ON DELETE RESTRICT,
  is_known_subscription INTEGER NOT NULL CHECK (is_known_subscription IN (0, 1)),
  is_transfer_kind      INTEGER NOT NULL CHECK (is_transfer_kind IN (0, 1)),
  overlap_group         TEXT,
  source                TEXT NOT NULL CHECK (source IN ('seed', 'rule', 'llm', 'user')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- Beyond §3.2, and needed by it: §4.1 step 7 turns an unresolved descriptor into
-- a provisional merchant, which is a get-or-create on this column. Without the
-- constraint two concurrent imports of the same new descriptor produce two
-- "canonical" merchants and every §5 rule groups the same merchant twice.
CREATE UNIQUE INDEX ux_merchant_canonical_name ON merchant_canonical (canonical_name);

-- -------------------------------------------------------- merchant_alias ---
CREATE TABLE merchant_alias (
  id          TEXT PRIMARY KEY,
  alias_key   TEXT NOT NULL,
  merchant_id TEXT NOT NULL REFERENCES merchant_canonical (id) ON DELETE RESTRICT,
  match_type  TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix', 'fuzzy')),
  confidence  REAL,
  source      TEXT NOT NULL CHECK (source IN ('seed', 'rule', 'llm', 'user')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- §3.2: without it §4.3's precedence order is ambiguous — two `user` aliases for
-- one key have no defined winner.
CREATE UNIQUE INDEX ux_merchant_alias_key_type ON merchant_alias (alias_key, match_type);
CREATE INDEX ix_merchant_alias_merchant ON merchant_alias (merchant_id);

-- --------------------------------------------------------- format_profile ---
-- §3.1 lists the key columns; the rest mirror `FormatProfile` in
-- `ledgerline-parsing` so persisting a profile is a column-for-column write
-- (docs/statement-parsing.md §4).
CREATE TABLE format_profile (
  id                  TEXT PRIMARY KEY,
  institution         TEXT NOT NULL,
  account_type_hint   TEXT CHECK (account_type_hint IS NULL
                                  OR account_type_hint IN ('checking', 'savings', 'credit_card')),
  header_signature    TEXT NOT NULL,
  header_tokens_json  TEXT NOT NULL,
  has_header          INTEGER NOT NULL CHECK (has_header IN (0, 1)),
  delimiter           TEXT NOT NULL,
  skip_lines          INTEGER NOT NULL,
  column_map_json     TEXT NOT NULL,
  date_format         TEXT NOT NULL,
  amount_mode         TEXT NOT NULL CHECK (amount_mode IN ('single', 'debit_credit')),
  sign_convention     TEXT NOT NULL CHECK (sign_convention IN ('as_is', 'invert')),
  pending_values_json TEXT NOT NULL,
  currency            TEXT NOT NULL CHECK (currency = 'USD'),
  version             INTEGER NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('seed', 'user')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_format_profile_header_signature ON format_profile (header_signature);

-- ------------------------------------------------------- statement_import ---
-- `account_id` is nullable on purpose: §2.5 hashes and stores the file in
-- `uploaded` state before anything is known about it, and §6.1 requires the
-- guessed account to be *confirmed* (PATCH /api/imports/:id) before commit.
--
-- `file_bytes` holds the file itself, not its length. §6.1's import history
-- offers re-parse, and PATCH offers "apply/override a column mapping, re-parse";
-- neither is possible without the original bytes. Length is `length(file_bytes)`.
CREATE TABLE statement_import (
  id                TEXT PRIMARY KEY,
  account_id        TEXT REFERENCES account (id) ON DELETE RESTRICT,
  source_filename   TEXT NOT NULL,
  file_sha256       TEXT NOT NULL,
  file_bytes        BLOB NOT NULL,
  format_profile_id TEXT REFERENCES format_profile (id) ON DELETE RESTRICT,
  period_start      TEXT,
  period_end        TEXT,
  rows_parsed       INTEGER NOT NULL,
  rows_inserted     INTEGER NOT NULL,
  rows_duplicate    INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('uploaded', 'needs_mapping', 'staged', 'committed', 'failed')),
  parser            TEXT,
  parser_version    TEXT,
  error_detail      TEXT,
  -- Beyond §3.1's key columns. §6.1's review screen has to show "a warning strip
  -- for anything suspicious — unparsed rows, dates outside the detected period,
  -- pending rows, and a balance that doesn't reconcile". Unparsed and pending
  -- rows are recoverable from `raw_row`; the parser's warnings and the
  -- balance-reconciliation verdict are not, and re-deriving them on every read
  -- would answer with whatever the *current* profile says rather than with what
  -- was actually reviewed. `error_detail` stays what its name says.
  diagnostics_json  TEXT,
  imported_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- §3.3 layer one. Re-uploading a byte-identical file is a no-op that returns the
-- existing import.
CREATE UNIQUE INDEX ux_statement_import_file_sha256 ON statement_import (file_sha256);
CREATE INDEX ix_statement_import_account ON statement_import (account_id, period_start);

-- --------------------------------------------------------------- raw_row ---
CREATE TABLE raw_row (
  id           TEXT PRIMARY KEY,
  import_id    TEXT NOT NULL REFERENCES statement_import (id) ON DELETE RESTRICT,
  row_index    INTEGER NOT NULL,
  raw_text     TEXT NOT NULL,
  parsed_json  TEXT,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok', 'error')),
  parse_source TEXT NOT NULL CHECK (parse_source IN ('csv', 'pdf', 'llm')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX ix_raw_row_import ON raw_row (import_id, row_index);

-- ----------------------------------------------------------- transaction ---
-- `transaction` is a SQL keyword, so it is quoted everywhere it appears.
--
-- `allows_zero_amount` exists because of §3.2's own escape hatch: "A zero-amount
-- row is a parse failure, not a transaction — except for trial authorizations
-- (§5.6), which are stored with `is_pending` or an explicit `$0` allowance
-- flag." The flag is that flag; it is set only by an explicit reviewer decision
-- carried on the commit request, never inferred.
--
-- `refund_pair_id` is a shared group id, not a pointer: both rows of a reversal
-- carry the same value (§3.3). Symmetric relation, no self-referencing FK, and
-- "is this row reversed" is one indexed lookup. `transfer_pair_id` is the
-- cross-account relation (§2.6) and is a different column for that reason.
CREATE TABLE "transaction" (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  raw_row_id             TEXT REFERENCES raw_row (id) ON DELETE RESTRICT,
  posted_date            TEXT,
  transaction_date       TEXT,
  effective_date         TEXT NOT NULL,
  amount_cents           INTEGER NOT NULL,
  balance_cents          INTEGER,
  currency               TEXT NOT NULL,
  description_raw        TEXT NOT NULL,
  description_normalized TEXT NOT NULL,
  merchant_id            TEXT REFERENCES merchant_canonical (id) ON DELETE RESTRICT,
  category_id            TEXT REFERENCES category (id) ON DELETE RESTRICT,
  category_source        TEXT CHECK (category_source IS NULL
                                     OR category_source IN ('seed', 'rule', 'llm', 'user')),
  is_pending             INTEGER NOT NULL CHECK (is_pending IN (0, 1)),
  is_internal_transfer   INTEGER NOT NULL CHECK (is_internal_transfer IN (0, 1)),
  transfer_pair_id       TEXT,
  refund_pair_id         TEXT,
  is_excluded            INTEGER NOT NULL CHECK (is_excluded IN (0, 1)),
  allows_zero_amount     INTEGER NOT NULL CHECK (allows_zero_amount IN (0, 1)),
  dedupe_key             TEXT NOT NULL,
  dedupe_key_version     TEXT NOT NULL,
  occurrence_index       INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,

  -- §3.2, with the trial-authorization exception spelled out.
  CHECK (amount_cents <> 0 OR is_pending = 1 OR allows_zero_amount = 1),

  -- §7.1, "One date", as a database invariant rather than a convention every
  -- writer has to remember. The second clause is not redundant: with both dates
  -- NULL the COALESCE is NULL, the comparison is NULL, and SQLite passes a CHECK
  -- that evaluates to NULL — so any `effective_date` at all would slip through.
  CHECK (transaction_date IS NOT NULL OR posted_date IS NOT NULL),
  CHECK (effective_date = COALESCE(transaction_date, posted_date))
);

-- §3.2, in the order that section lists them.
CREATE INDEX ix_transaction_account_dedupe ON "transaction" (account_id, dedupe_key);
CREATE UNIQUE INDEX ux_transaction_dedupe_occurrence ON "transaction" (account_id, dedupe_key, occurrence_index);
CREATE INDEX ix_transaction_account_date ON "transaction" (account_id, effective_date);
CREATE INDEX ix_transaction_merchant_date ON "transaction" (merchant_id, effective_date);
CREATE INDEX ix_transaction_abs_amount_date ON "transaction" (abs(amount_cents), effective_date);
-- Refund pairing (§3.3) reads by pair and by "still unpaired".
CREATE INDEX ix_transaction_refund_pair ON "transaction" (refund_pair_id);

-- §3.2's `CHECK (currency = account.currency)`. SQLite CHECK constraints cannot
-- reference another table, so the constraint is a pair of triggers — which is a
-- real database-level invariant, not an application convention, and is what
-- "fails loudly the day one appears" the moment a non-USD account exists.
CREATE TRIGGER trg_transaction_currency_insert
BEFORE INSERT ON "transaction"
FOR EACH ROW
WHEN NEW.currency <> (SELECT currency FROM account WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'transaction.currency must equal account.currency (spec 3.2)');
END;

CREATE TRIGGER trg_transaction_currency_update
BEFORE UPDATE OF currency, account_id ON "transaction"
FOR EACH ROW
WHEN NEW.currency <> (SELECT currency FROM account WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'transaction.currency must equal account.currency (spec 3.2)');
END;

-- ---------------------------------------------------- transaction_source ---
-- Many-to-many: a row present in two overlapping statements has two sources.
-- This is what makes §3.3's import deletion correct — DELETE /api/imports/:id
-- removes only the transactions for which that import is the *last remaining*
-- source.
--
-- `raw_row_id` is beyond §3.1's two columns and earns its place twice. §6.3's
-- row expander shows "the verbatim statement line and the imports that cover
-- it", which is per-import information the pair alone cannot express — the same
-- transaction is a different printed line in each statement that carries it.
-- And without it, deleting one of two overlapping imports would have to null out
-- `transaction.raw_row_id` on rows that survive, losing the verbatim line for a
-- transaction that is still fully sourced. With it, deletion re-points.
CREATE TABLE transaction_source (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES "transaction" (id) ON DELETE RESTRICT,
  import_id      TEXT NOT NULL REFERENCES statement_import (id) ON DELETE RESTRICT,
  raw_row_id     TEXT REFERENCES raw_row (id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_transaction_source ON transaction_source (transaction_id, import_id);
CREATE INDEX ix_transaction_source_import ON transaction_source (import_id);

-- ------------------------------------------------------ recurring_series ---
CREATE TABLE recurring_series (
  id                   TEXT PRIMARY KEY,
  merchant_id          TEXT NOT NULL REFERENCES merchant_canonical (id) ON DELETE RESTRICT,
  account_id           TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  cadence_days         INTEGER,
  cadence_label        TEXT,
  cadences_per_year    INTEGER,
  amount_cents_current INTEGER,
  amount_cents_first   INTEGER,
  first_seen           TEXT,
  last_seen            TEXT,
  next_expected        TEXT,
  occurrence_count     INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('active', 'lapsed', 'cancelled')),
  user_status          TEXT,
  cancellation_url     TEXT,
  notes                TEXT,
  regularity           REAL,
  confidence           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX ix_recurring_series_merchant ON recurring_series (merchant_id, account_id);

-- --------------------------------------------------------- transfer_rule ---
CREATE TABLE transfer_rule (
  id                 TEXT PRIMARY KEY,
  descriptor_pattern TEXT NOT NULL,
  debit_account_id   TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  credit_account_id  TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- --------------------------------------------------------- transfer_link ---
CREATE TABLE transfer_link (
  id                    TEXT PRIMARY KEY,
  debit_transaction_id  TEXT NOT NULL REFERENCES "transaction" (id) ON DELETE RESTRICT,
  credit_transaction_id TEXT NOT NULL REFERENCES "transaction" (id) ON DELETE RESTRICT,
  score                 INTEGER NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('proposed', 'confirmed', 'rejected', 'auto')),
  rule_id               TEXT REFERENCES transfer_rule (id) ON DELETE RESTRICT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_transfer_link_pair ON transfer_link (debit_transaction_id, credit_transaction_id);
CREATE INDEX ix_transfer_link_credit ON transfer_link (credit_transaction_id);

-- ---------------------------------------------------------- analysis_run ---
CREATE TABLE analysis_run (
  id                 TEXT PRIMARY KEY,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  rule_versions_json TEXT,
  config_hash        TEXT,
  snapshot_rows      INTEGER,
  counts_json        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- --------------------------------------------------------------- finding ---
CREATE TABLE finding (
  id                   TEXT PRIMARY KEY,
  rule_id              TEXT NOT NULL,
  rule_version         TEXT NOT NULL,
  config_hash          TEXT NOT NULL,
  natural_key          TEXT NOT NULL,
  subject_type         TEXT NOT NULL,
  subject_id           TEXT NOT NULL,
  title                TEXT NOT NULL,
  detail_json          TEXT NOT NULL,
  confidence           TEXT NOT NULL,
  band                 TEXT NOT NULL,
  impact_kind          TEXT NOT NULL CHECK (impact_kind IN ('savings', 'visibility')),
  impact_monthly_cents INTEGER NOT NULL,
  impact_annual_cents  INTEGER NOT NULL,
  llm_dependent        INTEGER NOT NULL CHECK (llm_dependent IN (0, 1)),
  evidence_hash        TEXT NOT NULL,
  first_detected_at    TEXT NOT NULL,
  last_run_id          TEXT REFERENCES analysis_run (id) ON DELETE RESTRICT,
  status               TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_finding_natural_key ON finding (natural_key);
-- §3.2: upsert-by-natural-key is the lifecycle (§5.1); this is what makes it an
-- upsert rather than an insert that happens to collide.
CREATE UNIQUE INDEX ux_finding_rule_subject ON finding (rule_id, subject_type, subject_id);

-- ------------------------------------------------------ finding_evidence ---
CREATE TABLE finding_evidence (
  id             TEXT PRIMARY KEY,
  finding_id     TEXT NOT NULL REFERENCES finding (id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL REFERENCES "transaction" (id) ON DELETE RESTRICT,
  account_id     TEXT NOT NULL REFERENCES account (id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- §3.2: both directions are read paths.
CREATE INDEX ix_finding_evidence_transaction ON finding_evidence (transaction_id);
CREATE INDEX ix_finding_evidence_finding ON finding_evidence (finding_id);

-- --------------------------------------------------------- finding_state ---
-- §3.1 keys this on `natural_key`; the surrogate-id rule in the same section
-- makes that a UNIQUE index over a surrogate primary key instead of the PK
-- itself. Same invariant, one shape for every table.
CREATE TABLE finding_state (
  id                      TEXT PRIMARY KEY,
  natural_key             TEXT NOT NULL,
  status                  TEXT NOT NULL,
  reason                  TEXT,
  snooze_until            TEXT,
  dismissed_evidence_hash TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_finding_state_natural_key ON finding_state (natural_key);

-- -------------------------------------------------------- dismissal_rule ---
CREATE TABLE dismissal_rule (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('merchant_rule', 'rule')),
  rule_id     TEXT NOT NULL,
  merchant_id TEXT REFERENCES merchant_canonical (id) ON DELETE RESTRICT,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,

  CHECK ((scope = 'rule' AND merchant_id IS NULL)
         OR (scope = 'merchant_rule' AND merchant_id IS NOT NULL))
);

-- ------------------------------------------------------------------- job ---
CREATE TABLE job (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  state        TEXT NOT NULL,
  progress     INTEGER NOT NULL,
  message      TEXT,
  payload_json TEXT,
  result_json  TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX ix_job_kind_state ON job (kind, state);

-- ------------------------------------------------------------- llm_cache ---
CREATE TABLE llm_cache (
  id            TEXT PRIMARY KEY,
  prompt_sha256 TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_llm_cache_prompt ON llm_cache (prompt_sha256);

-- ------------------------------------------------------------- tombstone ---
-- §3.4: a watermark re-index cannot see deletions, and this app deletes —
-- import removal, account merge, wipe. Without this table a deleted import's
-- transactions live forever in the Elasticsearch index and every aggregate is
-- wrong.
CREATE TABLE tombstone (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  deleted_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- The re-index consumes tombstones in the same watermark pass it uses for
-- `updated_at`, so it reads them by time.
CREATE INDEX ix_tombstone_deleted_at ON tombstone (deleted_at);
CREATE INDEX ix_tombstone_entity ON tombstone (entity_type, entity_id);

-- -------------------------------------------------------------- settings ---
CREATE TABLE settings (
  id         TEXT PRIMARY KEY,
  "key"      TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_settings_key ON settings ("key");

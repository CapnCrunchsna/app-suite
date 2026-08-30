-- §7.6's corpus, the half that can measure what the rules **missed**.
--
-- §9z added `finding_label`, which records whether a finding that fired was right.
-- That measures precision and, as §9z says in as many words, "cannot measure recall,
-- because the app has no way to show a reader what it *failed* to find".
--
-- This is the other half. §7.6 asks for "a hand-labelled year of real statements with
-- the expected findings written down", and the word doing the work is **expected**:
-- writing down what should be found, against the rows themselves, is what makes an
-- absence measurable. A rule that never fired leaves no finding to judge — but a
-- transaction marked "this is part of a subscription" whose merchant has no
-- `recurring_series` is a miss with a name and a row number.
--
-- ## Every column is nullable, and that is the design
--
-- An unlabelled row and a row labelled "not a fee" are different facts, and a schema
-- that could not tell them apart would count every unexamined transaction as evidence
-- that the fee rule is correct. NULL means "not asserted"; 0 means "asserted false".
-- The distinction is the whole reason this can measure recall at all.
--
-- ## The app's own answer is captured here too
--
-- `chain_merchant_id` and `chain_description_normalized` are what §4.1's chain had
-- concluded at the moment the judgement was made. Recording them here rather than
-- reading them back later is the same argument `finding_state.dismissed_evidence_hash`
-- makes: the comparison that matters is against what the machine said *then*, and by
-- the time anyone runs the numbers a correction may have moved it.
--
-- It is also what makes an ordinary merchant correction into evidence for free. §4.3's
-- correction path writes one of these as a side effect, so normalization accuracy
-- accumulates from work the user was doing anyway — without which the correction would
-- *destroy* the measurement it should have produced, by making the chain look right
-- for a reason that was the user's.

CREATE TABLE transaction_label (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,

  -- Ground truth for §4: which merchant this row is really for. NULL means the
  -- labeller did not say.
  expected_merchant_id TEXT,

  -- Ground truth for §5, one nullable flag per rule that can be judged from a single
  -- row. 1 asserted true, 0 asserted false, NULL not asserted.
  is_recurring   INTEGER CHECK (is_recurring   IN (0, 1)),
  is_fee         INTEGER CHECK (is_fee         IN (0, 1)),
  is_transfer    INTEGER CHECK (is_transfer    IN (0, 1)),
  is_outlier     INTEGER CHECK (is_outlier     IN (0, 1)),

  -- Why, in the labeller's words. The column no threshold can reconstruct.
  note           TEXT,

  -- What §4.1's chain said when the judgement was made — see the header.
  chain_merchant_id             TEXT,
  chain_description_normalized  TEXT NOT NULL,

  -- Where the judgement came from. `review` is the deliberate pass; `correction` is
  -- the side effect of a §4.3 merchant correction. Kept apart because they are
  -- different evidence: a deliberate pass covers rows the user had no complaint
  -- about, and corrections are by definition the rows the chain got wrong — counting
  -- them together would make normalization look far worse than it is.
  origin         TEXT NOT NULL CHECK (origin IN ('review', 'correction')),

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  FOREIGN KEY (transaction_id) REFERENCES "transaction" (id) ON DELETE CASCADE,
  FOREIGN KEY (expected_merchant_id) REFERENCES merchant_canonical (id) ON DELETE RESTRICT
);

-- One judgement per row. Re-labelling updates rather than stacking; §7.6 wants the
-- current best answer, not a diary.
CREATE UNIQUE INDEX ux_transaction_label_transaction ON transaction_label (transaction_id);

-- The pass walks in date order and needs to know what it has already covered, and
-- the scorecard groups by origin.
CREATE INDEX ix_transaction_label_origin ON transaction_label (origin);

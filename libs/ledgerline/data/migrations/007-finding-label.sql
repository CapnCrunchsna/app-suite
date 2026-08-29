-- §7.6's fixture corpus, collected from use instead of assembled in one sitting.
--
-- "Nothing in §5 has been run against a real statement. The first phase that ships
-- analyzers also ships a fixture corpus — a hand-labelled year of real statements
-- with the expected findings written down — and every threshold is re-derived
-- against it before the numbers in this document are treated as settled."
--
-- That corpus has not been built, and the reason is not that anybody forgot: it is
-- an afternoon of sitting with a year of statements and writing out what *should*
-- have been found, before ever seeing what was. This table is the other half of the
-- same job — the half a person can do thirty seconds at a time, while looking at a
-- finding they were going to read anyway.
--
-- ## A label is not a dismissal, and the difference is the whole reason for the table
--
-- `finding_state` already records a verdict: acknowledged, snoozed, dismissed. It is
-- tempting to read dismissals as "wrong" and count them, and it would be wrong in the
-- direction that matters. Dismissal answers *do I want to see this*; a label answers
-- *was it true*. They come apart in both directions — a correct finding about a
-- subscription you have already decided to keep gets dismissed, and an incorrect one
-- sits unread at the bottom of the page for a month. Tuning §5's thresholds against
-- dismissals would therefore calibrate them toward what annoys the reader, which is
-- not what §7.6 asks for and is not recoverable afterwards.

CREATE TABLE finding_label (
  id           TEXT PRIMARY KEY,
  -- Keyed on the natural key, not the finding id, for §5.1's reason: findings are
  -- upserted by natural key and a resolved finding that comes back is the same
  -- claim. A judgement about it should survive the gap.
  natural_key  TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'unsure')),
  -- Why, in the labeller's words. The single most useful column for calibration and
  -- the one no threshold can reconstruct: "right, but I do not care" and "wrong,
  -- it double-counted the refund" are different futures for the same rule.
  note         TEXT,
  -- Denormalised so accuracy survives the finding. A label outlives the run that
  -- produced it — §5.1 resolves a finding that stops firing rather than deleting it,
  -- but a threshold change can remove it from every future run, and the judgement
  -- about the old threshold is exactly what tuning needs to look back at.
  rule_id      TEXT NOT NULL,
  -- What was true when the judgement was made, captured here rather than read back
  -- off the finding later — the same mechanism, and the same argument, as
  -- `finding_state.dismissed_evidence_hash`. A label whose evidence has moved is a
  -- label about a different claim, and counting it would quietly launder a stale
  -- opinion into a current accuracy figure.
  labelled_evidence_hash TEXT NOT NULL,
  labelled_config_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- One live judgement per claim. Changing your mind updates the row; there is no
-- history, because §7.6 wants the current best answer rather than an audit trail of
-- one person's afternoon.
CREATE UNIQUE INDEX ux_finding_label_natural_key ON finding_label (natural_key);

-- The read that matters is "accuracy for this rule", on Settings beside that rule's
-- thresholds.
CREATE INDEX ix_finding_label_rule ON finding_label (rule_id, verdict);

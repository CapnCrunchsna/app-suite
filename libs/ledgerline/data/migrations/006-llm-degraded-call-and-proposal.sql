-- §2.4 and §4.2, given somewhere to keep what they produce.
--
-- Two tables, both of which §6.8 asks for by implication and §3.1 never listed —
-- the spec describes the *feature* in both cases and stops short of the row.
--
--   §6.8 Data:            "the degraded-LLM-call log"
--   §6.8 Merchant aliases: "the review queue for LLM proposals"
--
-- Both are shown in Settings, and Settings is a page a user opens tomorrow. A log
-- that lived in memory would answer "is my provider actually doing anything?"
-- with whatever has happened since the last restart, which is the wrong answer to
-- exactly the question §2.4 says the log exists for: "a run of degraded calls is
-- how a user discovers Ollama has been down for a week while the app quietly
-- carried on working." A week does not survive in a process.

-- --------------------------------------------------- llm_degraded_call ---
-- §2.4: "Any throw, timeout, or schema-validation failure yields the fallback and
-- records a degraded-call event visible in Settings."
--
-- One row per degraded call, not per distinct reason. The signal a reader is
-- looking for is *volume over time* — one timeout is a blip, forty in an hour is
-- a provider that is down — and a table that deduplicated would erase precisely
-- that. `at` is the event time from `llmAssist`, which is not `created_at`: a
-- caller can hand the sink its own clock, and the two columns disagreeing is a
-- fact worth being able to see rather than one to collapse.
CREATE TABLE llm_degraded_call (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  provider   TEXT NOT NULL,
  -- The caller's own words — "merchant normalization", not a stack frame. The
  -- log is read by whoever configured the provider (§2.4).
  operation  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Read newest-first and only ever by time, which is the one access pattern
-- §6.8's Data section has.
CREATE INDEX ix_llm_degraded_call_at ON llm_degraded_call (at);

-- -------------------------------------------------------- llm_proposal ---
-- §4.2's other half: "below it they sit in the review queue and apply to
-- nothing", plus everything the settled-series exception withheld at any
-- confidence.
--
-- A table rather than `merchant_alias` rows with a pending flag, because "apply
-- to nothing" has to be structurally true. An un-applied proposal in the alias
-- table is one forgotten `WHERE` away from resolving a descriptor, and §4.1's
-- chain reads that table on every import.
--
-- Applied proposals are kept too, with `status = 'applied'`. The alias they wrote
-- carries `source = 'llm'` and is the operative record; this row is the receipt —
-- what was asked, what came back, and how sure the model claimed to be, none of
-- which `merchant_alias` has a column for.
CREATE TABLE llm_proposal (
  id            TEXT PRIMARY KEY,
  -- The normalized descriptor. §4.2 keys everything on the descriptor string,
  -- and it is also the alias key a proposal becomes if it is applied.
  descriptor    TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  category_name TEXT,
  confidence    REAL NOT NULL,
  -- `pending` is §4.2's sub-floor case; `blocked` is the settled-series
  -- exception, which "never auto-applies at any confidence"; `applied` wrote an
  -- alias. `rejected` is a person saying no, which is a `user` decision and must
  -- not be re-proposed by the next run.
  status        TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'blocked', 'rejected')),
  -- Why it did not apply, in words the review card can print. NULL when it did.
  blocked_reason TEXT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One live proposal per descriptor. A second run over the same unresolved
-- descriptor updates the row rather than stacking a second card for the same
-- question — the review queue asks each question once (§4.1 step 7).
CREATE UNIQUE INDEX ux_llm_proposal_descriptor ON llm_proposal (descriptor);
CREATE INDEX ix_llm_proposal_status ON llm_proposal (status);

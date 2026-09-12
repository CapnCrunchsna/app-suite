"""Index names, mappings and bootstrap seeds — spec §4.3, §4.2.

Every mapping here is written out explicitly rather than generated, because
``"dynamic": "strict"`` means the mapping *is* the schema: a field that is not
listed cannot be written at all. The §4.2 field-type conventions are applied
mechanically, and ``tests/test_indices.py`` re-checks them field by field so a
hand-edited mapping cannot drift away from the rules:

    ids / keys / enums ....... keyword
    timestamps ............... date
    money (cents) ............ long
    probabilities, decimal odds  double
    flags .................... boolean
    opaque JSON blobs ........ object, "enabled": false  (in _source, not indexed)

``edgeline-settings`` is the one index that is **not** strict: its documents are
read and written whole by ``_id`` and nothing in them needs to be queryable, so it
uses ``"dynamic": false`` (§4.2).
"""

from __future__ import annotations

from typing import Any

from .config import DEFAULT_RUNTIME, DEFAULT_SETTINGS

#: Every index name is prefixed. Tests bootstrap under ``edgeline-test-`` (§4.2, §14).
INDEX_PREFIX = "edgeline-"
TEST_INDEX_PREFIX = "edgeline-test-"

SETTINGS_INDEX = "edgeline-settings"
PROVIDERS_INDEX = "edgeline-providers"
SPORTSBOOKS_INDEX = "edgeline-sportsbooks"
EVENTS_INDEX = "edgeline-events"
ODDS_SNAPSHOTS_INDEX = "edgeline-odds-snapshots"
OPPORTUNITIES_INDEX = "edgeline-opportunities"
RECOMMENDATIONS_INDEX = "edgeline-recommendations"
BETS_INDEX = "edgeline-bets"
RESULTS_INDEX = "edgeline-results"
BANKROLL_LEDGER_INDEX = "edgeline-bankroll-ledger"
UNMATCHED_INDEX = "edgeline-unmatched"

_KEYWORD: dict[str, Any] = {"type": "keyword"}
_DATE: dict[str, Any] = {"type": "date"}
_LONG: dict[str, Any] = {"type": "long"}
_INTEGER: dict[str, Any] = {"type": "integer"}
_DOUBLE: dict[str, Any] = {"type": "double"}
_BOOLEAN: dict[str, Any] = {"type": "boolean"}
#: Stored in ``_source``, never indexed — §4.2's "opaque JSON blob".
_BLOB: dict[str, Any] = {"type": "object", "enabled": False}


#: ``index name -> mapping body`` exactly as passed to ``indices.create(mappings=...)``.
INDEX_MAPPINGS: dict[str, dict[str, Any]] = {
    # Read/written whole by _id ("global", "runtime"); nothing needs indexing.
    SETTINGS_INDEX: {"dynamic": False},
    PROVIDERS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "display_name": _KEYWORD,
            "enabled": _BOOLEAN,
            "config": _BLOB,
            "quota_used": _LONG,
            "quota_budget": _LONG,
            "quota_reset_at": _DATE,
        },
    },
    SPORTSBOOKS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "display_name": _KEYWORD,
            "md_licensed": _BOOLEAN,
            "enabled": _BOOLEAN,
            "priority": _INTEGER,
            "link_templates": _BLOB,
        },
    },
    EVENTS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "sport_key": _KEYWORD,
            "commence_time": _DATE,
            "home_team": _KEYWORD,
            "away_team": _KEYWORD,
            "completed": _BOOLEAN,
            "home_score": _INTEGER,
            "away_score": _INTEGER,
        },
    },
    ODDS_SNAPSHOTS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "event_id": _KEYWORD,
            "book_key": _KEYWORD,
            "market_key": _KEYWORD,
            "selection": _KEYWORD,
            "line": _DOUBLE,
            "price_decimal": _DOUBLE,
            "is_closing": _BOOLEAN,
            "@timestamp": _DATE,
        },
    },
    OPPORTUNITIES_INDEX: {
        "dynamic": "strict",
        "properties": {
            "type": _KEYWORD,  # arb | ev
            "event_id": _KEYWORD,
            "market_key": _KEYWORD,
            # Plain object array, NOT nested (§4.3): no query correlates fields
            # across two legs of the same document, so nested overhead buys nothing.
            "legs": {
                "type": "object",
                "properties": {
                    "book_key": _KEYWORD,
                    "selection": _KEYWORD,
                    "line": _DOUBLE,
                    "price_decimal": _DOUBLE,
                    "devig_prob": _DOUBLE,
                    "staleness": _DOUBLE,
                    "bet_first": _BOOLEAN,
                },
            },
            "edge_pct": _DOUBLE,
            "status": _KEYWORD,  # open | alerted | closed | expired
            "detected_at": _DATE,
            "expires_at": _DATE,
            "closed_at": _DATE,
            "closing_edge_pct": _DOUBLE,
        },
    },
    RECOMMENDATIONS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "opportunity_id": _KEYWORD,  # = opp_hash
            "stakes": _BLOB,  # the §5 StakePlan
            "paper": _BOOLEAN,
            "channel": _KEYWORD,
            "sent_at": _DATE,
            "message_ref": _KEYWORD,
        },
    },
    BETS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "recommendation_id": _KEYWORD,
            "confirmed_via": _KEYWORD,  # button | reaction | ui
            "stake_actual_cents": _LONG,
            "odds_actual_decimal": _DOUBLE,
            "placed_at": _DATE,
        },
    },
    RESULTS_INDEX: {
        "dynamic": "strict",
        "properties": {
            "bet_id": _KEYWORD,
            "outcome": _KEYWORD,  # win | loss | push | void
            "pnl_cents": _LONG,
            "clv_pct": _DOUBLE,
            "needs_manual": _BOOLEAN,
            "graded_at": _DATE,
        },
    },
    # No stored balance field, by design: balances are sum aggregations (§4.4 rule 3).
    BANKROLL_LEDGER_INDEX: {
        "dynamic": "strict",
        "properties": {
            "book_key": _KEYWORD,
            "delta_cents": _LONG,
            "reason": _KEYWORD,  # deposit | withdrawal | bet_won | bet_lost | manual_adjust
            "ref_result_id": _KEYWORD,
            "@timestamp": _DATE,
        },
    },
    UNMATCHED_INDEX: {
        "dynamic": "strict",
        "properties": {
            "provider_key": _KEYWORD,
            "raw": _BLOB,
            "reason": _KEYWORD,
            "resolved": _BOOLEAN,
            "created_at": _DATE,
        },
    },
}


#: §4.3's closing paragraph. Every book starts disabled; the user enables from the UI.
#:
#: ``md_licensed`` is ``True`` on all eight as of **2026-09-08**, confirmed by the user —
#: which is the only way that field may ever be set. §4.3 says to verify Maryland
#: licensure before enabling and §16.3 forbids the implementer guessing it, so until
#: that confirmation the field was deliberately absent rather than ``False``. It records
#: a fact about the world on a date, not a permanent truth: re-confirm if this list is
#: still driving decisions much later.
#:
#: ``link_templates`` stays empty — §16.3 also forbids guessing a deep-link URL schema,
#: and filling these in is T4.3, one verified event URL per book.
#:
#: ``enabled`` stays ``False`` for every book, deliberately. §4.3 reserves enabling to
#: the user, and it is the switch that decides which prices reach §6.4/§6.5 at all.
#: ``priority`` is the spec's list order and is user-editable.
SPORTSBOOK_SEEDS: dict[str, dict[str, Any]] = {
    "draftkings": {"display_name": "DraftKings", "md_licensed": True, "enabled": False, "priority": 1, "link_templates": {}},
    "fanduel": {"display_name": "FanDuel", "md_licensed": True, "enabled": False, "priority": 2, "link_templates": {}},
    "betmgm": {"display_name": "BetMGM", "md_licensed": True, "enabled": False, "priority": 3, "link_templates": {}},
    "williamhill_us": {"display_name": "Caesars", "md_licensed": True, "enabled": False, "priority": 4, "link_templates": {}},
    "betrivers": {"display_name": "BetRivers", "md_licensed": True, "enabled": False, "priority": 5, "link_templates": {}},
    "espnbet": {"display_name": "ESPN BET", "md_licensed": True, "enabled": False, "priority": 6, "link_templates": {}},
    "fanatics": {"display_name": "Fanatics", "md_licensed": True, "enabled": False, "priority": 7, "link_templates": {}},
    "bet365": {"display_name": "bet365", "md_licensed": True, "enabled": False, "priority": 8, "link_templates": {}},
    # Beyond §4.3's original eight. Both surfaced in the `us2` region feed on
    # 2026-09-09 and the user confirmed both are Maryland-legal. They matter more
    # than two extra rows suggests: §4.3's eight yielded only five books actually
    # present in the feed, exactly the minimum §6.4 needs, and these lift that to
    # seven — clearing the consensus threshold rather than sitting on it.
    "betparx": {"display_name": "betPARX", "md_licensed": True, "enabled": False, "priority": 9, "link_templates": {}},
    "ballybet": {"display_name": "Bally Bet", "md_licensed": True, "enabled": False, "priority": 10, "link_templates": {}},
}

#: In the `us2` feed and deliberately **not** seeded, each with its reason —
#: recorded rather than merely absent, so a later reader of that feed does not
#: re-open a question that already has an answer (§4.3, §16.3):
#:
#: * ``hardrockbet`` — the user confirmed on **2026-09-09** that it is not
#:   Maryland-legal. That is a *verified* negative, which is a different thing
#:   from the unverified one it replaced: §16.3's bar cuts both ways, so until
#:   the answer arrived this key sat here as an open question rather than as a
#:   guessed ``md_licensed=False``.
#: * ``fliff`` — a sweepstakes product, not a licensed sportsbook. A different
#:   question entirely, and not one Maryland licensure answers.
#:
#: Every candidate the `us2` region surfaced is now resolved: `betparx` and
#: `ballybet` seeded above, these two out for good.
EXCLUDED_BOOKS: dict[str, str] = {
    "hardrockbet": "not Maryland-legal (user-confirmed 2026-09-09)",
    "fliff": "sweepstakes product, not a licensed sportsbook",
}

#: One row per registered adapter, seeded at bootstrap like the sportsbook list.
#:
#: It was not seeded until 2026-09-12, and the omission made the Providers page
#: unusable rather than merely empty. The page's job is to set `enabled` and
#: `quota_budget`; a row only appeared once an adapter had answered a request and
#: recorded its credit usage — but §8.4 checks the projected spend *against that
#: budget before starting a cadence*. So the budget could not be set until a call
#: had been made, and the call was gated on the budget. An empty page also reads
#: as "no provider is configured", which was never true: `the_odds_api` is the
#: only adapter in the registry and the engine has always used it.
#:
#: `quota_used` and `quota_reset_at` are deliberately absent rather than zero.
#: §8 makes the provider's own response header the sole source of truth for them,
#: and a seeded `0` would claim a full allowance on no evidence — which is the
#: one number §8.4 must not be wrong about. The UI already renders their absence
#: as "unknown rather than zero".
PROVIDER_SEEDS: dict[str, dict[str, Any]] = {
    "the_odds_api": {
        "display_name": "The Odds API",
        "enabled": True,
        "quota_budget": DEFAULT_SETTINGS["quota_monthly_budget"],
        "config": {},
    },
}

#: ``index -> {_id: document}`` written once at bootstrap, never overwritten (§4.4 rule 1).
SEEDS: dict[str, dict[str, dict[str, Any]]] = {
    SETTINGS_INDEX: {"global": DEFAULT_SETTINGS, "runtime": DEFAULT_RUNTIME},
    SPORTSBOOKS_INDEX: SPORTSBOOK_SEEDS,
    PROVIDERS_INDEX: PROVIDER_SEEDS,
}


def all_index_names(prefix: str = INDEX_PREFIX) -> list[str]:
    """Every index name, optionally re-prefixed (tests use ``edgeline-test-``)."""
    return [with_prefix(name, prefix) for name in INDEX_MAPPINGS]


def with_prefix(name: str, prefix: str) -> str:
    """Swap ``edgeline-`` for another prefix; a no-op at the default prefix."""
    return prefix + name.removeprefix(INDEX_PREFIX)


def event_doc_id(sport_key: str, provider_event_id: str) -> str:
    """``edgeline-events`` ``_id`` per §4.3."""
    return f"{sport_key}:{provider_event_id}"

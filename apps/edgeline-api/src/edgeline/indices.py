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
#: Two fields are deliberately **absent** from each seed rather than guessed:
#: ``md_licensed`` (the spec says verify Maryland licensure first — writing `false`
#: would assert an unverified negative just as much as `true` asserts a positive)
#: and any ``link_templates`` entry (§16.3 forbids guessing a deep-link URL schema).
#: ``priority`` is simply the spec's list order and is user-editable.
SPORTSBOOK_SEEDS: dict[str, dict[str, Any]] = {
    "draftkings": {"display_name": "DraftKings", "enabled": False, "priority": 1, "link_templates": {}},
    "fanduel": {"display_name": "FanDuel", "enabled": False, "priority": 2, "link_templates": {}},
    "betmgm": {"display_name": "BetMGM", "enabled": False, "priority": 3, "link_templates": {}},
    "williamhill_us": {"display_name": "Caesars", "enabled": False, "priority": 4, "link_templates": {}},
    "betrivers": {"display_name": "BetRivers", "enabled": False, "priority": 5, "link_templates": {}},
    "espnbet": {"display_name": "ESPN BET", "enabled": False, "priority": 6, "link_templates": {}},
    "fanatics": {"display_name": "Fanatics", "enabled": False, "priority": 7, "link_templates": {}},
    "bet365": {"display_name": "bet365", "enabled": False, "priority": 8, "link_templates": {}},
}

#: ``index -> {_id: document}`` written once at bootstrap, never overwritten (§4.4 rule 1).
SEEDS: dict[str, dict[str, dict[str, Any]]] = {
    SETTINGS_INDEX: {"global": DEFAULT_SETTINGS, "runtime": DEFAULT_RUNTIME},
    SPORTSBOOKS_INDEX: SPORTSBOOK_SEEDS,
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

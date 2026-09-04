"""Normalizer v1 — spec §7.2, §7.3.

The failure mode this module guards against is not an exception; it is a
*plausible wrong answer*. A selection string that mislabels Under as Over, or a
line silently coerced to a neighbouring number, produces a recommendation to bet
on something the user did not mean — with nothing anywhere reporting an error.
So the tests below care as much about what is quarantined as about what parses.

The fixtures replayed here are real recorded The Odds API v4 responses (§8),
captured on 2026-09-04 from `baseball_mlb`. They are never re-fetched at test
time (§16.4).
"""

from __future__ import annotations

import logging

import pytest

from edgeline.indices import INDEX_MAPPINGS, UNMATCHED_INDEX
from edgeline.normalizer import (
    DUPLICATE_CONFLICTING_PRICE,
    MALFORMED_EVENT,
    MISSING_POINT,
    UNKNOWN_MARKET_KEY,
    UNKNOWN_OUTCOME_SHAPE,
    SkippedMiddle,
    UnmatchedRow,
    canonical_selection,
    find_skipped_middles,
    group_same_line,
    normalize,
)
from edgeline.schemas import BookOddsSnapshot

PROVIDER = "the_odds_api"

EVENT_HEADER = {
    "id": "evt1",
    "sport_key": "baseball_mlb",
    "commence_time": "2026-09-05T23:10:00Z",
    "home_team": "Cleveland Guardians",
    "away_team": "Detroit Tigers",
}


def event(*markets, book: str = "draftkings") -> dict:
    """One event carrying one bookmaker with the given markets."""
    return {
        **EVENT_HEADER,
        "bookmakers": [{"key": book, "title": book.title(), "markets": list(markets)}],
    }


def market(key: str, *outcomes) -> dict:
    return {"key": key, "outcomes": list(outcomes)}


def snapshot(selection: str, line: float | None, *, market_key: str, book: str = "dk"):
    return BookOddsSnapshot(
        provider_event_id="evt1",
        sport_key="baseball_mlb",
        commence_time=EVENT_HEADER["commence_time"],
        home_team=EVENT_HEADER["home_team"],
        away_team=EVENT_HEADER["away_team"],
        book_key=book,
        market_key=market_key,
        selection=selection,
        line=line,
        price_decimal=1.91,
        fetched_at="2026-09-04T11:31:33Z",
    )


# ---- canonical selection strings (§7.2) ------------------------------------


def test_h2h_uses_the_team_name_exactly_as_given():
    selection, line = canonical_selection(
        "h2h", {"name": "Cleveland Guardians", "price": 1.73}
    )
    assert selection == "Cleveland Guardians"
    assert line is None


@pytest.mark.parametrize(
    ("name", "point", "expected"),
    [
        ("Over", 8, "Over 8.0"),    # provider sends an int here; canonical form is 8.0
        ("Over", 8.5, "Over 8.5"),
        ("Under", 9.5, "Under 9.5"),
    ],
)
def test_totals_selection_strings(name, point, expected):
    selection, line = canonical_selection(
        "totals", {"name": name, "price": 1.86, "point": point}
    )
    assert selection == expected
    assert line == float(point)


@pytest.mark.parametrize(
    ("name", "point", "expected"),
    [
        ("Cleveland Guardians", -1.5, "Cleveland Guardians -1.5"),
        ("Detroit Tigers", 1.5, "Detroit Tigers +1.5"),
    ],
)
def test_spread_selection_strings_always_carry_a_sign(name, point, expected):
    selection, line = canonical_selection(
        "spreads", {"name": name, "price": 2.55, "point": point}
    )
    assert selection == expected
    assert line == point


def test_prop_selection_uses_the_description_as_the_player():
    selection, line = canonical_selection(
        "pitcher_strikeouts",
        {"name": "Over", "description": "Logan Allen", "price": 2.21, "point": 3.5},
    )
    assert selection == "Logan Allen Over 3.5"
    assert line == 3.5


def test_prop_under_is_not_relabelled_as_over():
    """§7.2 spells only the Over form; hard-coding it would invert a real bet."""
    selection, _ = canonical_selection(
        "pitcher_strikeouts",
        {"name": "Under", "description": "Logan Allen", "price": 1.65, "point": 3.5},
    )
    assert selection == "Logan Allen Under 3.5"


# ---- real recorded responses ----------------------------------------------


def test_recorded_featured_response_normalizes_cleanly(mlb_odds_payload):
    quarantine: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, mlb_odds_payload, quarantine=quarantine)

    assert quarantine == []
    assert len(snapshots) > 100
    assert {s.market_key for s in snapshots} == {"h2h", "spreads", "totals"}
    assert all(s.price_decimal > 1.0 for s in snapshots)
    assert all(s.sport_key == "baseball_mlb" for s in snapshots)
    # h2h has no line; the other two always do.
    assert all(s.line is None for s in snapshots if s.market_key == "h2h")
    assert all(s.line is not None for s in snapshots if s.market_key != "h2h")
    assert all(
        s.selection.startswith(("Over ", "Under "))
        for s in snapshots
        if s.market_key == "totals"
    )


def test_recorded_props_response_normalizes_cleanly(mlb_event_odds_payload):
    """The per-event endpoint returns a single object, not a list."""
    quarantine: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, mlb_event_odds_payload, quarantine=quarantine)

    assert quarantine == []
    assert snapshots
    assert {s.market_key for s in snapshots} <= {
        "batter_home_runs",
        "pitcher_strikeouts",
    }
    assert all(" Over " in s.selection or " Under " in s.selection for s in snapshots)


# ---- the same-line rule (§7.2) --------------------------------------------


def test_group_same_line_keeps_different_lines_apart():
    rows = [
        snapshot("Over 8.0", 8.0, market_key="totals", book="dk"),
        snapshot("Over 8.0", 8.0, market_key="totals", book="fd"),
        snapshot("Over 8.5", 8.5, market_key="totals", book="mgm"),
    ]
    groups = group_same_line(rows)

    assert len(groups) == 2
    assert len(groups[("baseball_mlb:evt1", "totals", 8.0)]) == 2
    assert len(groups[("baseball_mlb:evt1", "totals", 8.5)]) == 1


def test_h2h_groups_on_a_null_line():
    groups = group_same_line([snapshot("Cleveland Guardians", None, market_key="h2h")])
    assert list(groups) == [("baseball_mlb:evt1", "h2h", None)]


def test_totals_middle_is_detected_and_logged(caplog):
    rows = [
        snapshot("Over 8.0", 8.0, market_key="totals", book="dk"),
        snapshot("Under 8.5", 8.5, market_key="totals", book="fd"),
    ]
    with caplog.at_level(logging.INFO, logger="edgeline.normalizer"):
        middles = find_skipped_middles(rows)

    assert len(middles) == 1
    assert isinstance(middles[0], SkippedMiddle)
    assert "skipped middle" in caplog.text


def test_same_line_over_under_is_not_a_middle():
    rows = [
        snapshot("Over 8.5", 8.5, market_key="totals", book="dk"),
        snapshot("Under 8.5", 8.5, market_key="totals", book="fd"),
    ]
    assert find_skipped_middles(rows) == []


def test_spread_middle_needs_opposite_teams_and_a_gap():
    mirrored = [
        snapshot("Cleveland Guardians -1.5", -1.5, market_key="spreads", book="dk"),
        snapshot("Detroit Tigers +1.5", 1.5, market_key="spreads", book="fd"),
    ]
    assert find_skipped_middles(mirrored) == []

    gapped = [
        snapshot("Cleveland Guardians -1.5", -1.5, market_key="spreads", book="dk"),
        snapshot("Detroit Tigers +2.5", 2.5, market_key="spreads", book="fd"),
    ]
    assert len(find_skipped_middles(gapped)) == 1


def test_normalize_reports_middles_through_the_sink():
    payload = [
        {
            **EVENT_HEADER,
            "bookmakers": [
                {
                    "key": "dk",
                    "markets": [market("totals", {"name": "Over", "price": 1.9, "point": 8})],
                },
                {
                    "key": "fd",
                    "markets": [
                        market("totals", {"name": "Under", "price": 1.9, "point": 8.5})
                    ],
                },
            ],
        }
    ]
    middles: list[SkippedMiddle] = []
    snapshots = normalize(PROVIDER, payload, skipped_middles=middles)

    assert len(snapshots) == 2  # both rows are still ingested...
    assert len(middles) == 1  # ...they are just never paired by v1


# ---- quarantine (§7.3) -----------------------------------------------------


def reasons(payload) -> list[str]:
    sink: list[UnmatchedRow] = []
    normalize(PROVIDER, payload, quarantine=sink)
    return [row.reason for row in sink]


def test_unknown_market_key_is_quarantined_not_guessed():
    payload = [event(market("first_inning_wizardry", {"name": "Yes", "price": 2.0}))]
    assert reasons(payload) == [UNKNOWN_MARKET_KEY]


def test_missing_point_is_quarantined():
    payload = [event(market("totals", {"name": "Over", "price": 1.9}))]
    assert reasons(payload) == [MISSING_POINT]


def test_unknown_outcome_shape_is_quarantined():
    payload = [event(market("totals", {"name": "Sideways", "price": 1.9, "point": 8.5}))]
    assert reasons(payload) == [UNKNOWN_OUTCOME_SHAPE]


def test_boolean_point_is_bad_data_not_the_line_one():
    payload = [event(market("totals", {"name": "Over", "price": 1.9, "point": True}))]
    assert reasons(payload) == [MISSING_POINT]


@pytest.mark.parametrize(
    "payload",
    [
        "not json we understand",
        [{"id": "evt1"}],  # header fields missing
        [{**EVENT_HEADER, "bookmakers": "nonsense"}],
        [None],
    ],
)
def test_malformed_payloads_quarantine_instead_of_raising(payload):
    sink: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, payload, quarantine=sink)

    assert snapshots == []
    assert [row.reason for row in sink] == [MALFORMED_EVENT]


def test_conflicting_duplicate_prices_drop_both_sides():
    """Neither price can be trusted, so neither is allowed to reach detection."""
    payload = [
        event(
            market(
                "h2h",
                {"name": "Cleveland Guardians", "price": 1.73},
                {"name": "Cleveland Guardians", "price": 1.91},
            )
        )
    ]
    sink: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, payload, quarantine=sink)

    assert snapshots == []
    assert [row.reason for row in sink] == [DUPLICATE_CONFLICTING_PRICE]


def test_identical_duplicate_price_is_simply_deduplicated():
    payload = [
        event(
            market(
                "h2h",
                {"name": "Cleveland Guardians", "price": 1.73},
                {"name": "Cleveland Guardians", "price": 1.73},
            )
        )
    ]
    sink: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, payload, quarantine=sink)

    assert len(snapshots) == 1
    assert sink == []


def test_one_bad_outcome_does_not_lose_the_good_ones():
    payload = [
        event(
            market(
                "h2h",
                {"name": "Cleveland Guardians", "price": 1.73},
                {"name": "", "price": 2.2},
            )
        )
    ]
    sink: list[UnmatchedRow] = []
    snapshots = normalize(PROVIDER, payload, quarantine=sink)

    assert [s.selection for s in snapshots] == ["Cleveland Guardians"]
    assert [row.reason for row in sink] == [UNKNOWN_OUTCOME_SHAPE]


def test_quarantine_row_matches_the_unmatched_mapping():
    """A row that cannot be indexed under `dynamic: strict` is a lost error report."""
    document = UnmatchedRow(PROVIDER, UNKNOWN_MARKET_KEY, {"anything": 1}).to_document()
    allowed = set(INDEX_MAPPINGS[UNMATCHED_INDEX]["properties"])

    assert set(document) <= allowed
    assert document["resolved"] is False
    assert document["provider_key"] == PROVIDER


def test_quarantine_without_a_sink_warns_rather_than_losing_rows(caplog):
    payload = [event(market("totals", {"name": "Over", "price": 1.9}))]
    with caplog.at_level(logging.WARNING, logger="edgeline.normalizer"):
        normalize(PROVIDER, payload)

    assert "quarantined" in caplog.text


# ---- interface shape (§7.2) ------------------------------------------------


def test_signature_is_multi_provider_shaped(mlb_odds_payload):
    result = normalize("the_odds_api", mlb_odds_payload)
    assert isinstance(result, list)
    assert all(isinstance(row, BookOddsSnapshot) for row in result)

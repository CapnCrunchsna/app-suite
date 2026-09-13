"""§9.4's ladder fed by the provider — `includeLinks`, landed 2026-09-12.

Driven by the **real** recorded response rather than a hand-built payload. The
whole history of this feature is a claim about what the provider does or does not
return being repeated until it shaped decisions, so the fixture is the witness.

No cluster needed: everything here is the normalizer and the ladder, both pure.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from edgeline.deeplink import NO_LINK, build_deep_link
from edgeline.engine import provider_link_index
from edgeline.normalizer import normalize

FIXTURE = (
    Path(__file__).parent / "fixtures" / "baseball_mlb_linkprobe_links_20260912.json"
)
PROVIDER = "the_odds_api"


@pytest.fixture(scope="module")
def snapshots():
    return normalize(PROVIDER, json.loads(FIXTURE.read_text(encoding="utf-8")))


def test_the_recorded_response_actually_carries_links(snapshots):
    """If this fails the fixture was re-recorded without the flag, and every
    other test in this file would pass vacuously."""
    assert any(s.event_link for s in snapshots)
    assert any(s.outcome_link for s in snapshots)


def test_every_book_in_the_feed_has_at_least_an_event_link(snapshots):
    """Measured: all seven of our books present in the MLB feed returned one.
    A regression here is the provider changing, not us, and it should be loud."""
    by_book: dict[str, bool] = {}
    for snapshot in snapshots:
        by_book.setdefault(snapshot.book_key, False)
        if snapshot.event_link:
            by_book[snapshot.book_key] = True
    ours = {"draftkings", "fanduel", "betmgm", "betrivers", "espnbet", "betparx", "ballybet"}
    covered = {book for book, has in by_book.items() if has}
    assert ours <= covered, f"no event link for {ours - covered}"


def test_the_ladder_prefers_the_providers_betslip_over_a_stored_template():
    """The rule the whole change turns on: a provider link is keyed to *this*
    outcome, a template is a human's generalisation that may have gone stale."""
    url, level = build_deep_link(
        {"event": "https://book.example/event/{provider_event_id}"},
        {"provider_event_id": "abc", "state": "md"},
        {"outcome_link": "https://book.example/?outcomes=XYZ"},
    )
    assert (url, level) == ("https://book.example/?outcomes=XYZ", "betslip")


def test_the_ladder_walks_down_the_providers_own_levels():
    placeholders = {"provider_event_id": "abc", "state": "md"}
    assert build_deep_link(None, placeholders, {"market_link": "https://b/m"}) == (
        "https://b/m",
        "market",
    )
    assert build_deep_link(None, placeholders, {"event_link": "https://b/e"}) == (
        "https://b/e",
        "event",
    )


def test_a_stored_template_still_catches_a_book_the_provider_does_not_cover():
    """Caesars, Fanatics and bet365 are in no MLB response, so the league URL a
    person entered is the only thing those books will ever have."""
    url, level = build_deep_link(
        {"league": "https://book.example/mlb"},
        {"provider_event_id": "abc", "state": "md"},
        None,
    )
    assert (url, level) == ("https://book.example/mlb", "league")


def test_state_is_filled_in_a_provider_link(snapshots):
    """BetMGM and betPARX return a literal `{state}`. Left unfilled it is not a
    URL, and `.format()` is why these go through the same path as templates."""
    templated = [s for s in snapshots if s.event_link and "{state}" in s.event_link]
    assert templated, "expected at least one provider link carrying {state}"

    snapshot = templated[0]
    url, level = build_deep_link(
        None,
        {"provider_event_id": snapshot.provider_event_id, "state": "md"},
        {"event_link": snapshot.event_link},
    )
    assert level == "event"
    assert "{state}" not in url
    assert ".md." in url or "//md." in url


def test_an_unfillable_provider_link_drops_a_rung_instead_of_raising():
    """A third-party URL with a brace we do not supply must not take out the
    cycle — §9.4 skips the rung, which is what an empty rung already means."""
    url, level = build_deep_link(
        {"book_home": "https://book.example/"},
        {"state": "md"},
        {"outcome_link": "https://book.example/?x={unknown_thing}"},
    )
    assert (url, level) == ("https://book.example/", "book_home")


def test_no_links_anywhere_is_still_no_link():
    assert build_deep_link(None, {"state": "md"}, None) == ("", NO_LINK)


def test_the_index_keys_on_book_market_and_selection(snapshots):
    index = provider_link_index(snapshots)
    assert index, "expected the recorded response to produce an index"
    for (book, market, selection), links in index.items():
        assert isinstance(book, str) and isinstance(market, str) and isinstance(selection, str)
        assert any(links.values()), "an all-empty entry should have been left out"

    # And it round-trips: a leg looked up by its own coordinates finds its link.
    linked = next(s for s in snapshots if s.outcome_link)
    found = index[(linked.book_key, linked.market_key, linked.selection)]
    assert found["outcome_link"] == linked.outcome_link


def test_a_response_recorded_before_the_flag_still_normalizes(snapshots):
    """Every fixture older than 2026-09-12 has no links at all, and those are
    what most of the suite replays. Absent must stay ordinary, not exceptional."""
    older = sorted(FIXTURE.parent.glob("baseball_mlb_odds_2*.json"))
    if not older:
        pytest.skip("no pre-flag odds fixture recorded")
    rows = normalize(PROVIDER, json.loads(older[-1].read_text(encoding="utf-8")))
    assert rows
    assert all(row.event_link is None for row in rows)
    assert provider_link_index(rows) == {}

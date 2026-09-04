"""Detection pipeline — spec §7.1, §6.4, §6.5, and §14's engine test.

§14 asks for "a recorded fixture set doctored to contain exactly one arb and one
+EV". The doctored payload below is built in The Odds API's real v4 shape and its
two expected edges are derived by hand from §6.2/§6.4/§6.5 rather than from the
code, so the test pins the arithmetic and not just the plumbing.

The recorded fixture is replayed too, as a shape check: real market data has
hundreds of quotes and is the only thing that catches an assumption that only
holds for a tidy two-book example.
"""

from __future__ import annotations

import pytest

from edgeline.config import Settings
from edgeline.engine import (
    TYPE_ARB,
    TYPE_EV,
    Detection,
    build_stake_plan,
    detect_opportunities,
    event_documents,
    snapshot_documents,
)
from edgeline.indices import INDEX_MAPPINGS, OPPORTUNITIES_INDEX
from edgeline.normalizer import group_same_line, normalize

PROVIDER = "the_odds_api"
TOL = 1e-4

EVENT_HEADER = {
    "id": "evt1",
    "sport_key": "baseball_mlb",
    "commence_time": "2026-09-05T23:10:00Z",
    "home_team": "Cleveland Guardians",
    "away_team": "Detroit Tigers",
}
FAIR_BOOKS = ["dk", "fd", "mgm", "czr", "brv"]


def h2h(book: str, guardians: float, tigers: float) -> dict:
    return {
        "key": book,
        "markets": [
            {
                "key": "h2h",
                "outcomes": [
                    {"name": "Cleveland Guardians", "price": guardians},
                    {"name": "Detroit Tigers", "price": tigers},
                ],
            }
        ],
    }


def doctored_payload() -> list[dict]:
    """Five books at a fair line, plus one book badly off it on the Guardians.

    Five fair books quote 1.90 / 2.00 -> de-vigged Guardians 0.512821.
    "juicy" quotes 2.10 / 1.80, which is both a +EV price against that consensus
    and, paired with any fair book's 2.00 on the Tigers, an arbitrage.
    """
    bookmakers = [h2h(book, 1.90, 2.00) for book in FAIR_BOOKS]
    bookmakers.append(h2h("juicy", 2.10, 1.80))
    return [{**EVENT_HEADER, "bookmakers": bookmakers}]


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


# ---- §14's engine test -----------------------------------------------------


def test_doctored_fixture_yields_exactly_one_ev_and_one_arb():
    snapshots = normalize(PROVIDER, doctored_payload())
    found = detect_opportunities(snapshots, settings())

    evs = [d for d in found if d.type == TYPE_EV]
    arbs = [d for d in found if d.type == TYPE_ARB]
    assert len(evs) == 1, [(d.type, d.legs[0].book_key, d.edge_pct) for d in found]
    assert len(arbs) == 1


def test_the_ev_detection_has_the_hand_computed_edge():
    snapshots = normalize(PROVIDER, doctored_payload())
    ev = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_EV)

    # Fair books: 1/1.90 = 0.5263158, 1/2.00 = 0.5, sum 1.0263158
    #   -> de-vigged Guardians 0.5128205, which five books agree on.
    # EV at 2.10: (0.5128205 x 2.10 - 1) x 100 = 7.6923%
    assert ev.consensus_prob == pytest.approx(0.5128205, abs=TOL)
    assert ev.edge_pct == pytest.approx(7.6923, abs=TOL)
    assert [leg.book_key for leg in ev.legs] == ["juicy"]
    assert ev.legs[0].selection == "Cleveland Guardians"
    assert ev.legs[0].price_decimal == pytest.approx(2.10, abs=TOL)
    assert ev.legs[0].price_american == 110


def test_the_arb_detection_has_the_hand_computed_edge():
    snapshots = normalize(PROVIDER, doctored_payload())
    arb = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_ARB)

    # Best Guardians 2.10 (juicy), best Tigers 2.00 (a fair book).
    # inv = 0.4761905 + 0.5 = 0.9761905 -> profit 2.4390%
    assert arb.edge_pct == pytest.approx(2.4390, abs=TOL)
    assert len(arb.legs) == 2
    assert {leg.book_key for leg in arb.legs} >= {"juicy"}
    assert len({leg.book_key for leg in arb.legs}) == 2


def test_the_arb_marks_the_stale_leg_to_bet_first():
    """§6.6 — juicy is the book out of line with the field, so it moves first."""
    snapshots = normalize(PROVIDER, doctored_payload())
    arb = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_ARB)

    first = [leg for leg in arb.legs if leg.bet_first]
    assert len(first) == 1
    assert first[0].book_key == "juicy"


# ---- the gates that keep detection honest ----------------------------------


def test_a_book_is_never_priced_against_its_own_number():
    """§6.4's consensus comes from the *other* books, so a lone book cannot
    manufacture an edge against itself."""
    payload = [{**EVENT_HEADER, "bookmakers": [h2h("solo", 2.10, 1.80)]}]
    assert detect_opportunities(normalize(PROVIDER, payload), settings()) == []


def test_min_books_for_consensus_is_enforced():
    """Three fair books cannot support the default requirement of four."""
    bookmakers = [h2h(book, 1.90, 2.00) for book in FAIR_BOOKS[:3]]
    bookmakers.append(h2h("juicy", 2.10, 1.80))
    snapshots = normalize(PROVIDER, [{**EVENT_HEADER, "bookmakers": bookmakers}])

    assert [d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_EV] == []
    # Lowering the requirement finds it again — proving the gate, not an absence.
    relaxed = detect_opportunities(snapshots, settings(min_books_for_consensus=3))
    assert [d for d in relaxed if d.type == TYPE_EV]


def test_an_arb_inside_a_single_book_is_not_an_arb():
    """§6.5 is explicitly across *different* books."""
    payload = [{**EVENT_HEADER, "bookmakers": [h2h("solo", 2.10, 2.10)]}]
    found = detect_opportunities(normalize(PROVIDER, payload), settings())
    assert [d for d in found if d.type == TYPE_ARB] == []


def test_disabled_books_are_not_considered():
    snapshots = normalize(PROVIDER, doctored_payload())
    assert detect_opportunities(snapshots, settings(), enabled_books=set()) == []

    without_juicy = detect_opportunities(
        snapshots, settings(), enabled_books=set(FAIR_BOOKS)
    )
    assert without_juicy == []  # the fair books alone offer no edge


def test_thresholds_are_respected():
    snapshots = normalize(PROVIDER, doctored_payload())
    strict = detect_opportunities(
        snapshots, settings(ev_threshold_pct=50.0, arb_min_profit_pct=50.0)
    )
    assert strict == []


def test_a_half_quoted_market_cannot_be_devigged_into_a_consensus():
    """A book showing one side has no visible overround, so it contributes no
    fair probability rather than a fabricated one."""
    bookmakers = [h2h(book, 1.90, 2.00) for book in FAIR_BOOKS]
    bookmakers.append(
        {
            "key": "onesided",
            "markets": [
                {"key": "h2h", "outcomes": [{"name": "Cleveland Guardians", "price": 2.10}]}
            ],
        }
    )
    snapshots = normalize(PROVIDER, [{**EVENT_HEADER, "bookmakers": bookmakers}])
    found = detect_opportunities(snapshots, settings())

    # It can still be the *subject* of a +EV check (it has a price)...
    ev = [d for d in found if d.type == TYPE_EV]
    assert [leg.book_key for d in ev for leg in d.legs] == ["onesided"]
    # ...but its own de-vigged number never enters anyone else's consensus.
    consensus_inputs = {d.consensus_prob for d in ev}
    assert all(value == pytest.approx(0.5128205, abs=TOL) for value in consensus_inputs)


# ---- spreads: the mirrored-line pairing (§7.2 + §6.2) ----------------------


def spreads_payload() -> list[dict]:
    def book(key: str, home_price: float, away_price: float) -> dict:
        return {
            "key": key,
            "markets": [
                {
                    "key": "spreads",
                    "outcomes": [
                        {"name": "Cleveland Guardians", "price": home_price, "point": -1.5},
                        {"name": "Detroit Tigers", "price": away_price, "point": 1.5},
                    ],
                }
            ],
        }

    return [
        {
            **EVENT_HEADER,
            "bookmakers": [book(b, 1.90, 2.00) for b in FAIR_BOOKS]
            + [book("juicy", 2.10, 1.80)],
        }
    ]


def test_a_spreads_two_sides_land_in_one_market_group():
    """-1.5 and +1.5 are one line quoted from each end; grouping them apart would
    leave every spread market half-quoted and undetectable."""
    snapshots = normalize(PROVIDER, spreads_payload())
    groups = group_same_line(snapshots)

    assert len(groups) == 1
    (only_key,) = groups
    assert only_key == ("baseball_mlb:evt1", "spreads", 1.5)
    assert len(groups[only_key]) == 12  # 6 books x 2 sides


def test_spreads_detection_keeps_each_sides_signed_line():
    snapshots = normalize(PROVIDER, spreads_payload())
    ev = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_EV)

    assert ev.market_key == "spreads"
    assert ev.legs[0].selection == "Cleveland Guardians -1.5"
    assert ev.legs[0].line == -1.5  # the signed point, not the group key


# ---- the recorded fixture --------------------------------------------------


def test_recorded_fixture_replays_without_incident(mlb_odds_payload):
    """Real market data: 16 events, 9 books, three markets."""
    snapshots = normalize(PROVIDER, mlb_odds_payload)
    found = detect_opportunities(snapshots, settings())

    for detection in found:
        assert detection.type in (TYPE_EV, TYPE_ARB)
        assert detection.legs
        assert detection.hash
        assert detection.edge_pct == pytest.approx(detection.edge_pct)  # not NaN
        if detection.type == TYPE_EV:
            assert detection.edge_pct >= settings().ev_threshold_pct
            assert len(detection.legs) == 1
        else:
            assert detection.edge_pct >= settings().arb_min_profit_pct
            assert len({leg.book_key for leg in detection.legs}) >= 2


def test_detection_documents_fit_the_strict_mapping(mlb_odds_payload):
    """`edgeline-opportunities` is `dynamic: strict`; an unmapped field cannot
    be written at all, so a shape error here is a write failure in production."""
    snapshots = normalize(PROVIDER, mlb_odds_payload)
    allowed = set(INDEX_MAPPINGS[OPPORTUNITIES_INDEX]["properties"])
    leg_fields = set(INDEX_MAPPINGS[OPPORTUNITIES_INDEX]["properties"]["legs"]["properties"])

    documents = [d.to_document() for d in detect_opportunities(snapshots, settings())]
    assert documents  # the fixture does produce detections
    for document in documents:
        assert set(document) <= allowed
        for leg in document["legs"]:
            assert set(leg) <= leg_fields


def test_snapshot_and_event_documents_fit_their_mappings(mlb_odds_payload):
    snapshots = normalize(PROVIDER, mlb_odds_payload)

    rows = snapshot_documents(snapshots)
    assert len(rows) == len(snapshots)
    assert all(row["event_id"].startswith("baseball_mlb:") for row in rows)
    assert all(row["is_closing"] is False for row in rows)

    events = event_documents(snapshots)
    assert len(events) == 16
    assert all(set(doc) == {"sport_key", "commence_time", "home_team", "away_team"}
               for doc in events.values())


# ---- staking the detections (§6.7, §9.4) -----------------------------------


def test_ev_detection_becomes_a_kelly_stake_plan():
    snapshots = normalize(PROVIDER, doctored_payload())
    ev = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_EV)

    plan, guardrails, alert = build_stake_plan(
        ev, settings(), bankroll_cents=100_000
    )
    assert plan is not None
    assert plan.method == "kelly"
    assert alert
    assert plan.total_cents > 0
    assert plan.total_cents % settings().stake_rounding_cents == 0
    assert guardrails == plan.guardrails_applied


def test_arb_detection_becomes_a_split_stake_plan():
    snapshots = normalize(PROVIDER, doctored_payload())
    arb = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_ARB)

    plan, _guardrails, _alert = build_stake_plan(arb, settings(), bankroll_cents=10_000_000)
    assert plan is not None
    assert plan.method == "arb_split"
    assert len(plan.legs) == 2
    assert plan.total_cents == sum(leg.stake_cents for leg in plan.legs)


def test_stake_legs_carry_no_invented_deep_link():
    """§16.3 and §9.4 — no book has a verified template yet, so the honest
    output is no link, never a plausible-looking guess."""
    snapshots = normalize(PROVIDER, doctored_payload())
    ev = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_EV)

    plan, _g, _a = build_stake_plan(ev, settings(), bankroll_cents=100_000)
    assert plan is not None
    for leg in plan.legs:
        assert leg.deep_link == ""
        assert leg.link_level == "none"


def test_kill_switch_stops_the_recommendation_but_not_the_detection():
    """§7.1: keep polling and recording, stop alerting."""
    snapshots = normalize(PROVIDER, doctored_payload())
    found = detect_opportunities(snapshots, settings(kill_switch=True))
    assert found  # detection is unaffected

    ev = next(d for d in found if d.type == TYPE_EV)
    _plan, _guardrails, alert = build_stake_plan(
        ev, settings(kill_switch=True), bankroll_cents=100_000
    )
    assert not alert


class _FixtureProvider:
    """Stands in for the Odds API adapter. Replays a payload; never leaves the box."""

    key = "the_odds_api"

    def __init__(self, payload):
        self.payload = payload
        self.calls: list[tuple[str, list[str]]] = []

    async def fetch_odds(self, sport_key, markets, *, regions="us"):
        from edgeline.providers.base import ProviderResponse, QuotaStatus
        from edgeline.schemas import utc_now_iso

        self.calls.append((sport_key, list(markets)))
        return ProviderResponse(
            provider_key=self.key,
            endpoint="odds",
            payload=self.payload,
            quota=QuotaStatus(used=3, remaining=497),
            fetched_at=utc_now_iso(),
            sport_key=sport_key,
        )

    async def aclose(self):
        return None


@pytest.mark.es
async def test_run_once_stores_snapshots_opportunities_and_paper_recommendations(
    es_url, test_index_prefix
):
    """The §7.1 cycle end to end against a real cluster, minus the alerting."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.engine import run_once
    from edgeline.es import ensure_indices
    from edgeline.indices import (
        ODDS_SNAPSHOTS_INDEX,
        RECOMMENDATIONS_INDEX,
        SPORTSBOOKS_INDEX,
        all_index_names,
        with_prefix,
    )

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        for name in all_index_names(prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)
        await ensure_indices(client, prefix=prefix)

        # Enable the books the doctored payload quotes; the shipped seeds are all
        # disabled on purpose, and an empty enabled set means no detections.
        for book in [*FAIR_BOOKS, "juicy"]:
            await client.index(
                index=with_prefix(SPORTSBOOKS_INDEX, prefix),
                id=book,
                document={"display_name": book, "enabled": True, "priority": 1,
                          "link_templates": {}},
                refresh="wait_for",
            )

        provider = _FixtureProvider(doctored_payload())
        report = await run_once(
            provider, client, sport_key="baseball_mlb", prefix=prefix
        )

        assert provider.calls == [("baseball_mlb", ["h2h", "spreads", "totals"])]
        assert report.snapshots == 12  # 6 books x 2 sides
        assert report.events == 1
        assert report.quarantined == 0
        assert report.enabled_books == 6
        assert report.quota_remaining == 497
        assert len(report.detections) == 2  # one +EV, one arb

        await client.indices.refresh(index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix))
        stored = await client.count(index=with_prefix(ODDS_SNAPSHOTS_INDEX, prefix))
        assert stored["count"] == 12

        # Opportunities are keyed by opp_hash, so a second identical cycle
        # overwrites rather than duplicating (§4.4 rule 1).
        again = await run_once(
            provider, client, sport_key="baseball_mlb", prefix=prefix
        )
        opportunities = await client.count(
            index=with_prefix(OPPORTUNITIES_INDEX, prefix)
        )
        assert opportunities["count"] == 2
        assert {d.hash for d in again.detections} == {d.hash for d in report.detections}

        recommendations = await client.search(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix), size=10
        )
        assert recommendations["hits"]["hits"]
        first = recommendations["hits"]["hits"][0]["_source"]
        assert first["paper"] is True  # §1: paper_mode defaults true
        assert first["opportunity_id"] in {d.hash for d in report.detections}
    finally:
        for name in all_index_names(prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)
        await client.close()


@pytest.mark.es
async def test_kill_switch_stores_opportunities_but_writes_no_recommendation(
    es_url, test_index_prefix
):
    """§7.1: "skip alerting but still poll (data continuity)"."""
    from elasticsearch import AsyncElasticsearch

    from edgeline.config import DEFAULT_SETTINGS
    from edgeline.engine import run_once
    from edgeline.es import ensure_indices
    from edgeline.indices import (
        RECOMMENDATIONS_INDEX,
        SETTINGS_INDEX,
        SPORTSBOOKS_INDEX,
        all_index_names,
        with_prefix,
    )

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        for name in all_index_names(prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)
        await ensure_indices(client, prefix=prefix)

        await client.index(
            index=with_prefix(SETTINGS_INDEX, prefix),
            id="global",
            document={**DEFAULT_SETTINGS, "kill_switch": True},
            refresh="wait_for",
        )
        for book in [*FAIR_BOOKS, "juicy"]:
            await client.index(
                index=with_prefix(SPORTSBOOKS_INDEX, prefix),
                id=book,
                document={"display_name": book, "enabled": True, "priority": 1,
                          "link_templates": {}},
                refresh="wait_for",
            )

        report = await run_once(
            _FixtureProvider(doctored_payload()),
            client,
            sport_key="baseball_mlb",
            prefix=prefix,
        )

        assert report.skipped_reason == "kill_switch"
        assert report.snapshots == 12  # polling continued
        assert len(report.detections) == 2  # and detection was recorded
        assert report.alerted == []

        await client.indices.refresh(index=with_prefix(RECOMMENDATIONS_INDEX, prefix))
        recommendations = await client.count(
            index=with_prefix(RECOMMENDATIONS_INDEX, prefix)
        )
        assert recommendations["count"] == 0
    finally:
        for name in all_index_names(prefix):
            await client.indices.delete(index=name, ignore_unavailable=True)
        await client.close()


def test_detection_hash_is_order_independent_and_populated():
    snapshots = normalize(PROVIDER, doctored_payload())
    arb = next(d for d in detect_opportunities(snapshots, settings()) if d.type == TYPE_ARB)

    rebuilt = Detection(
        type=arb.type,
        event_id=arb.event_id,
        sport_key=arb.sport_key,
        market_key=arb.market_key,
        commence_time=arb.commence_time,
        legs=list(reversed(arb.legs)),
        edge_pct=arb.edge_pct,
        detected_at=arb.detected_at,
    )
    assert rebuilt.hash == arb.hash

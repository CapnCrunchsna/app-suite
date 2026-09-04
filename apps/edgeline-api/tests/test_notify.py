"""Alert rendering and dispatch — spec §9.2, channel-independent.

§9.2 calls its formats "exact", so these tests assert the rendered strings rather
than the shape around them. They run with no channel attached: the point of the
`AlertMessage`/`AlertSink` split is that §9.2 can be pinned down now and a Discord
or Telegram adapter becomes a mapping over it later.
"""

from __future__ import annotations

import logging

import pytest

from edgeline.engine import Detection
from edgeline.notify import (
    AlertMessage,
    LogSink,
    NullSink,
    RecordingSink,
    render_alert,
    render_arb,
    render_ev,
)
from edgeline.notify.message import format_local_time, format_money
from edgeline.oddsmath import american_to_decimal
from edgeline.schemas import OpportunityLeg, StakeLeg, StakePlan

REC_ID = "abc123def456-1757000000"


def ev_detection() -> Detection:
    return Detection(
        type="ev",
        event_id="baseball_mlb:evt1",
        sport_key="baseball_mlb",
        market_key="h2h",
        commence_time="2026-09-05T23:10:00Z",
        legs=[
            OpportunityLeg(
                book_key="juicy",
                selection="Cleveland Guardians",
                line=None,
                price_decimal=2.10,
                price_american=110,
                devig_prob=0.4615,
            )
        ],
        edge_pct=7.6923,
        detected_at="2026-09-04T12:00:00Z",
        consensus_prob=0.5128205,
    )


def arb_detection() -> Detection:
    return Detection(
        type="arb",
        event_id="baseball_mlb:evt1",
        sport_key="baseball_mlb",
        market_key="h2h",
        commence_time="2026-09-05T23:10:00Z",
        legs=[
            OpportunityLeg(
                book_key="dk",
                selection="Detroit Tigers",
                line=None,
                price_decimal=2.00,
                price_american=100,
                devig_prob=0.4872,
                staleness=1.4,
            ),
            OpportunityLeg(
                book_key="juicy",
                selection="Cleveland Guardians",
                line=None,
                price_decimal=2.10,
                price_american=110,
                devig_prob=0.4615,
                staleness=7.0,
                bet_first=True,
            ),
        ],
        edge_pct=2.4390,
        detected_at="2026-09-04T12:00:00Z",
        leg_consensus_books=[5, 5],
    )


def plan(*stakes: int, deep_link: str = "") -> StakePlan:
    legs = [
        StakeLeg(
            book_key=f"book{i}",
            selection=f"sel{i}",
            stake_cents=stake,
            to_win_cents=stake,
            deep_link=deep_link,
            link_level="event" if deep_link else "none",
        )
        for i, stake in enumerate(stakes)
    ]
    return StakePlan(
        total_cents=sum(stakes), legs=legs, method="kelly", guardrails_applied=[]
    )


# ---- +EV embed (§9.2) ------------------------------------------------------


def test_ev_title_carries_edge_book_and_market():
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    assert message.title == "⚡ +EV 7.69% — juicy h2h"
    assert message.color == 0x2DD4BF
    assert message.kind == "ev"


def test_ev_first_line_is_price_against_fair():
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    # fair decimal = 1/0.5128205 = 1.95 -> -105 in American terms
    assert message.lines[0] == "Cleveland Guardians @ +110 · fair -105"


def test_ev_stake_sits_in_a_single_code_span():
    """§9.2 wants one span so a mobile long-press copies the number cleanly."""
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    assert message.lines[1] == "Stake: `$11`"


def test_ev_buttons_match_the_interaction_ids():
    """§9.3 routes on these ids, so they are an interface, not decoration."""
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    assert [b.custom_id for b in message.buttons] == [
        f"rec:{REC_ID}:bet",
        f"rec:{REC_ID}:skip",
        "snooze:baseball_mlb:h2h",
    ]
    assert message.buttons[0].label == "✅ Bet placed"


def test_paper_mode_is_stamped_in_the_footer():
    paper = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    assert paper.footer == "PAPER"

    live = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=False
    )
    assert live.footer != "PAPER"
    assert "juicy" in live.footer


def test_no_link_line_when_no_template_is_verified():
    """§9.4/§16.3 — rendering `[Open juicy](​)` would be a dead control on a real
    money decision, so the line is omitted instead."""
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    assert len(message.lines) == 2
    assert not any("Open" in line for line in message.lines)


def test_link_line_appears_once_a_template_exists():
    message = render_ev(
        ev_detection(),
        plan(1100, deep_link="https://example.test/event/evt1"),
        recommendation_id=REC_ID,
        paper_mode=True,
    )
    assert message.lines[2] == "[Open juicy ➜](https://example.test/event/evt1)"


# ---- arbitrage embed (§9.2) ------------------------------------------------


def test_arb_puts_the_stale_leg_first_regardless_of_detection_order():
    """§9.2: "stale leg always first". The detection listed it second."""
    message = render_arb(
        arb_detection(), plan(4900, 5100), recommendation_id=REC_ID, paper_mode=True
    )
    assert message.title == "🔀 ARB 2.44% — bet leg 1 first"
    assert message.lines[0].startswith("1️⃣ 🔥 STALE — juicy:")
    assert message.lines[1].startswith("2️⃣ dk:")


def test_arb_stakes_follow_the_reordered_legs():
    """The stake shown against a leg must be that leg's stake, not its position's."""
    message = render_arb(
        arb_detection(), plan(4900, 5100), recommendation_id=REC_ID, paper_mode=True
    )
    assert "`$51`" in message.lines[0]  # juicy is index 1 -> 5100
    assert "`$49`" in message.lines[1]  # dk is index 0 -> 4900


def test_arb_closing_line_quotes_the_staleness_and_the_field():
    message = render_arb(
        arb_detection(), plan(4900, 5100), recommendation_id=REC_ID, paper_mode=True
    )
    assert message.lines[-1] == (
        "Leg 1 deviates 7.0σ from consensus; leg 2 matches 5 books."
    )


def test_arb_gives_each_leg_its_own_button():
    message = render_arb(
        arb_detection(), plan(4900, 5100), recommendation_id=REC_ID, paper_mode=True
    )
    assert [b.custom_id for b in message.buttons] == [
        f"rec:{REC_ID}:bet_leg1",
        f"rec:{REC_ID}:bet_leg2",
    ]


def test_render_alert_dispatches_on_type():
    assert render_alert(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    ).kind == "ev"
    assert render_alert(
        arb_detection(), plan(4900, 5100), recommendation_id=REC_ID, paper_mode=True
    ).kind == "arb"


# ---- formatting helpers ----------------------------------------------------


@pytest.mark.parametrize(
    ("cents", "expected"),
    [(1100, "$11"), (2500, "$25"), (1150, "$11.50"), (99, "$0.99"), (0, "$0")],
)
def test_money_drops_a_pointless_decimal(cents, expected):
    assert format_money(cents) == expected


def test_local_time_converts_out_of_utc():
    """§1 stores UTC; only the reader's view is local (§9.2 default is New York)."""
    rendered = format_local_time("2026-09-05T23:10:00Z")
    assert "7:10 PM" in rendered  # 23:10 UTC is 19:10 EDT
    assert "Sat" in rendered


def test_an_unknown_timezone_falls_back_rather_than_failing():
    """A bad tz setting must not take an alert down."""
    assert format_local_time("2026-09-05T23:10:00Z", "Mars/Olympus_Mons")


# ---- sinks -----------------------------------------------------------------


async def test_log_sink_writes_the_rendered_message(caplog):
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    with caplog.at_level(logging.INFO, logger="edgeline.notify.sink"):
        ref = await LogSink().send(message, recommendation_id=REC_ID)

    assert ref.startswith("log:")
    assert "+EV 7.69%" in caplog.text
    assert "Stake: `$11`" in caplog.text


async def test_recording_sink_keeps_what_it_was_given():
    sink = RecordingSink()
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    await sink.send(message, recommendation_id=REC_ID)

    assert len(sink.sent) == 1
    assert sink.sent[0][0] == REC_ID
    assert sink.sent[0][1] is message


async def test_null_sink_returns_no_reference():
    assert await NullSink().send(AlertMessage(kind="ev", title="x"), recommendation_id="r") is None


def test_message_renders_to_plain_text():
    message = render_ev(
        ev_detection(), plan(1100), recommendation_id=REC_ID, paper_mode=True
    )
    text = message.to_text()
    assert text.startswith("⚡ +EV 7.69%")
    assert "— PAPER" in text
    assert "✅ Bet placed" in text

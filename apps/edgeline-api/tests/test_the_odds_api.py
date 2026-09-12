"""The Odds API adapter — spec §8.

Every request here is intercepted by ``respx``. §16.4 forbids a test ever reaching
the live API; the recorded fixtures in ``tests/fixtures/`` are what stands in for
it, and they were captured by the §8 recorder, not by this suite.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest
import respx

from edgeline.providers.base import (
    ProviderAuthError,
    ProviderBudgetExceeded,
    ProviderQuotaExhausted,
    ProviderRateLimited,
    ProviderUnavailable,
    QuotaStatus,
)
from edgeline.providers.the_odds_api import TheOddsApiProvider

HOST = "api.the-odds-api.com"
ODDS_PATH = "/v4/sports/baseball_mlb/odds"
EVENT_ODDS_PATH = "/v4/sports/baseball_mlb/events/evt1/odds"
API_KEY = "test-key-not-a-real-one"


def odds_route():
    return respx.route(method="GET", host=HOST, path=ODDS_PATH)


def provider(**kwargs) -> TheOddsApiProvider:
    kwargs.setdefault("api_key", API_KEY)
    return TheOddsApiProvider(**kwargs)


async def collecting_sleep(delays: list[float]):
    async def _sleep(seconds: float) -> None:
        delays.append(seconds)

    return _sleep


# ---- request shape ---------------------------------------------------------


@respx.mock
async def test_odds_request_asks_for_decimal_and_carries_the_key():
    """§8/§1: decimal at ingest, so no lossy conversion happens before storage."""
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = provider()
    try:
        await p.fetch_odds("baseball_mlb", ["h2h", "spreads", "totals"])
    finally:
        await p.aclose()

    params = odds_route().calls.last.request.url.params
    assert params["oddsFormat"] == "decimal"
    assert params["markets"] == "h2h,spreads,totals"
    assert params["regions"] == "us"
    assert params["apiKey"] == API_KEY


@respx.mock
async def test_event_odds_also_requests_decimal():
    route = respx.route(method="GET", host=HOST, path=EVENT_ODDS_PATH).mock(
        return_value=httpx.Response(200, json={})
    )
    p = provider()
    try:
        await p.fetch_event_odds("baseball_mlb", "evt1", ["batter_home_runs"])
    finally:
        await p.aclose()

    assert route.calls.last.request.url.params["oddsFormat"] == "decimal"


async def test_timeout_is_fifteen_seconds():
    """§8's stated timeout, not httpx's 5s default."""
    p = provider()
    try:
        assert p._get_client().timeout.read == 15.0
    finally:
        await p.aclose()


# ---- quota (§8: the header is truth) --------------------------------------


@respx.mock
async def test_quota_comes_from_the_response_headers():
    odds_route().mock(
        return_value=httpx.Response(
            200,
            json=[],
            headers={"x-requests-used": "137", "x-requests-remaining": "363"},
        )
    )
    p = provider()
    try:
        result = await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    # One request made, but the header says 137 — the header wins, because a
    # retry, a second process or a cached response all desynchronise local math.
    assert result.quota.used == 137
    assert result.quota.remaining == 363
    assert p.quota == result.quota


@respx.mock
async def test_absent_quota_headers_read_as_unknown_not_zero():
    """A missing header must never look like spare capacity to §8.4's budget check."""
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = provider()
    try:
        result = await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert result.quota.used is None
    assert result.quota.remaining is None


@respx.mock
async def test_unparseable_quota_header_is_unknown_not_a_crash():
    odds_route().mock(
        return_value=httpx.Response(200, json=[], headers={"x-requests-used": "n/a"})
    )
    p = provider()
    try:
        result = await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert result.quota.used is None


# ---- HTTP policy (§8) ------------------------------------------------------


@respx.mock
async def test_429_backs_off_by_doubling_and_then_succeeds():
    delays: list[float] = []
    odds_route().side_effect = [
        httpx.Response(429),
        httpx.Response(429),
        httpx.Response(429),
        httpx.Response(200, json=[{"id": "evt1"}]),
    ]
    p = provider(sleep=await collecting_sleep(delays))
    try:
        result = await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert result.payload == [{"id": "evt1"}]
    assert delays == [1.0, 2.0, 4.0]  # ×2, three sleeps across four tries
    assert odds_route().call_count == 4


@respx.mock
async def test_429_gives_up_after_four_tries():
    delays: list[float] = []
    odds_route().mock(return_value=httpx.Response(429))
    p = provider(sleep=await collecting_sleep(delays))
    try:
        with pytest.raises(ProviderRateLimited):
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert odds_route().call_count == 4
    assert delays == [1.0, 2.0, 4.0]  # no sleep after the final failure


@respx.mock
async def test_401_kills_the_cycle_immediately_with_a_clear_message():
    """§8: retrying rejected credentials cannot help, so it must not happen."""
    odds_route().mock(return_value=httpx.Response(401))
    p = provider()
    try:
        with pytest.raises(ProviderAuthError) as excinfo:
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert "API key invalid" in str(excinfo.value)
    assert "ODDS_API_KEY" in str(excinfo.value)
    assert odds_route().call_count == 1


# ---- the pace guard (§8.4, §13) --------------------------------------------
#
# A local refusal, not a provider response. It compares `x-requests-used` against
# where we are in the calendar month and models nothing about what a job ought to
# cost — because the modelled projection covered one of three spending jobs and
# read 360/500 while the real burn was ~6 credits a minute.


def _at(day: int, hour: int = 12):
    return lambda: datetime(2026, 9, day, hour, tzinfo=timezone.utc)


def _armed(used: int, *, day: int, hour: int = 12, budget: int = 500):
    """A provider that already knows what has been spent."""
    p = provider(monthly_budget=budget, now=_at(day, hour))
    p.quota = QuotaStatus(used=used, remaining=budget - used)
    return p


@respx.mock
async def test_spending_ahead_of_the_calendar_is_refused_before_sending():
    """The failure this exists for: on 9 September — 30% through the month —
    roughly 400 of 500 credits were gone. Nothing noticed for another 19 hours."""
    route = odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = _armed(400, day=9)
    try:
        with pytest.raises(ProviderBudgetExceeded) as excinfo:
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    message = str(excinfo.value)
    assert "80%" in message  # spent
    assert "27%" in message or "28%" in message  # elapsed, 9 days into September
    assert "Nothing was sent" in message
    assert route.call_count == 0, "the guard must refuse before the request goes out"


@respx.mock
async def test_spending_in_line_with_the_calendar_is_allowed():
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    # Three quarters through the month, three quarters spent: exactly on pace.
    p = _armed(375, day=23)
    try:
        await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()


@respx.mock
async def test_the_headroom_tolerates_a_lumpy_day():
    """Real usage is not smooth, and a guard that fires on a busy Saturday would
    be turned off. 10% over pace passes; the runaway above does not."""
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = _armed(250, day=15)  # 50% spent, ~47% elapsed — inside 15% headroom
    try:
        await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()


@respx.mock
async def test_a_spent_budget_is_refused_whatever_the_date():
    """Even on the last day of the month, past the budget is past the budget."""
    route = odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = _armed(500, day=30, hour=23)
    try:
        with pytest.raises(ProviderBudgetExceeded):
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()
    assert route.call_count == 0


@respx.mock
async def test_free_endpoints_are_never_refused():
    """Refusing a free request buys nothing back, and would block the arming
    call that teaches the guard what has been spent."""
    sports = respx.route(method="GET", host=HOST, path="/v4/sports").mock(
        return_value=httpx.Response(200, json=[], headers={"x-requests-used": "500"})
    )
    p = _armed(500, day=2)  # far over pace
    try:
        await p.list_sports()
    finally:
        await p.aclose()
    assert sports.call_count == 1


@respx.mock
async def test_an_unarmed_guard_does_not_block_the_first_request():
    """`x-requests-used` only arrives on a response, so a fresh process has no
    number yet. It gets one request, then the guard has truth."""
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = provider(monthly_budget=500, now=_at(2))  # quota.used is None
    try:
        await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()


@respx.mock
async def test_arming_costs_nothing_and_learns_the_number():
    sports = respx.route(method="GET", host=HOST, path="/v4/sports").mock(
        return_value=httpx.Response(
            200, json=[], headers={"x-requests-used": "496", "x-requests-remaining": "4"}
        )
    )
    p = provider(monthly_budget=500, now=_at(10))
    try:
        quota = await p.arm_budget_guard()
    finally:
        await p.aclose()

    assert quota.used == 496
    assert sports.call_count == 1


def test_the_month_fraction_spans_the_whole_month():
    from edgeline.providers.the_odds_api import _month_elapsed_fraction

    assert _month_elapsed_fraction(datetime(2026, 9, 1, tzinfo=timezone.utc)) == 0.0
    mid = _month_elapsed_fraction(datetime(2026, 9, 16, tzinfo=timezone.utc))
    assert 0.49 < mid < 0.51
    # December has to roll the year, not the month.
    assert _month_elapsed_fraction(datetime(2026, 12, 1, tzinfo=timezone.utc)) == 0.0


@respx.mock
async def test_a_spent_quota_is_not_reported_as_a_bad_key():
    """The Odds API answers an exhausted monthly allowance with 401, not 429.

    Reading that as "API key invalid" sends the reader at the one thing that is
    definitely fine — on 2026-09-10 it cost an investigation its first hour,
    with a valid key and 496 of 500 credits spent.
    """
    odds_route().mock(
        return_value=httpx.Response(
            401,
            headers={"x-requests-remaining": "0", "x-requests-used": "500"},
            json={"message": "Usage quota has been reached. Please upgrade."},
        )
    )
    p = provider()
    try:
        with pytest.raises(ProviderQuotaExhausted) as excinfo:
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    message = str(excinfo.value)
    assert "allowance is spent" in message
    assert "remaining 0" in message  # the numbers, not just the verdict
    assert "used 500" in message
    assert "key is valid" in message
    assert "offline_mode" in message  # and what to do about it
    assert odds_route().call_count == 1  # still no retry: backing off cannot help


@respx.mock
async def test_the_body_alone_is_enough_when_no_quota_header_comes_back():
    """Not every endpoint reports `x-requests-remaining` — the free listings do
    not — so the body is the fallback signal rather than an afterthought."""
    odds_route().mock(
        return_value=httpx.Response(
            401, json={"message": "Usage quota has been reached"}
        )
    )
    p = provider()
    try:
        with pytest.raises(ProviderQuotaExhausted):
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()


@respx.mock
async def test_a_genuinely_bad_key_is_still_a_bad_key():
    """The split must not swallow the case it was carved out of."""
    odds_route().mock(
        return_value=httpx.Response(401, json={"message": "Invalid API key"})
    )
    p = provider()
    try:
        with pytest.raises(ProviderAuthError) as excinfo:
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert "API key invalid" in str(excinfo.value)
    assert not isinstance(excinfo.value, ProviderQuotaExhausted)


@respx.mock
@pytest.mark.parametrize("status", [500, 502, 503])
async def test_5xx_skips_the_cycle_without_retrying(status):
    odds_route().mock(return_value=httpx.Response(status))
    p = provider()
    try:
        with pytest.raises(ProviderUnavailable):
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert odds_route().call_count == 1


@respx.mock
async def test_transport_failure_takes_the_skip_cycle_path():
    odds_route().mock(side_effect=httpx.ConnectError("no route to host"))
    p = provider()
    try:
        with pytest.raises(ProviderUnavailable):
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()


@respx.mock
async def test_error_messages_never_leak_the_api_key():
    odds_route().mock(return_value=httpx.Response(500))
    p = provider()
    try:
        with pytest.raises(ProviderUnavailable) as excinfo:
            await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert API_KEY not in str(excinfo.value)


# ---- fixture recorder (§8, debug flag) ------------------------------------


@respx.mock
async def test_recorder_writes_the_body_and_nothing_else(tmp_path):
    payload = [{"id": "evt1", "sport_key": "baseball_mlb"}]
    odds_route().mock(return_value=httpx.Response(200, json=payload))
    p = provider(record_fixtures=True, fixture_dir=tmp_path)
    try:
        await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    written = list(tmp_path.glob("baseball_mlb_odds_*.json"))
    assert len(written) == 1
    text = written[0].read_text(encoding="utf-8")
    assert json.loads(text) == payload
    # The key rides in the query string; a fixture that captured it would be a
    # secret in a committed file (§16.4).
    assert API_KEY not in text


@respx.mock
async def test_recorder_is_off_by_default(tmp_path):
    odds_route().mock(return_value=httpx.Response(200, json=[]))
    p = provider(fixture_dir=tmp_path)
    try:
        await p.fetch_odds("baseball_mlb", ["h2h"])
    finally:
        await p.aclose()

    assert list(tmp_path.glob("*.json")) == []


# ---- replay of the recorded response --------------------------------------


@respx.mock
async def test_recorded_fixture_replays_through_the_adapter(mlb_odds_payload):
    odds_route().mock(
        return_value=httpx.Response(
            200,
            json=mlb_odds_payload,
            headers={"x-requests-used": "3", "x-requests-remaining": "497"},
        )
    )
    p = provider()
    try:
        result = await p.fetch_odds("baseball_mlb", ["h2h", "spreads", "totals"])
    finally:
        await p.aclose()

    assert result.provider_key == "the_odds_api"
    assert result.sport_key == "baseball_mlb"
    assert result.quota.remaining == 497
    assert len(result.payload) == len(mlb_odds_payload)

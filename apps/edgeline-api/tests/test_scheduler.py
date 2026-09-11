"""Worker scheduling and the credit budget — spec §13, §8.4.

The budget check is the reason this file exists. §8.4's production cadence costs
roughly 130x the free tier's monthly allowance, so a worker started on the wrong
interval would burn the month's quota in a few hours and take the system dark
without anyone touching it. §13 makes the check a precondition of starting.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from edgeline.config import Settings
from edgeline.scheduler import (
    FREE_TIER_BUDGET,
    BudgetExceeded,
    check_budget,
    featured_interval_s,
    plan_budget,
    poll_is_due,
)


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


# ---- §8.4's arithmetic -----------------------------------------------------


def test_dev_cadence_still_costs_what_the_spec_budgeted():
    """§8.4 budgeted ~360/month for the dev cadence, and it still is.

    The shape changed on 2026-09-09 — 2 polls/day over 2 regions rather than 4
    over 1 — because `us` alone could not supply the four books §6.4 needs. The
    arithmetic lands in the same place: 2 x 3 markets x 2 regions x 30.
    """
    plan = plan_budget(settings())
    assert plan.featured_interval_s == 43_200
    assert plan.regions == 2
    assert plan.projected_monthly_credits == 360
    assert plan.affordable


def test_each_extra_region_multiplies_the_bill():
    """The reason the poll rate had to halve when `us2` was added."""
    one = plan_budget(settings(regions=["us"]))
    two = plan_budget(settings(regions=["us", "us2"]))
    assert two.projected_monthly_credits == 2 * one.projected_monthly_credits


def test_the_old_six_hour_cadence_would_now_be_unaffordable():
    """Two regions at the previous 6 h rate is 720 against a 500 budget — which
    is precisely what the guard exists to refuse."""
    plan = plan_budget(settings(poll_interval_dev_s=21_600))
    assert plan.projected_monthly_credits == 720
    assert not plan.affordable


def test_offline_mode_costs_nothing_so_no_cadence_is_unaffordable():
    """§3.2. An offline worker makes no provider request, so the guard must not
    refuse to start it over a bill it will never incur — including at the
    production cadence that is otherwise 130x the free tier."""
    plan = plan_budget(settings(offline_mode=True, poll_interval_s=120,
                                quota_monthly_budget=FREE_TIER_BUDGET + 1))
    assert plan.projected_monthly_credits == 0
    assert plan.affordable

    # And the precondition that reads it agrees, rather than raising.
    assert check_budget(settings(offline_mode=True, quota_monthly_budget=1)).affordable


def test_production_cadence_is_far_beyond_the_free_tier():
    """720 polls/day x 3 markets x 2 regions x 30. The mistake worth refusing."""
    plan = plan_budget(settings(quota_monthly_budget=1_000_000, poll_interval_s=120))
    assert plan.featured_interval_s == 120
    assert plan.projected_monthly_credits == 129_600


def test_more_sports_cost_proportionally_more():
    plan = plan_budget(settings(sports_enabled=["baseball_mlb", "americanfootball_nfl"]))
    assert plan.sports == 2
    assert plan.projected_monthly_credits == 720


def test_fewer_markets_cost_less():
    plan = plan_budget(settings(markets_featured=["h2h"]))
    assert plan.projected_monthly_credits == 120


# ---- cadence selection (§13) -----------------------------------------------


def test_the_dev_cadence_applies_while_the_budget_is_the_free_tier():
    assert featured_interval_s(settings()) == settings().poll_interval_dev_s
    assert featured_interval_s(settings(quota_monthly_budget=FREE_TIER_BUDGET)) == 43_200


def test_a_raised_budget_switches_to_the_production_cadence():
    """T4.1 raises the budget once the paid tier is approved; only then does the
    120s cadence become live."""
    assert featured_interval_s(settings(quota_monthly_budget=20_000)) == 120


# ---- the refusal (§13) -----------------------------------------------------


def test_an_affordable_cadence_is_allowed_and_reports_its_cost(caplog):
    import logging

    with caplog.at_level(logging.INFO, logger="edgeline.scheduler"):
        plan = check_budget(settings())
    assert plan.affordable
    assert "360" in caplog.text  # the figure §13 requires be logged


def test_an_unaffordable_cadence_refuses_to_start():
    # Budget just over the free tier, so the 120s cadence is selected, but
    # nowhere near enough to pay for it.
    with pytest.raises(BudgetExceeded) as excinfo:
        check_budget(settings(quota_monthly_budget=FREE_TIER_BUDGET + 1))

    message = str(excinfo.value)
    assert "129600" in message  # what it would cost
    assert "501" in message  # what is allowed
    assert "T4.1" in message  # and how to fix it


def test_the_refusal_names_a_remedy_rather_than_just_failing():
    with pytest.raises(BudgetExceeded) as excinfo:
        check_budget(settings(quota_monthly_budget=1_000, poll_interval_s=120))
    assert "poll_interval_s" in str(excinfo.value)


# ---- job registration (§13) ------------------------------------------------


def test_scheduler_registers_every_job_the_spec_lists():
    from edgeline.scheduler import build_scheduler

    # build_scheduler returns it unstarted, so there is nothing to shut down.
    scheduler = build_scheduler(provider=None, client=None, settings=settings())
    ids = {job.id for job in scheduler.get_jobs()}

    assert "poll_featured:baseball_mlb" in ids
    assert "closing_capture" in ids
    assert "grade" in ids
    assert "quota_reset" in ids
    assert "heartbeat" in ids


def test_one_poll_job_per_enabled_sport():
    from edgeline.scheduler import build_scheduler

    # Two sports at the 120s cadence over two regions cost 259,200/month, so the
    # budget has to clear that or the guard (correctly) refuses before any job is
    # registered.
    scheduler = build_scheduler(
        provider=None,
        client=None,
        settings=settings(sports_enabled=["baseball_mlb", "americanfootball_nfl"],
                          quota_monthly_budget=500_000),
    )
    polls = [job for job in scheduler.get_jobs() if job.id.startswith("poll_featured:")]
    assert len(polls) == 2


def test_building_a_scheduler_over_budget_refuses_before_registering_anything():
    """The check is a precondition of starting, not a warning after the fact."""
    from edgeline.scheduler import build_scheduler

    with pytest.raises(BudgetExceeded):
        build_scheduler(
            provider=None, client=None,
            settings=settings(quota_monthly_budget=FREE_TIER_BUDGET + 1),
        )


def test_a_startup_poll_is_registered_because_the_interval_fires_late():
    """An APScheduler interval job's first fire is a full interval away — 12 h at
    the dev cadence — and this worker is expected to run in short bursts on a
    laptop that sleeps. Without a catch-up job the common case is a worker that
    starts, does nothing, and is stopped."""
    from edgeline.scheduler import build_scheduler

    scheduler = build_scheduler(provider=None, client=None, settings=settings())
    assert "poll_startup" in {job.id for job in scheduler.get_jobs()}


# ---- when that catch-up poll is due (§8.4's budget) -------------------------


class _RuntimeDoc:
    """Just enough ES client for `poll_is_due`: one `get` of the runtime doc."""

    def __init__(self, source: dict | None = None, *, missing: bool = False):
        self._source = source or {}
        self._missing = missing

    async def get(self, **_kwargs):
        if self._missing:
            raise RuntimeError("index_not_found_exception")
        return {"_source": self._source}


def _stamp(**ago) -> str:
    """A `last_poll_at` in `utc_now_iso`'s exact format, that long ago."""
    return (datetime.now(timezone.utc) - timedelta(**ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def test_a_worker_that_has_never_polled_is_due():
    assert await poll_is_due(_RuntimeDoc(), prefix="edgeline-", interval_s=43_200)


async def test_a_poll_inside_the_interval_stands_the_startup_one_down():
    """§8.4's budget pays for the *cadence*, not for the number of times the
    process is restarted. Three restarts in an afternoon must not cost three
    extra cycles on top of the two a day the budget was computed from."""
    doc = _RuntimeDoc({"last_poll_at": _stamp(hours=1)})
    assert not await poll_is_due(doc, prefix="edgeline-", interval_s=43_200)


async def test_a_poll_older_than_the_interval_is_due_again():
    doc = _RuntimeDoc({"last_poll_at": _stamp(hours=13)})
    assert await poll_is_due(doc, prefix="edgeline-", interval_s=43_200)


@pytest.mark.parametrize(
    "doc",
    [_RuntimeDoc(missing=True), _RuntimeDoc({"last_poll_at": "whenever"})],
    ids=["no runtime document", "unparseable stamp"],
)
async def test_an_unreadable_stamp_answers_due(doc):
    """Failing towards one wasted cycle rather than towards a silent worker."""
    assert await poll_is_due(doc, prefix="edgeline-", interval_s=43_200)

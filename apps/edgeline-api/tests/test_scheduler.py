"""Worker scheduling and the credit budget — spec §13, §8.4.

The budget check is the reason this file exists. §8.4's production cadence costs
roughly 130x the free tier's monthly allowance, so a worker started on the wrong
interval would burn the month's quota in a few hours and take the system dark
without anyone touching it. §13 makes the check a precondition of starting.
"""

from __future__ import annotations

import pytest

from edgeline.config import Settings
from edgeline.scheduler import (
    FREE_TIER_BUDGET,
    BudgetExceeded,
    check_budget,
    featured_interval_s,
    plan_budget,
)


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


# ---- §8.4's arithmetic -----------------------------------------------------


def test_dev_cadence_matches_the_figure_in_the_spec():
    """§8.4: "every 6 h (4x/day -> ~360/mo)". 4 x 3 markets x 1 region x 30."""
    plan = plan_budget(settings())
    assert plan.featured_interval_s == 21_600
    assert plan.projected_monthly_credits == 360
    assert plan.affordable


def test_production_cadence_is_far_beyond_the_free_tier():
    """720 polls/day x 3 markets x 30 days. This is the mistake worth refusing."""
    plan = plan_budget(settings(quota_monthly_budget=100_000, poll_interval_s=120))
    assert plan.featured_interval_s == 120
    assert plan.projected_monthly_credits == 64_800


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
    assert featured_interval_s(settings(quota_monthly_budget=FREE_TIER_BUDGET)) == 21_600


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
    assert "64800" in message  # what it would cost
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

    # Two sports at the 120s cadence cost 129,600/month, so the budget has to
    # clear that or the guard (correctly) refuses before any job is registered.
    scheduler = build_scheduler(
        provider=None,
        client=None,
        settings=settings(sports_enabled=["baseball_mlb", "americanfootball_nfl"],
                          quota_monthly_budget=200_000),
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

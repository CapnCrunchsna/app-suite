"""The month-end sidecar's plan and spend guard (`sidecars/month_end_2026_09.py`).

Throwaway like the sidecar; delete the two together. What is pinned here is the
part that costs money if it is wrong: the day fits in what the worker leaves,
the worker's own slot is left alone, and a counter that goes down stops
everything rather than spending October's credits. No datastore, no provider.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import timedelta
from pathlib import Path

import pytest

SIDECAR = Path(__file__).resolve().parents[1] / "sidecars" / "month_end_2026_09.py"
#: `x-requests-remaining` from a free /sports call the evening before.
LEFT_ON_2026_09_29 = 293


@pytest.fixture(scope="module")
def sidecar():
    spec = importlib.util.spec_from_file_location("month_end_2026_09", SIDECAR)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses resolve annotations through it
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop(spec.name, None)


def test_the_day_fits_in_what_the_worker_leaves(sidecar):
    burn = sidecar.at(sidecar.BURN_FROM.strftime("%H:%M"))
    before_burn = [action for action in sidecar.build_plan() if action.at < burn]
    assert sum(action.budgeted for action in before_burn) <= (
        LEFT_ON_2026_09_29 - sidecar.WORKER_RESERVE
    )


def test_the_plan_keeps_to_its_day_and_off_the_workers_slot(sidecar):
    plan = sidecar.build_plan()
    slot = sidecar.at(sidecar.WORKER_SLOT.strftime("%H:%M"))

    assert {action.at.date() for action in plan} == {sidecar.DAY}
    assert not [action for action in plan if action.sport == sidecar.NBA]
    assert not [
        action
        for action in plan
        if action.sport == sidecar.NHL and abs(action.at - slot) < timedelta(minutes=15)
    ]


def test_a_counter_that_goes_down_means_the_allowance_reset(sidecar):
    evening = sidecar.at("20:05")
    verdict = sidecar.spend_decision(
        used=4, remaining=496, last_used=480, cost=6, now=evening
    )
    assert verdict == "reset"


def test_the_workers_credits_are_held_until_its_slot_has_run(sidecar):
    left = {"used": 485, "remaining": 15, "last_used": 470, "cost": 6}
    assert sidecar.spend_decision(**left, now=sidecar.at("12:00")) == "short"
    assert sidecar.spend_decision(**left, now=sidecar.at("18:00")) == "ok"


def test_counters_it_could_not_read_never_spend(sidecar):
    verdict = sidecar.spend_decision(
        used=None, remaining=None, last_used=None, cost=6, now=sidecar.at("12:00")
    )
    assert verdict == "short"


def test_missed_polls_collapse_to_the_latest_and_missed_closes_are_dropped(sidecar):
    Action, at = sidecar.Action, sidecar.at
    due = [
        Action(at("07:30"), "poll", sidecar.NCAAF),
        Action(at("08:15"), "poll", sidecar.NCAAF),
        Action(at("08:00"), "poll", sidecar.NHL),
        Action(at("13:56"), "close", sidecar.MLB, window_s=600),
    ]

    kept = sidecar.coalesce(due, now=at("14:30"))

    assert kept == [
        Action(at("08:00"), "poll", sidecar.NHL),
        Action(at("08:15"), "poll", sidecar.NCAAF),
    ]

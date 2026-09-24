"""Worker scheduling and the credit budget — spec §13, §8.4.

The budget check is the reason this file exists. §8.4's production cadence costs
roughly 130x the free tier's monthly allowance, so a worker started on the wrong
interval would burn the month's quota in a few hours and take the system dark
without anyone touching it. §13 makes the check a precondition of starting.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from edgeline.config import WEEKDAYS, PollSlot, Settings
from edgeline.scheduler import (
    FREE_TIER_BUDGET,
    PLAN_TIMEZONE,
    SCHEDULED_POLL_GRACE_S,
    BudgetExceeded,
    ScheduledPoll,
    active_sports,
    check_budget,
    featured_interval_s,
    missed_slots,
    next_poll,
    plan_budget,
    poll_is_due,
    realign_target,
    scheduled_polls,
    slot_due_at,
    sports_for_poll_now,
    stand_down_reason,
)


def settings(**overrides) -> Settings:
    return Settings().model_copy(update=overrides)


def interval(**overrides) -> Settings:
    """The interval cadence: §3.2's defaults with the weekly plan emptied, which
    is how the interval comes back (§13). What every test written before the plan
    existed was about."""
    return settings(poll_schedule=[], **overrides)


# ---- §8.4's arithmetic -----------------------------------------------------


def test_dev_cadence_still_costs_what_the_spec_budgeted():
    """§8.4 budgeted ~360/month for the dev cadence, and it still is.

    The shape changed on 2026-09-09 — 2 polls/day over 2 regions rather than 4
    over 1 — because `us` alone could not supply the four books §6.4 needs. The
    arithmetic lands in the same place: 2 x 3 markets x 2 regions x 30.
    """
    plan = plan_budget(interval())
    assert not plan.scheduled
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
    plan = plan_budget(interval(poll_interval_dev_s=21_600))
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
    plan = plan_budget(interval(sports_enabled=["baseball_mlb", "americanfootball_nfl"]))
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
    scheduler = build_scheduler(provider=None, client=None, settings=interval())
    ids = {job.id for job in scheduler.get_jobs()}

    assert "poll_featured:baseball_mlb" in ids
    assert "closing_capture" in ids
    assert "grade" in ids
    assert "quota_reset" in ids
    assert "heartbeat" in ids
    assert "poll_realign" in ids


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


def test_a_slot_missed_while_the_laptop_slept_runs_on_wake_instead_of_being_dropped():
    """APScheduler's default `misfire_grace_time` is one second: a run that fires
    later than that is discarded with a warning and rescheduled a full interval
    away. This worker runs on a laptop that sleeps for hours, so that default
    silently converts "twice a day" into "whenever the process is restarted".

    Measured 2026-09-15 — the machine slept 03:36–19:35 UTC, the 14:01 poll slot
    fell inside it, and the worker then sat up for 21 hours on a 12-hour cadence
    without polling once. It looked healthy the whole time: the heartbeat is a
    separate 60-second job, and its missed beat is replaced a minute later, so
    `/health` stayed fresh while nothing was being fetched. The nightly grade
    lands at 06:00 UTC, which on this machine is almost always inside a sleep,
    and a `quota_reset` skipped for being late is skipped for a month — after
    which the pace guard refuses every paid request against last month's spend.

    `coalesce` is asserted with it: without it, a sixteen-hour sleep would fire
    one cycle per missed slot on wake and bill §8.4's budget for the uptime
    rather than the cadence.
    """
    from edgeline.scheduler import build_scheduler

    scheduler = build_scheduler(provider=None, client=None, settings=interval())
    must_catch_up = {
        "poll_featured:baseball_mlb",
        "closing_capture",
        "grade",
        "quota_reset",
    }
    jobs = {job.id: job for job in scheduler.get_jobs()}
    assert must_catch_up <= set(jobs), "a job that must catch up is not registered"

    for job_id in must_catch_up:
        job = jobs[job_id]
        # The scheduler is unstarted, so these attributes exist only where the
        # job set them — APScheduler fills its own defaults in at start, which is
        # exactly what must not happen here.
        assert getattr(job, "misfire_grace_time", 1) is None, (
            f"{job_id} would be dropped when it fires late"
        )
        assert getattr(job, "coalesce", False) is True, (
            f"{job_id} would fire once per slot missed during a sleep"
        )


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


@pytest.mark.es
async def test_no_scheduled_job_touches_the_provider_while_offline(
    es_url, test_index_prefix
):
    """The exhaustiveness check, written because per-caller guarding missed one.

    `offline_mode` first guarded `run_once` and `capture_closing_lines` — the two
    obvious seams — and shipped. `grading.grade` is the third: it calls
    `/v4/scores`, which costs 2 credits with `daysFrom`, and the startup grade
    spent them roughly twenty seconds after the first offline worker started.

    So this does not name the seams. It runs **every registered job** against a
    provider that raises on any method, and asserts none of them raised. A fourth
    seam added later fails here without anyone remembering to update a list.
    """
    from elasticsearch import AsyncElasticsearch

    from edgeline.es import ensure_indices
    from edgeline.scheduler import build_scheduler

    touched: list[str] = []

    class _Recorder:
        """Records instead of raising, deliberately.

        Every job body wraps its work in `except Exception`, so a provider that
        raised would be caught and logged and this test would pass while the
        credits were spent — which is precisely how the real miss stayed
        invisible. A record the assertion reads afterwards cannot be swallowed.
        """

        key = "the_odds_api"

        def __getattr__(self, name: str):
            async def _record(*_args, **_kwargs):
                touched.append(name)

            return _record

    client = AsyncElasticsearch(hosts=[es_url])
    prefix = test_index_prefix
    try:
        await ensure_indices(client, prefix=prefix)
        await client.update(
            index=f"{prefix}settings",
            id="global",
            doc={"offline_mode": True},
            doc_as_upsert=True,
            refresh="wait_for",
        )
        scheduler = build_scheduler(
            provider=_Recorder(), client=client,
            settings=settings(offline_mode=True), prefix=prefix,
        )

        for job in scheduler.get_jobs():
            # `reset_quota` and `heartbeat` take their arguments as kwargs; the
            # rest close over what they need. Both shapes are covered by calling
            # with the job's own registered arguments.
            await job.func(*job.args, **job.kwargs)

        assert touched == [], f"offline_mode still reached the provider: {touched}"
    finally:
        await client.close()


async def test_an_offline_cycle_does_not_stamp_last_poll_at():
    """`last_poll_at` means "odds were fetched at", and `poll_is_due` reads it.

    Stamping it for a cycle that fetched nothing makes `/health` show fresh data
    over stale rows, and makes the first run after coming back online skip its
    catch-up poll — leaving a real poll up to twelve hours away, which is the
    failure `poll_startup` was added to prevent. Found live on 2026-09-10: the
    offline worker's first tick stamped it within seconds of starting.
    """
    from edgeline.engine import CycleReport
    from edgeline.scheduler import build_scheduler

    stamped: list[str] = []

    class _Client:
        async def update(self, **kwargs):
            stamped.append(kwargs.get("id", ""))

    class _Provider:
        key = "the_odds_api"

    async def _offline_run_once(*_args, **kwargs):
        report = CycleReport(sport_key=kwargs.get("sport_key", "baseball_mlb"))
        report.offline = True
        return report

    import edgeline.engine as engine_module

    original = engine_module.run_once
    engine_module.run_once = _offline_run_once
    try:
        scheduler = build_scheduler(
            provider=_Provider(), client=_Client(), settings=interval(offline_mode=True)
        )
        poll = scheduler.get_job("poll_featured:baseball_mlb")
        await poll.func("baseball_mlb")
    finally:
        engine_module.run_once = original

    assert stamped == [], "an offline cycle must not claim a poll happened"


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


# ---- when a cycle fails (2026-09-17) ---------------------------------------


def _scheduler_with(
    run_once=None,
    grade=None,
    load_settings=None,
    client=None,
    *,
    awaiting=None,
    capture=None,
    config=None,
    provider=None,
    start=True,
):
    """A started scheduler whose engine calls are stubs.

    `build_scheduler` imports `run_once`, `grade`, `load_settings`,
    `capture_closing_lines` and `sports_awaiting_settlement` into its own
    closure, so the stubs have to be in place *before* it is called — the same
    ordering `test_an_offline_cycle_does_not_stamp_last_poll_at` relies on.
    The two startup catch-up jobs are removed: they would fire against these
    stubs seconds later and this is a test about scheduling, not about them.

    `config` defaults to the interval, which is what the tests written before
    the weekly plan are about; the plan's own tests pass `Settings()`.
    `start=False` returns it unstarted with every job still registered, for a
    test that drives `poll_startup` itself.
    """
    import edgeline.engine as engine_module
    import edgeline.grading as grading_module

    from edgeline.scheduler import build_scheduler

    originals = (
        engine_module.run_once,
        engine_module.load_settings,
        engine_module.capture_closing_lines,
        grading_module.grade,
        grading_module.sports_awaiting_settlement,
    )
    if run_once is not None:
        engine_module.run_once = run_once
    if load_settings is not None:
        engine_module.load_settings = load_settings
    if capture is not None:
        engine_module.capture_closing_lines = capture
    if grade is not None:
        grading_module.grade = grade
    if awaiting is not None:
        grading_module.sports_awaiting_settlement = awaiting
    try:
        scheduler = build_scheduler(
            provider=provider, client=client, settings=config or interval()
        )
    finally:
        (
            engine_module.run_once,
            engine_module.load_settings,
            engine_module.capture_closing_lines,
            grading_module.grade,
            grading_module.sports_awaiting_settlement,
        ) = originals

    if not start:
        return scheduler
    scheduler.start()
    scheduler.remove_job("poll_startup")
    scheduler.remove_job("grade_startup")
    return scheduler


async def test_a_failed_poll_retries_in_a_minute_rather_than_in_ten_hours():
    """Measured 2026-09-17, in the worker's own log: the catch-up poll fired
    seconds after the machine woke, resolved `api.the-odds-api.com` to
    `[Errno 11001] getaddrinfo failed`, logged the traceback — and APScheduler's
    next attempt was **ten hours away**. A whole cycle lost to a DNS lookup that
    would have worked a minute later, on a system whose whole job is to look at
    a market before it starts.
    """
    from edgeline.providers.base import ProviderUnavailable

    async def _unreachable(*_args, **_kwargs):
        raise ProviderUnavailable("The Odds API /odds unreachable: ConnectError")

    scheduler = _scheduler_with(run_once=_unreachable)
    try:
        await scheduler.get_job("poll_featured:baseball_mlb").func("baseball_mlb")

        retry = scheduler.get_job("retry:poll baseball_mlb:2")
        assert retry is not None, "a failed cycle must book another attempt"
        seconds = (retry.next_run_time - datetime.now(timezone.utc)).total_seconds()
        assert 30 < seconds <= 60, f"first retry should be a minute out, was {seconds}s"
    finally:
        scheduler.shutdown(wait=False)


async def test_the_retry_stops_instead_of_hammering_an_unreachable_provider(caplog):
    """Three delays and done. A provider still unreachable twenty minutes later
    is not a transient, and the next scheduled run is the right place to wait."""
    import logging

    from edgeline.providers.base import ProviderUnavailable

    async def _unreachable(*_args, **_kwargs):
        raise ProviderUnavailable("still down")

    scheduler = _scheduler_with(run_once=_unreachable)
    try:
        with caplog.at_level(logging.ERROR, logger="edgeline.scheduler"):
            # The attempt after the last delay in RETRY_DELAYS_S.
            await scheduler.get_job("poll_featured:baseball_mlb").func("baseball_mlb", 4)

        assert scheduler.get_job("retry:poll baseball_mlb:5") is None
        assert "leaving it to the next scheduled run" in caplog.text
    finally:
        scheduler.shutdown(wait=False)


async def test_the_pace_guards_refusal_is_not_retried():
    """Nothing was sent, and nothing will be different in a minute: the guard is
    comparing spend against the month, not reporting an outage. Retrying it would
    turn one honest refusal into four log lines and no poll."""
    from edgeline.providers.base import ProviderBudgetExceeded

    async def _refused(*_args, **_kwargs):
        raise ProviderBudgetExceeded("refusing /odds: 480 of 500 monthly credits spent")

    scheduler = _scheduler_with(run_once=_refused)
    try:
        await scheduler.get_job("poll_featured:baseball_mlb").func("baseball_mlb")
        assert scheduler.get_job("retry:poll baseball_mlb:2") is None
    finally:
        scheduler.shutdown(wait=False)


async def test_a_failed_grading_run_retries_because_it_only_comes_round_once_a_day():
    """`grade` is a daily cron that also fires on wake, so "try again tomorrow"
    leaves the ledger a day behind over a blip that lasted seconds."""

    async def _grade_fails(*_args, **_kwargs):
        raise RuntimeError("scores unreachable")

    class _Client:
        async def get(self, **_kwargs):
            return {"_source": {}}  # §3.2 defaults, one sport enabled

    scheduler = _scheduler_with(grade=_grade_fails, client=_Client())
    try:
        await scheduler.get_job("grade").func()
        assert scheduler.get_job("retry:grade:2") is not None
    finally:
        scheduler.shutdown(wait=False)


async def test_the_closing_sweep_skips_a_tick_when_settings_are_unreadable(caplog):
    """It runs every 60 s, so the next tick has them. What it must not do is
    raise: since 2026-09-15 an unreadable document raises rather than becoming
    §3.2 defaults, and every sleep/resume makes one read unreadable — which would
    otherwise put a traceback in the log twice a day forever."""
    import logging

    from elastic_transport import ConnectionTimeout

    async def _unreadable(*_args, **_kwargs):
        raise ConnectionTimeout("Connection timed out")

    scheduler = _scheduler_with(load_settings=_unreadable)
    try:
        with caplog.at_level(logging.WARNING, logger="edgeline.scheduler"):
            await scheduler.get_job("closing_capture").func()
        assert "skipping a tick" in caplog.text
    finally:
        scheduler.shutdown(wait=False)


# ---- re-anchoring the cadence on the poll that actually landed -------------


def test_the_cadence_is_measured_from_the_last_poll_not_from_process_start():
    """§10's button, `engine --once` and a second process can all land a poll
    this scheduler never fired. Pressing the button two hours before a scheduled
    slot used to buy the same market twice — §8.4's budget pays for the cadence,
    not for how often someone presses a button."""
    now = datetime.now(timezone.utc)
    manual = now - timedelta(hours=2)

    target = realign_target(
        manual.strftime("%Y-%m-%dT%H:%M:%SZ"), interval_s=43_200, now=now
    )

    assert target is not None
    # Twelve hours after the poll that landed, not after the process started.
    assert abs((target - (manual + timedelta(seconds=43_200))).total_seconds()) < 1


def test_a_poll_older_than_the_interval_is_left_to_the_misfire_path():
    """The target has passed, so the poll is *overdue* rather than early —
    `RUN_WHEN_LATE` fires it on the next wake and pulling it earlier here would
    only race that."""
    now = datetime.now(timezone.utc)
    stamp = (now - timedelta(hours=20)).strftime("%Y-%m-%dT%H:%M:%SZ")

    assert realign_target(stamp, interval_s=43_200, now=now) is None


@pytest.mark.parametrize("stamp", [None, "", "whenever"], ids=["none", "empty", "junk"])
def test_an_unreadable_stamp_re_anchors_nothing(stamp):
    """Opposite direction to `poll_is_due`, deliberately: there, an unreadable
    stamp means poll anyway, because one wasted cycle beats a silent worker.
    Here it means leave the schedule alone, because moving a fire time on a
    guess is how a cadence stops meaning anything."""
    assert realign_target(stamp, interval_s=43_200, now=datetime.now(timezone.utc)) is None


async def test_a_manual_poll_pushes_the_next_scheduled_one_a_full_interval_out():
    """The job that does it, against a running scheduler.

    `poll_realign` reads the same `last_poll_at` the button stamps and moves the
    interval job's next fire to one interval past it. Without this the button is
    a second poll rather than a rescheduled one.
    """
    from edgeline.scheduler import build_scheduler

    now = datetime.now(timezone.utc)
    manual = now - timedelta(hours=1)

    class _Client:
        async def get(self, **_kwargs):
            return {"_source": {"last_poll_at": manual.strftime("%Y-%m-%dT%H:%M:%SZ")}}

    scheduler = build_scheduler(provider=None, client=_Client(), settings=interval())
    scheduler.start()
    try:
        # The catch-up jobs would fire against a `None` provider a few seconds
        # in; this test is about the schedule, not about them.
        scheduler.remove_job("poll_startup")
        scheduler.remove_job("grade_startup")

        poll = scheduler.get_job("poll_featured:baseball_mlb")
        # Where an interval anchored to process start would have put it.
        stale = now + timedelta(minutes=10)
        scheduler.modify_job(poll.id, next_run_time=stale)

        await scheduler.get_job("poll_realign").func()

        moved = scheduler.get_job(poll.id).next_run_time
        assert abs((moved - (manual + timedelta(seconds=43_200))).total_seconds()) < 2
        assert moved > stale, "the next poll must move out, not stay where it was"
    finally:
        scheduler.shutdown(wait=False)


async def test_re_anchoring_leaves_the_schedulers_own_poll_alone():
    """A poll this scheduler fired stamps `last_poll_at` seconds after the fire,
    so without a tolerance every cycle would look like an outside poll and the
    schedule would drift by those few seconds every minute."""
    from edgeline.scheduler import build_scheduler

    now = datetime.now(timezone.utc)
    # Fired 12 h ago by this scheduler, stamped 4 s later: the next fire is
    # already where it should be, give or take those four seconds.
    own_poll = now - timedelta(seconds=43_200) + timedelta(seconds=4)

    class _Client:
        async def get(self, **_kwargs):
            return {"_source": {"last_poll_at": own_poll.strftime("%Y-%m-%dT%H:%M:%SZ")}}

    scheduler = build_scheduler(provider=None, client=_Client(), settings=interval())
    scheduler.start()
    try:
        scheduler.remove_job("poll_startup")
        scheduler.remove_job("grade_startup")
        poll = scheduler.get_job("poll_featured:baseball_mlb")
        untouched = now + timedelta(seconds=10)
        scheduler.modify_job(poll.id, next_run_time=untouched)

        await scheduler.get_job("poll_realign").func()

        assert scheduler.get_job(poll.id).next_run_time == untouched
    finally:
        scheduler.shutdown(wait=False)


# ---- the weekly plan (§3.2 `poll_schedule`, §13, added 2026-09-23) ----------

EVERY_DAY = list(WEEKDAYS)


def plan(*rows: tuple[list[str], str, str], **overrides) -> Settings:
    """Settings whose weekly plan is exactly `rows` of (days, "HH:MM", sport)."""
    slots = [PollSlot(days=days, time=time, sport=sport) for days, time, sport in rows]
    return settings(poll_schedule=slots, **overrides)


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


def _iso(when: datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


class _Runtime:
    """An ES client holding one `runtime` document and recording every write."""

    def __init__(self, source: dict | None = None):
        self.source = source or {}
        self.updates: list[dict] = []

    async def get(self, **_kwargs):
        return {"_source": self.source}

    async def update(self, **kwargs):
        self.updates.append(kwargs)


class _Provider:
    """Enough of an adapter for a poll that succeeds: a key and a quota."""

    key = "the_odds_api"

    def __init__(self):
        from edgeline.providers.base import QuotaStatus

        self.quota = QuotaStatus()


def _recording_run_once(polled: list[str]):
    from edgeline.engine import CycleReport

    async def _run_once(*_args, **kwargs):
        polled.append(kwargs["sport_key"])
        return CycleReport(sport_key=kwargs["sport_key"])

    return _run_once


def test_the_default_plan_costs_what_the_twelve_hour_interval_did():
    """14 polls a week x 3 markets x 2 regions x 30/7 = 360: the budget the dev
    cadence has been sized to since 2026-09-09, so moving to fixed times buys
    better placement rather than more polls."""
    budget = plan_budget(Settings())
    assert budget.scheduled
    assert budget.scheduled_polls_per_week == 14
    assert budget.sports == 4
    assert budget.projected_monthly_credits == 360
    assert budget.affordable


def test_a_plan_over_budget_refuses_to_start_and_names_the_setting_to_trim():
    heavy = plan(
        (EVERY_DAY, "11:00", "icehockey_nhl"),
        (EVERY_DAY, "15:00", "icehockey_nhl"),
        (EVERY_DAY, "19:00", "icehockey_nhl"),
    )
    # 21 a week x 6 credits x 30/7 = 540, against 500.
    with pytest.raises(BudgetExceeded) as excinfo:
        check_budget(heavy)
    assert "540" in str(excinfo.value)
    assert "poll_schedule" in str(excinfo.value)


def test_the_weekly_projection_rounds_up_rather_than_under_reporting():
    """15 polls a week is 385.7 credits a month. The guard's whole job is to
    refuse, so it must see 386."""
    fifteen = plan(
        (EVERY_DAY, "12:00", "icehockey_nhl"),
        (EVERY_DAY, "17:00", "icehockey_nhl"),
        (["sun"], "20:00", "icehockey_nhl"),
    )
    assert plan_budget(fifteen).projected_monthly_credits == 386


def test_two_rows_naming_the_same_poll_are_one_poll_and_one_charge():
    """The scheduler registers one job per day, time and sport, so the budget
    must count what it registers rather than the rows that asked."""
    doubled = plan(
        (["sat"], "10:30", "americanfootball_ncaaf"),
        (["sat", "sun"], "10:30", "americanfootball_ncaaf"),
    )
    assert [poll.job_id for poll in scheduled_polls(doubled)] == [
        "poll_scheduled:sat:1030:americanfootball_ncaaf",
        "poll_scheduled:sun:1030:americanfootball_ncaaf",
    ]
    assert plan_budget(doubled).scheduled_polls_per_week == 2


def test_above_the_free_tier_the_production_interval_replaces_the_plan():
    """The plan is the free tier's cadence. T4.1's raised budget selects the
    120 s production interval exactly as it did before the plan existed."""
    from edgeline.scheduler import build_scheduler

    paid = settings(quota_monthly_budget=1_000_000)
    assert scheduled_polls(paid) == []
    assert plan_budget(paid).featured_interval_s == 120

    ids = {job.id for job in build_scheduler(provider=None, client=None, settings=paid).get_jobs()}
    assert "poll_featured:baseball_mlb" in ids
    assert not any(job_id.startswith("poll_scheduled:") for job_id in ids)


def test_the_plan_registers_one_cron_job_per_slot_and_no_interval():
    from edgeline.scheduler import build_scheduler

    ids = {job.id for job in build_scheduler(provider=None, client=None, settings=Settings()).get_jobs()}
    slots = {job_id for job_id in ids if job_id.startswith("poll_scheduled:")}

    assert len(slots) == 14
    assert "poll_scheduled:sun:1130:americanfootball_nfl" in slots
    assert "poll_scheduled:tue:1730:icehockey_nhl" in slots
    assert "poll_scheduled:tue:1730:basketball_nba" in slots
    assert not any(job_id.startswith("poll_featured:") for job_id in ids)
    # Re-anchoring an interval has nothing to do on a plan of clock times, and
    # must never reach into a slot's job.
    assert "poll_realign" not in ids
    assert {"poll_startup", "closing_capture", "grade", "grade_startup",
            "quota_reset", "heartbeat"} <= ids


def test_a_slot_keeps_its_eastern_time_across_the_november_clock_change():
    """The games keep Eastern time through DST, so the slot does, and its UTC
    fire time moves: Saturday 10:30 is 14:30 UTC in October, 15:30 in November."""
    from edgeline.scheduler import build_scheduler

    scheduler = build_scheduler(provider=None, client=None, settings=Settings())
    trigger = scheduler.get_job("poll_scheduled:sat:1030:americanfootball_ncaaf").trigger

    assert str(trigger.timezone) == PLAN_TIMEZONE
    october = trigger.get_next_fire_time(None, _utc("2026-10-01T00:00:00"))
    november = trigger.get_next_fire_time(None, _utc("2026-11-02T00:00:00"))
    assert october.astimezone(timezone.utc) == _utc("2026-10-03T14:30:00")
    assert november.astimezone(timezone.utc) == _utc("2026-11-07T15:30:00")


def test_a_slot_may_run_ninety_minutes_late_and_no_later():
    """Not the interval's `RUN_WHEN_LATE`. A slot is placed for games about to
    start, and a 17:30 poll noticed at 23:00 would price games already under way,
    which §7.4 refuses to detect on. Ninety minutes is the lead the plan's slots
    were placed with; the Monday/Thursday 18:45 NFL slot's one game kicks off at
    20:15. `coalesce` still makes a sleep across a slot cost one poll."""
    from edgeline.scheduler import build_scheduler

    jobs = {job.id: job for job in
            build_scheduler(provider=None, client=None, settings=Settings()).get_jobs()}
    slots = [job for job_id, job in jobs.items() if job_id.startswith("poll_scheduled:")]

    assert slots
    for job in slots:
        assert job.misfire_grace_time == SCHEDULED_POLL_GRACE_S == 90 * 60
        assert job.coalesce is True
    # The jobs whose value does not expire still run however late (2026-09-15).
    for job_id in ("closing_capture", "grade", "quota_reset"):
        assert jobs[job_id].misfire_grace_time is None


# The Tuesday 17:30 ET slot on 2026-09-29, which is 21:30 UTC.
_DUE = _utc("2026-09-29T21:30:00")


def _stamps(sport: str, at: datetime, source: str) -> dict:
    return {
        "last_poll_at": _iso(at),
        "last_poll_at_by_sport": {sport: _iso(at)},
        "last_poll_source_by_sport": {sport: source},
    }


def test_the_button_pressed_an_hour_before_a_slot_stands_it_down():
    """The press already bought what the slot was budgeted for (§8.4)."""
    runtime = _stamps("icehockey_nhl", _DUE - timedelta(hours=1), "manual")
    reason = stand_down_reason(runtime, "icehockey_nhl", due=_DUE, now=_DUE)
    assert reason is not None and "manual" in reason


def test_a_press_more_than_three_hours_back_does_not():
    runtime = _stamps("icehockey_nhl", _DUE - timedelta(hours=3, minutes=1), "manual")
    assert stand_down_reason(runtime, "icehockey_nhl", due=_DUE, now=_DUE) is None


def test_another_sports_poll_does_not_stand_this_one_down():
    """The reason the stamps are per sport: at 17:30 on a Tuesday the plan buys
    NHL and NBA, and pressing the button for one says nothing about the other."""
    runtime = _stamps("basketball_nba", _DUE - timedelta(minutes=5), "manual")
    assert stand_down_reason(runtime, "icehockey_nhl", due=_DUE, now=_DUE) is None


def test_the_plans_own_earlier_poll_never_stands_a_slot_down():
    """Otherwise a plan with two slots close together, or a slot that ran late
    inside its grace, would lose the next slot every time while `--check-budget`
    went on counting it."""
    runtime = _stamps("icehockey_nhl", _DUE - timedelta(hours=1), "schedule")
    assert stand_down_reason(runtime, "icehockey_nhl", due=_DUE, now=_DUE) is None


def test_a_slot_already_served_is_not_bought_twice():
    """A worker restarted inside the grace window owes the slot from
    `poll_startup`; the first run's stamp is what says it was paid for."""
    runtime = _stamps("icehockey_nhl", _DUE + timedelta(seconds=4), "schedule")
    reason = stand_down_reason(
        runtime, "icehockey_nhl", due=_DUE, now=_DUE + timedelta(minutes=30)
    )
    assert reason is not None and "already polled" in reason


@pytest.mark.parametrize(
    "runtime",
    [
        {},
        {"last_poll_at_by_sport": "junk"},
        {"last_poll_at_by_sport": {"icehockey_nhl": "whenever"}},
        # The global stamp alone says nothing about *this* sport.
        {"last_poll_at": _iso(_DUE - timedelta(minutes=5))},
    ],
    ids=["no stamps", "not a map", "unparseable", "global stamp only"],
)
def test_stamps_that_cannot_be_read_answer_poll(runtime):
    """`poll_is_due`'s direction: one wasted cycle beats a plan that stops."""
    assert stand_down_reason(runtime, "icehockey_nhl", due=_DUE, now=_DUE) is None


def test_a_slot_comes_due_at_its_latest_eastern_occurrence():
    poll = ScheduledPoll("sun", "11:30", "americanfootball_nfl")
    # Sunday 2026-09-27, 12:00 EDT: today's 11:30, which is 15:30 UTC.
    assert slot_due_at(poll, _utc("2026-09-27T16:00:00")) == _utc("2026-09-27T15:30:00")
    # Earlier that Sunday, the latest one is a week back.
    assert slot_due_at(poll, _utc("2026-09-27T15:00:00")) == _utc("2026-09-20T15:30:00")
    # Once the clocks go back on 2026-11-01, 11:30 Eastern is 16:30 UTC.
    assert slot_due_at(poll, _utc("2026-11-01T17:00:00")) == _utc("2026-11-01T16:30:00")


def test_a_start_owes_only_the_slots_inside_the_grace_window():
    polls = scheduled_polls(Settings())
    owed = missed_slots(polls, _DUE + timedelta(minutes=90))
    assert {poll.sport for poll in owed} == {"icehockey_nhl", "basketball_nba"}
    assert missed_slots(polls, _DUE + timedelta(minutes=91)) == []


@pytest.mark.parametrize(
    "when, expected",
    [
        ("2026-09-29T16:00:00", ["basketball_nba", "icehockey_nhl"]),
        ("2026-09-27T16:00:00", ["americanfootball_nfl"]),
        ("2026-09-26T16:00:00", ["americanfootball_ncaaf"]),
        # 01:00 UTC on Monday is still Sunday evening in Eastern time.
        ("2026-09-28T01:00:00", ["americanfootball_nfl"]),
    ],
    ids=["tuesday", "sunday", "saturday", "sunday night in UTC's monday"],
)
def test_poll_now_buys_todays_slate_by_the_plans_own_calendar(when, expected):
    assert sports_for_poll_now(Settings(), _utc(when)) == expected


def test_poll_now_falls_back_to_the_enabled_sports():
    tuesday = _utc("2026-09-29T16:00:00")
    assert sports_for_poll_now(interval(), tuesday) == ["baseball_mlb"]
    sundays_only = plan((["sun"], "11:30", "americanfootball_nfl"))
    assert sports_for_poll_now(sundays_only, tuesday) == ["baseball_mlb"]


def test_the_sports_a_poll_can_reach_include_the_plans():
    """What the closing sweep covers, and grading's fallback."""
    assert active_sports(Settings()) == [
        "baseball_mlb",
        "basketball_nba",
        "americanfootball_nfl",
        "icehockey_nhl",
        "americanfootball_ncaaf",
    ]
    # Above the free tier the plan is not in effect, so it reaches nothing.
    assert active_sports(settings(quota_monthly_budget=1_000_000)) == ["baseball_mlb"]


def test_next_poll_names_the_earliest_slot_and_every_sport_due_then():
    class _Job:
        def __init__(self, job_id, when, *args):
            self.id, self.next_run_time, self.args = job_id, when, list(args)

    jobs = [
        _Job("poll_scheduled:tue:1730:icehockey_nhl", _DUE, "tue", "17:30", "icehockey_nhl"),
        _Job("poll_scheduled:tue:1730:basketball_nba", _DUE, "tue", "17:30", "basketball_nba"),
        _Job("poll_scheduled:sat:1030:americanfootball_ncaaf", _DUE + timedelta(days=4),
             "sat", "10:30", "americanfootball_ncaaf"),
        _Job("heartbeat", _DUE - timedelta(hours=1)),
    ]
    assert next_poll(jobs) == {
        "next_poll_at": "2026-09-29T21:30:00Z",
        "next_poll_sports": ["icehockey_nhl", "basketball_nba"],
    }
    assert next_poll([]) == {"next_poll_at": None, "next_poll_sports": []}


async def test_a_slot_stands_down_when_the_button_just_bought_its_sport():
    polled: list[str] = []
    recent = _stamps("icehockey_nhl", datetime.now(timezone.utc) - timedelta(minutes=40), "manual")
    scheduler = _scheduler_with(
        run_once=_recording_run_once(polled), client=_Runtime(recent), config=Settings()
    )
    try:
        job = scheduler.get_job("poll_scheduled:tue:1730:icehockey_nhl")
        await job.func(*job.args)
        assert polled == []
    finally:
        scheduler.shutdown(wait=False)


async def test_a_slot_that_polls_stamps_its_sport_as_the_plans():
    polled: list[str] = []
    client = _Runtime()
    scheduler = _scheduler_with(
        run_once=_recording_run_once(polled), client=client, config=Settings(),
        provider=_Provider(),
    )
    try:
        job = scheduler.get_job("poll_scheduled:sat:1030:americanfootball_ncaaf")
        await job.func(*job.args)
    finally:
        scheduler.shutdown(wait=False)

    assert polled == ["americanfootball_ncaaf"]
    doc = client.updates[-1]["doc"]
    assert doc["last_poll_source_by_sport"] == {"americanfootball_ncaaf": "schedule"}
    assert doc["last_poll_at_by_sport"]["americanfootball_ncaaf"] == doc["last_poll_at"]


async def test_a_worker_started_just_after_a_slot_still_runs_it():
    """A slot that came due while the worker was down is owed on the same terms
    as one slept through: inside the grace window, once."""
    polled: list[str] = []
    due = datetime.now(timezone.utc).astimezone(ZoneInfo(PLAN_TIMEZONE)) - timedelta(minutes=30)
    config = plan(([WEEKDAYS[due.weekday()]], due.strftime("%H:%M"), "icehockey_nhl"))

    scheduler = _scheduler_with(
        run_once=_recording_run_once(polled), client=_Runtime(), config=config,
        provider=_Provider(), start=False,
    )
    await scheduler.get_job("poll_startup").func()

    assert polled == ["icehockey_nhl"]


async def test_a_worker_started_long_after_a_slot_buys_nothing():
    polled: list[str] = []
    due = datetime.now(timezone.utc).astimezone(ZoneInfo(PLAN_TIMEZONE)) - timedelta(hours=2)
    config = plan(([WEEKDAYS[due.weekday()]], due.strftime("%H:%M"), "icehockey_nhl"))

    scheduler = _scheduler_with(
        run_once=_recording_run_once(polled), client=_Runtime(), config=config,
        provider=_Provider(), start=False,
    )
    await scheduler.get_job("poll_startup").func()

    assert polled == []


async def test_grading_fetches_scores_only_for_sports_with_a_bet_to_settle():
    """Each scores fetch costs 2 credits whether or not anything settles. At four
    sports a day that is ~240 credits a month on a 500 budget, spent mostly on
    days with nothing to grade."""
    from edgeline.grading import GradingReport

    graded: list[str] = []

    async def _grade(*_args, **kwargs):
        graded.append(kwargs["sport_key"])
        return GradingReport()

    async def _awaiting(*_args, **_kwargs):
        return ["americanfootball_nfl"]

    scheduler = _scheduler_with(grade=_grade, awaiting=_awaiting, client=_Runtime(),
                                config=Settings())
    try:
        await scheduler.get_job("grade").func()
    finally:
        scheduler.shutdown(wait=False)
    assert graded == ["americanfootball_nfl"]


async def test_grading_with_nothing_to_settle_fetches_nothing():
    graded: list[str] = []

    async def _grade(*_args, **kwargs):
        graded.append(kwargs["sport_key"])

    async def _nothing(*_args, **_kwargs):
        return []

    scheduler = _scheduler_with(grade=_grade, awaiting=_nothing, client=_Runtime(),
                                config=Settings())
    try:
        await scheduler.get_job("grade").func()
    finally:
        scheduler.shutdown(wait=False)
    assert graded == []


async def test_grading_that_cannot_tell_grades_every_sport_a_poll_can_reach():
    """Not knowing is not a reason to leave a bet unsettled — and "every sport"
    has to include the plan's, not only `sports_enabled`, or an NFL bet would sit
    ungraded for as long as the datastore stayed unreadable."""
    from edgeline.grading import GradingReport

    graded: list[str] = []

    async def _grade(*_args, **kwargs):
        graded.append(kwargs["sport_key"])
        return GradingReport()

    async def _unreadable(*_args, **_kwargs):
        raise ConnectionError("cluster still waking")

    scheduler = _scheduler_with(grade=_grade, awaiting=_unreadable, client=_Runtime(),
                                config=Settings())
    try:
        await scheduler.get_job("grade").func()
    finally:
        scheduler.shutdown(wait=False)
    assert graded == active_sports(Settings())


async def test_the_closing_sweep_covers_the_plans_sports():
    """A closing line cannot be fetched after the game starts (§12), so a sport
    the plan polls must not lose it for being absent from `sports_enabled`."""
    swept: list[str] = []

    async def _capture(*_args, **kwargs):
        swept.append(kwargs["sport_key"])
        return []

    scheduler = _scheduler_with(capture=_capture, client=_Runtime(), config=Settings())
    try:
        await scheduler.get_job("closing_capture").func()
    finally:
        scheduler.shutdown(wait=False)
    assert swept == active_sports(Settings())


async def test_the_heartbeat_says_when_the_worker_polls_next():
    """What the running process registered, which a plan edited since it
    started would not tell you."""
    client = _Runtime()
    scheduler = _scheduler_with(client=client, config=Settings())
    try:
        await scheduler.get_job("heartbeat").func()
    finally:
        scheduler.shutdown(wait=False)

    doc = client.updates[-1]["doc"]
    assert doc["last_heartbeat_at"]
    assert doc["next_poll_at"] is not None
    assert doc["next_poll_sports"]


# ---- what grading has to settle --------------------------------------------


class _Store:
    """Just enough ES for `sports_awaiting_settlement`: one search, then mgets."""

    def __init__(self, docs: dict[str, dict[str, dict]]):
        self.docs = docs

    async def search(self, *, index, **_kwargs):
        rows = self.docs.get(index, {})
        return {"hits": {"hits": [{"_id": i, "_source": s} for i, s in rows.items()]}}

    async def mget(self, *, index, ids):
        rows = self.docs.get(index, {})
        return {
            "docs": [
                {"_id": i, "found": True, "_source": rows[i]} if i in rows
                else {"_id": i, "found": False}
                for i in ids
            ]
        }


async def test_only_a_started_game_with_an_unsettled_bet_needs_scores():
    from edgeline.grading import sports_awaiting_settlement
    from edgeline.indices import (
        EVENTS_INDEX,
        OPPORTUNITIES_INDEX,
        RECOMMENDATIONS_INDEX,
        RESULTS_INDEX,
    )

    now = _utc("2026-09-29T12:00:00")

    def event(sport, started):
        return {"sport_key": sport, "commence_time": _iso(started)}

    store = _Store({
        RECOMMENDATIONS_INDEX: {f"rec{n}": {"opportunity_id": f"opp{n}"} for n in range(1, 6)},
        # rec2 is settled already.
        RESULTS_INDEX: {"rec2": {"outcome": "win"}},
        OPPORTUNITIES_INDEX: {
            "opp1": {"event_id": "americanfootball_nfl:e1"},
            "opp2": {"event_id": "icehockey_nhl:e2"},
            "opp3": {"event_id": "basketball_nba:e3"},
            "opp4": {"event_id": "baseball_mlb:e4"},
            # opp5 is missing: an orphan cannot say what sport it is.
        },
        EVENTS_INDEX: {
            "americanfootball_nfl:e1": event("americanfootball_nfl", now - timedelta(hours=3)),
            "icehockey_nhl:e2": event("icehockey_nhl", now - timedelta(hours=3)),
            # Not started: nothing to settle yet, however ungraded.
            "basketball_nba:e3": event("basketball_nba", now + timedelta(hours=20)),
            # Older than the scores feed's `daysFrom` reaches: asking again buys nothing.
            "baseball_mlb:e4": event("baseball_mlb", now - timedelta(days=5)),
        },
    })

    assert await sports_awaiting_settlement(store, prefix="edgeline-", now=now) == [
        "americanfootball_nfl"
    ]
    assert await sports_awaiting_settlement(_Store({}), prefix="edgeline-", now=now) == []

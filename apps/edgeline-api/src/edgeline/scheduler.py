"""Worker process — spec §13. `nx run edgeline-api:worker`.

APScheduler on asyncio, running the jobs §13 lists. The startup sequence is the
part that matters: **compute the projected monthly credit cost (§8.4), refuse to
start if it exceeds `quota_monthly_budget`, and log the figure either way.**

That refusal is a real guardrail, not defensive coding. The free tier is 500
credits a month and the production cadence in §8.4 costs roughly 65,000 — a
worker started on the wrong interval would exhaust the month's quota in about
four hours and take the whole system dark, silently, at whatever hour it happened
to start. §13 makes the check a precondition, so the failure is a refusal to
start with the number printed rather than an outage discovered later.

§16 still holds throughout: this process polls, records and notifies. Nothing
here places a bet.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo

from .config import WEEKDAYS, PollSlot, Settings
from .indices import PROVIDERS_INDEX, SETTINGS_INDEX, with_prefix
from .schemas import utc_now_iso

log = logging.getLogger(__name__)

SECONDS_PER_DAY = 86_400
DAYS_PER_MONTH = 30
DAYS_PER_WEEK = 7
#: §13: the free tier's budget is what selects the dev cadence.
FREE_TIER_BUDGET = 500
HEARTBEAT_INTERVAL_S = 60
CLOSING_SWEEP_INTERVAL_S = 60
#: Long enough for the first poll to settle, short enough to matter in a brief run.
STARTUP_GRADE_DELAY_S = 15
#: Just past startup logging, so the catch-up poll's output is not interleaved with it.
STARTUP_POLL_DELAY_S = 3
#: When a cycle fails, how long to wait before trying again — and how many times.
#:
#: A job that fires the moment the machine wakes fires into a network that is not
#: ready yet. Measured 2026-09-17: the catch-up poll resolved
#: `api.the-odds-api.com` to `[Errno 11001] getaddrinfo failed` seconds after
#: resume, `_poll` logged it, and APScheduler's next attempt was **ten hours
#: away** — a whole cycle lost to a DNS lookup that would have worked a minute
#: later. The delays grow so the window covers a slow resume (a VPN, a captive
#: portal) rather than only a fast one, and they stop, because a provider that is
#: still unreachable twenty minutes later is not a transient.
RETRY_DELAYS_S = (60, 300, 900)
#: How often the cadence is checked against the last poll that actually landed.
REALIGN_INTERVAL_S = 60
#: How far the next fire may sit from the cadence before it is re-anchored. This
#: scheduler's own poll stamps `last_poll_at` a few seconds *after* it fires, so
#: without a tolerance every cycle would look like a poll from outside.
REALIGN_TOLERANCE_S = 120
#: `misfire_grace_time`: how late a run may be and still happen. APScheduler's
#: default is **one second** — anything later is discarded with a warning and
#: rescheduled a full interval away. On a laptop that sleeps, that is the normal
#: case rather than an edge case, so every job whose slot matters passes this.
#:
#: Measured 2026-09-15: this machine slept 03:36–19:35 UTC, the 14:01 poll slot
#: fell inside the sleep, and the worker then sat up for 21 hours on a 12-hour
#: cadence without polling once. Nothing looked wrong, because the heartbeat is a
#: separate 60-second job whose own missed run is replaced a minute later — so
#: `/health` stayed fresh while the job that spends the credits never ran.
#:
#: Paired with `coalesce=True`, which collapses every slot missed during one
#: sleep into a single run: a wake costs one cycle, not one per slot, so §8.4's
#: budget still buys the cadence rather than the uptime.
RUN_WHEN_LATE = None
#: The clock `poll_schedule` is written in (§3.2). The games are scheduled in
#: Eastern time and so is the plan; APScheduler's cron follows DST from here, so
#: a 17:30 slot is 21:30 UTC in October and 22:30 UTC in December.
PLAN_TIMEZONE = "America/New_York"
#: How late a slot of the weekly plan may still run — bounded, where the interval
#: uses `RUN_WHEN_LATE`. A fixed-time poll is placed for the games about to
#: start, so once they have started it buys nothing (§7.4 refuses a started
#: event): a 17:30 slot noticed at 23:00 is skipped, not bought.
#:
#: Ninety minutes is the lead the default plan's slots were placed with, and the
#: Monday/Thursday 18:45 NFL slot shows why it is the ceiling: its one game
#: kicks off at 20:15, so any later and the poll prices a game already under way.
SCHEDULED_POLL_GRACE_S = 90 * 60
#: A slot of the plan stands down when a poll from *outside* the plan — §10's
#: button, `engine --once`, a second process — bought the same sport this
#: recently. That poll already spent what the slot was budgeted for (§8.4).
#: Three hours is under the tightest gap between two same-sport slots in the
#: default plan (Sunday's NFL, three and a half), so one press can stand in for
#: one slot and never reach the next.
STAND_DOWN_S = 3 * 3600
#: The `last_poll_source_by_sport` value of a poll the plan made. Every other
#: source counts as outside the plan.
SOURCE_SCHEDULE = "schedule"
SOURCE_INTERVAL = "interval"
#: Version conflicts to retry on the `runtime` document. Two slots due in the
#: same minute (the default plan's 17:30 NHL and NBA) finish seconds apart and
#: both stamp it, and the heartbeat writes it every minute besides.
RUNTIME_WRITE_RETRIES = 3
#: The job ids that buy featured odds, for `next_poll`.
POLL_JOB_PREFIXES = ("poll_featured:", "poll_scheduled:")


class BudgetExceeded(RuntimeError):
    """The configured cadence would cost more credits than the month allows."""


@dataclass(frozen=True)
class BudgetPlan:
    """The §8.4 arithmetic, kept explicit so the number can be logged and tested."""

    featured_interval_s: int
    markets: int
    regions: int
    sports: int
    projected_monthly_credits: int
    budget: int
    #: How many polls a week `poll_schedule` makes when it sets the cadence;
    #: `None` when the interval does.
    scheduled_polls_per_week: int | None = None

    @property
    def affordable(self) -> bool:
        return self.projected_monthly_credits <= self.budget

    @property
    def scheduled(self) -> bool:
        return self.scheduled_polls_per_week is not None


class ScheduledPoll(NamedTuple):
    """One weekly fire of the plan: poll `sport` at `time` (ET) every `day`."""

    day: str
    time: str
    sport: str

    @property
    def job_id(self) -> str:
        return f"poll_scheduled:{self.day}:{self.time.replace(':', '')}:{self.sport}"

    @property
    def hour(self) -> int:
        return int(self.time[:2])

    @property
    def minute(self) -> int:
        return int(self.time[3:])


def schedule_in_effect(settings: Settings) -> bool:
    """§13: the weekly plan is the free tier's cadence.

    So it sets the pace only while the budget is still the free tier's — the rule
    that already chose `poll_interval_dev_s` over `poll_interval_s` — and only
    when it has a slot. An empty plan is how the interval comes back.
    """
    return bool(settings.poll_schedule) and settings.quota_monthly_budget <= FREE_TIER_BUDGET


def scheduled_polls(settings: Settings) -> list[ScheduledPoll]:
    """The plan expanded to one entry per weekly fire, each fire once.

    Empty whenever the plan is not what sets the cadence. Two rows naming the
    same day, time and sport are one poll rather than two — the scheduler
    registers them as one job, so the budget must count them as one.
    """
    if not schedule_in_effect(settings):
        return []
    polls: dict[str, ScheduledPoll] = {}
    for row in settings.poll_schedule:
        slot = row if isinstance(row, PollSlot) else PollSlot.model_validate(row)
        for day in slot.days:
            poll = ScheduledPoll(day, slot.time, slot.sport)
            polls.setdefault(poll.job_id, poll)
    return sorted(polls.values(), key=lambda p: (WEEKDAYS.index(p.day), p.time, p.sport))


def active_sports(settings: Settings) -> list[str]:
    """Every sport a poll can reach: `sports_enabled`, then the plan's own.

    What the closing sweep covers, and what grading falls back to when it cannot
    tell which sports have something to settle. A union, rather than a rule that
    the plan may only name enabled sports: `sports_enabled` is also what the
    interval polls when the plan is emptied, so requiring NFL there would double
    that fallback's bill (§8.4) for a sport it was never asked to poll.
    """
    sports = list(settings.sports_enabled)
    for poll in scheduled_polls(settings):
        if poll.sport not in sports:
            sports.append(poll.sport)
    return sports


def plan_clock(now: datetime | None = None) -> datetime:
    """`now` on the plan's own (Eastern) clock."""
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(PLAN_TIMEZONE))


def sports_for_poll_now(settings: Settings, now: datetime | None = None) -> list[str]:
    """What a cycle run *now* covers — §10's button and `engine --once`.

    Today's sports in the plan, by the plan's Eastern calendar, so a press on a
    Tuesday buys Tuesday's slate and not Sunday's. `sports_enabled` when the plan
    is empty, not in effect, or has nothing today.
    """
    polls = scheduled_polls(settings)
    if polls:
        today = WEEKDAYS[plan_clock(now).weekday()]
        todays = list(dict.fromkeys(poll.sport for poll in polls if poll.day == today))
        if todays:
            return todays
    return list(settings.sports_enabled)


def slot_due_at(poll: ScheduledPoll, now: datetime) -> datetime:
    """The latest time this slot came due, at or before `now` (returned in UTC)."""
    zone = ZoneInfo(PLAN_TIMEZONE)
    local = now.astimezone(zone)
    for back in range(DAYS_PER_WEEK + 1):
        day = (local - timedelta(days=back)).date()
        if WEEKDAYS[day.weekday()] != poll.day:
            continue
        due = datetime(day.year, day.month, day.day, poll.hour, poll.minute, tzinfo=zone)
        if due <= local:
            return due.astimezone(timezone.utc)
    raise AssertionError(f"{poll.job_id} did not recur within a week")  # unreachable


def missed_slots(
    polls: list[ScheduledPoll], now: datetime, *, grace_s: int = SCHEDULED_POLL_GRACE_S
) -> list[ScheduledPoll]:
    """Slots that came due inside the grace window — what a worker that was down
    for them still owes when it starts, on the same terms a sleep would get."""
    grace = timedelta(seconds=grace_s)
    return [poll for poll in polls if now - slot_due_at(poll, now) <= grace]


def _parse_stamp(stamp: Any) -> datetime | None:
    """A `utc_now_iso` stamp as an aware datetime; `None` for anything else."""
    if not stamp or not isinstance(stamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def stand_down_reason(
    runtime: dict[str, Any], sport_key: str, *, due: datetime, now: datetime
) -> str | None:
    """Why a slot of the plan should not buy its poll, or `None` when it should.

    Read off the per-sport stamps every poll writes (`record_poll`):

    * **The slot is already served** — this sport was polled at or after the
      time the slot came due. A worker restarted inside the grace window, or a
      second worker, would otherwise buy the same slot twice.
    * **A poll from outside the plan landed within `STAND_DOWN_S`** — that poll
      already spent what the slot was budgeted for, which is the button's whole
      bargain with §8.4.

    The plan's own earlier polls never stand a slot down. If they did, a plan
    with two slots close together, or a slot that fired late inside its grace,
    would quietly lose the next slot while `--check-budget` went on counting it.

    Anything unreadable answers "poll", for `poll_is_due`'s reason: one wasted
    cycle is cheaper than a plan that silently stops.
    """
    stamps = runtime.get("last_poll_at_by_sport")
    last = _parse_stamp(stamps.get(sport_key)) if isinstance(stamps, dict) else None
    if last is None:
        return None
    if last >= due - timedelta(seconds=REALIGN_TOLERANCE_S):
        return f"already polled at {last:%H:%M} UTC, as this slot came due or since"
    sources = runtime.get("last_poll_source_by_sport")
    source = sources.get(sport_key) if isinstance(sources, dict) else None
    age = now - last
    if source != SOURCE_SCHEDULE and age < timedelta(seconds=STAND_DOWN_S):
        return f"a {source or 'recorded'} poll landed {int(age.total_seconds() // 60)} min ago"
    return None


def next_poll(jobs) -> dict[str, Any]:
    """When the running worker next buys featured odds, and for which sports.

    Written onto the `runtime` document by the heartbeat, so `/health` reports
    what *this process* has registered — which a plan edited since it started
    would not tell you.
    """
    upcoming = [
        (job.next_run_time, job.args[-1])
        for job in jobs
        if job.id.startswith(POLL_JOB_PREFIXES) and getattr(job, "next_run_time", None)
    ]
    if not upcoming:
        return {"next_poll_at": None, "next_poll_sports": []}
    first = min(when for when, _ in upcoming)
    sports = list(dict.fromkeys(sport for when, sport in upcoming if when == first))
    return {
        "next_poll_at": first.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "next_poll_sports": sports,
    }


def featured_interval_s(settings: Settings) -> int:
    """§13: the dev cadence applies while the budget is still the free tier's."""
    if settings.quota_monthly_budget <= FREE_TIER_BUDGET:
        return settings.poll_interval_dev_s
    return settings.poll_interval_s


def plan_budget(settings: Settings) -> BudgetPlan:
    """§8.4: what the featured cadence costs a month.

    On the interval, `(86400/interval) x markets x regions x 30` per enabled
    sport. On the weekly plan, `polls a week x markets x regions x 30/7` — each
    slot buys one sport, so the plan's sports are already in the count.

    Every slot is counted at full price, including a slot for a sport that is
    out of season. An empty response costs nothing (measured 2026-09-23,
    `x-requests-last: 0`), so such a slot really is free until its season
    starts — but the projection cannot know when that is, and under-reporting is
    the one direction this calculation must never fail in, since its whole job
    is refusing to start. For the same reason the weekly figure rounds up.

    `regions` is counted from the setting rather than assumed. It used to be a
    hardcoded 1, which would have under-reported the cost by half the moment a
    second region was added.
    """
    interval = featured_interval_s(settings)
    markets = len(settings.markets_featured)
    regions = max(len(settings.regions), 1)
    polls = scheduled_polls(settings)
    if polls:
        sports = len({poll.sport for poll in polls})
        weekly = len(polls) * markets * regions
        # Integer ceiling of weekly x 30/7.
        projected = -(-weekly * DAYS_PER_MONTH // DAYS_PER_WEEK)
    else:
        sports = max(len(settings.sports_enabled), 1)
        per_sport = (SECONDS_PER_DAY / interval) * markets * regions * DAYS_PER_MONTH
        projected = int(per_sport * sports)
    return BudgetPlan(
        featured_interval_s=interval,
        markets=markets,
        regions=regions,
        sports=sports,
        # `offline_mode` makes every provider request a no-op (§3.2), so the
        # cadence costs nothing and no cadence can be unaffordable. Without this
        # the guard would refuse to start an offline worker over a bill it will
        # never incur.
        projected_monthly_credits=0 if settings.offline_mode else projected,
        budget=settings.quota_monthly_budget,
        scheduled_polls_per_week=len(polls) if polls else None,
    )


def check_budget(settings: Settings) -> BudgetPlan:
    """Log the projected cost and refuse an unaffordable cadence (§13, §8.4)."""
    plan = plan_budget(settings)
    if plan.scheduled:
        log.info(
            "projected monthly credits: %d (%d scheduled polls a week x %d markets "
            "x %d region(s) x 30/7, across %d sport(s)); budget %d",
            plan.projected_monthly_credits,
            plan.scheduled_polls_per_week,
            plan.markets,
            plan.regions,
            plan.sports,
            plan.budget,
        )
    else:
        log.info(
            "projected monthly credits: %d (interval %ds x %d markets x %d region(s) "
            "x %d sport(s)); budget %d",
            plan.projected_monthly_credits,
            plan.featured_interval_s,
            plan.markets,
            plan.regions,
            plan.sports,
            plan.budget,
        )
    if not plan.affordable:
        remedy = (
            "Remove slots from poll_schedule (§3.2)"
            if plan.scheduled
            else "Raise the budget (T4.1, needs the paid tier) or lengthen poll_interval_s"
        )
        raise BudgetExceeded(
            f"cadence would cost ~{plan.projected_monthly_credits} credits/month, "
            f"over the quota_monthly_budget of {plan.budget}. {remedy}."
        )
    return plan


async def heartbeat(
    client, *, prefix: str, upcoming: dict[str, Any] | None = None
) -> None:
    """§13: keep the `runtime` settings document current for `/api/system/health`.

    `upcoming` is `next_poll`'s answer, when the caller has a scheduler to ask.
    """
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={"last_heartbeat_at": utc_now_iso(), **(upcoming or {})},
        refresh=False,
        retry_on_conflict=RUNTIME_WRITE_RETRIES,
    )


async def record_run(client, *, prefix: str, job: str) -> None:
    """Stamp a job's last successful run onto the `runtime` document."""
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={f"last_{job}_at": utc_now_iso()},
        refresh=False,
        retry_on_conflict=RUNTIME_WRITE_RETRIES,
    )


async def record_poll(client, *, prefix: str, sport_key: str, source: str) -> None:
    """Stamp a poll that fetched odds: globally, and for its sport and source.

    `last_poll_at` is still what `/health`, `poll_is_due` and `poll_realign`
    read. The per-sport pair is what a slot of the plan stands down on: once
    several sports are polled, "something was polled an hour ago" no longer says
    whether *this* sport was, and the source says whether the plan made it.
    A partial update merges objects, so stamping one sport leaves the others.
    """
    now = utc_now_iso()
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={
            "last_poll_at": now,
            "last_poll_at_by_sport": {sport_key: now},
            "last_poll_source_by_sport": {sport_key: source},
        },
        refresh=False,
        retry_on_conflict=RUNTIME_WRITE_RETRIES,
    )


async def record_quota(client, provider_key: str, quota, *, prefix: str) -> None:
    """Persist what the provider's headers last reported (§8, §10).

    **Nothing wrote this until 2026-09-13**, so `edgeline-providers` kept a null
    `quota_used` forever and the dashboard rendered it as `0 / 500` — on a budget
    where the whole allowance is 500 and a guard refuses requests near it. A
    credit meter stuck at zero is worse than no meter: it reads as headroom.

    The pace guard was never affected; it compares `x-requests-used` in memory on
    the adapter and models nothing. This is the display catching up with what the
    adapter already knew.

    Failures are swallowed. This is a readout, and losing a cycle's worth of
    detection because a cosmetic write failed would be the wrong trade.
    """
    if quota is None or quota.used is None:
        return
    doc: dict[str, Any] = {"quota_used": quota.used}
    try:
        await client.update(
            index=with_prefix(PROVIDERS_INDEX, prefix),
            id=provider_key,
            doc=doc,
            refresh=False,
        )
    except Exception:
        log.debug("could not record quota for %s", provider_key, exc_info=True)


async def poll_is_due(client, *, prefix: str, interval_s: int) -> bool:
    """True when no poll has landed inside the last ``interval_s`` seconds.

    Reads the same ``last_poll_at`` stamp :func:`record_run` writes. Anything
    unreadable — no runtime document, no stamp, an unparseable one — answers
    *due*: the cost of one extra cycle is a handful of credits, and the cost of
    wrongly skipping is a worker that polls on the way to never.
    """
    try:
        doc = await client.get(index=with_prefix(SETTINGS_INDEX, prefix), id="runtime")
        stamp = doc["_source"].get("last_poll_at")
    except Exception:
        return True
    if not stamp:
        return True
    try:
        last = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return True
    return datetime.now(timezone.utc) - last >= timedelta(seconds=interval_s)


def realign_target(
    stamp: str | None, *, interval_s: int, now: datetime
) -> datetime | None:
    """When the next featured poll should fire, given the last one that landed.

    One interval after that poll — the whole rule. `None` means "leave the job
    alone": there is no readable stamp, or the target has already passed, which
    makes the poll overdue rather than early and is the misfire path's business
    (`RUN_WHEN_LATE`) rather than this one's.
    """
    if not stamp:
        return None
    try:
        last = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    target = last + timedelta(seconds=interval_s)
    return target if target > now else None


async def reset_quota(client, *, prefix: str) -> None:
    """§13's monthly job: zero `quota_used` on every provider."""
    try:
        await client.update_by_query(
            index=with_prefix(PROVIDERS_INDEX, prefix),
            script={"source": "ctx._source.quota_used = 0", "lang": "painless"},
            query={"match_all": {}},
            refresh=True,
        )
    except Exception:
        log.warning("quota reset found no provider documents to update")


def build_scheduler(provider, client, settings: Settings, *, prefix: str = "edgeline-", sink=None):
    """Register §13's jobs. Returns the scheduler, not started.

    The featured cadence is one of two shapes, chosen once here: the weekly plan
    (`poll_schedule`) while it is in effect, one cron job per slot; otherwise the
    interval, one job per enabled sport. A plan edited in the UI therefore takes
    effect at the next worker start, like every other cadence setting.
    """
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger

    from .engine import capture_closing_lines, load_settings, run_once
    from .grading import grade, sports_awaiting_settlement
    from .providers.base import ProviderBudgetExceeded

    plan = check_budget(settings)
    polls = scheduled_polls(settings)
    scheduler = AsyncIOScheduler(timezone="UTC")

    def _refresh_budget(current: Settings) -> None:
        """Keep the provider's pace guard on the current §3.2 budget.

        Set on the provider rather than passed per call, so it covers every
        caller including ones added later — the same reasoning that made
        `offline_mode`'s per-caller guarding fail on `grading.grade`.
        """
        if hasattr(provider, "monthly_budget"):
            provider.monthly_budget = current.quota_monthly_budget

    _refresh_budget(settings)

    def _retry_soon(func, args: list, *, kind: str, attempt: int) -> None:
        """Book one more attempt at `func`, or stop and say why.

        `attempt` is 1-based and counts the run that just failed, so the first
        retry is attempt 2 and reads `RETRY_DELAYS_S[0]`.

        The retry is a one-shot `date` job rather than a loop inside the failing
        job: the job hands control back, the scheduler keeps running everything
        else, and a retry whose own slot lands inside a sleep still runs on wake
        (`RUN_WHEN_LATE`) instead of being dropped, which is the failure this
        whole mechanism exists to answer.
        """
        index = attempt - 2
        if index >= len(RETRY_DELAYS_S):
            log.error(
                "%s failed %d times over %d minutes; leaving it to the next "
                "scheduled run",
                kind,
                attempt - 1,
                sum(RETRY_DELAYS_S) // 60,
            )
            return
        delay = RETRY_DELAYS_S[index]
        scheduler.add_job(
            func,
            "date",
            args=args,
            run_date=datetime.now(timezone.utc) + timedelta(seconds=delay),
            id=f"retry:{kind}:{attempt}",
            replace_existing=True,
            misfire_grace_time=RUN_WHEN_LATE,
        )
        log.info(
            "%s failed; retrying in %ds (attempt %d of %d)",
            kind,
            delay,
            attempt,
            len(RETRY_DELAYS_S) + 1,
        )

    async def _poll(sport_key: str, attempt: int = 1, source: str = SOURCE_INTERVAL) -> None:
        try:
            report = await run_once(
                provider, client, sport_key=sport_key, prefix=prefix, sink=sink
            )
        except ProviderBudgetExceeded as refused:
            # A deliberate local refusal, not a failure: nothing was sent, and
            # nothing about it will be different in a minute. One line, no
            # traceback, no retry.
            log.warning("poll %s refused: %s", sport_key, refused)
            return
        except Exception:
            # A failed cycle must not take the scheduler down, and it must not
            # wait a full interval either — see RETRY_DELAYS_S. The datastore
            # keeps whatever the cycle managed to write.
            log.exception("poll cycle failed for %s", sport_key)
            _retry_soon(
                _poll,
                [sport_key, attempt + 1, source],
                kind=f"poll {sport_key}",
                attempt=attempt + 1,
            )
            return

        if report.offline:
            # Deliberately *not* stamped. `last_poll_at` means "odds were
            # fetched at", and two things read it that way: `/health`, where a
            # fresh stamp over stale data reads as working, and `poll_is_due`,
            # which would then skip the startup catch-up poll on the first run
            # after coming back online — leaving a real poll up to a full
            # interval away, which is the exact failure `poll_startup` exists
            # to prevent.
            log.info("poll %s: skipped, offline_mode is on", sport_key)
            return
        try:
            await record_poll(client, prefix=prefix, sport_key=sport_key, source=source)
        except Exception:
            # Outside the retry on purpose: the odds are bought and stored, and
            # only the readout failed. Retrying would buy the same market again
            # to repair a timestamp.
            log.warning("poll %s landed but could not be stamped", sport_key, exc_info=True)
        # Right after the stamp, from the same cycle's headers — so the
        # dashboard's credit figure moves whenever a poll actually spent
        # something, and only then.
        await record_quota(client, provider.key, provider.quota, prefix=prefix)
        log.info(
            "poll %s: %d snapshots, %d detections, %d alerted (quota %s/%s)",
            sport_key,
            report.snapshots,
            len(report.detections),
            len(report.alerted),
            report.quota_used,
            settings.quota_monthly_budget,
        )

    async def _poll_slot(day: str, time: str, sport_key: str) -> None:
        """One slot of the weekly plan (§3.2 `poll_schedule`, §13).

        Asks `stand_down_reason` first, so a poll from outside the plan — the
        dashboard's button above all — substitutes for the slot instead of
        doubling it, and a slot already served is not bought twice.
        """
        poll = ScheduledPoll(day, time, sport_key)
        now = datetime.now(timezone.utc)
        runtime: dict[str, Any] = {}
        try:
            found = await client.get(index=with_prefix(SETTINGS_INDEX, prefix), id="runtime")
            runtime = found["_source"]
        except Exception:
            log.debug("could not read the per-sport poll stamps; polling anyway", exc_info=True)
        reason = stand_down_reason(runtime, sport_key, due=slot_due_at(poll, now), now=now)
        if reason:
            log.info("scheduled poll %s (%s %s ET) stands down: %s", sport_key, day, time, reason)
            return
        await _poll(sport_key, source=SOURCE_SCHEDULE)

    async def _closing_sweep() -> None:
        # Re-read §3.2 each tick, the way `run_once` already does for `_poll`,
        # so flipping `offline_mode` (or any other setting) in the UI takes
        # effect on the next sweep instead of on the next restart.
        try:
            current = await load_settings(client, prefix=prefix)
        except Exception as unreadable:
            # Since 2026-09-15 an unreadable settings document raises rather than
            # becoming §3.2 defaults, and every sleep/resume makes one tick
            # unreadable. This sweep runs every 60 s, so the next one has it —
            # one line, not a traceback that would arrive twice a day forever.
            log.warning("closing sweep: settings unreadable (%s); skipping a tick", unreadable)
            return
        _refresh_budget(current)
        # Every sport a poll can reach, plan included: a closing line is the one
        # price that cannot be fetched afterwards (§12), so a sport the plan
        # polls but `sports_enabled` omits must not lose it.
        for sport_key in active_sports(current):
            try:
                await capture_closing_lines(
                    provider, client, sport_key=sport_key, settings=current, prefix=prefix
                )
            except Exception:
                log.exception("closing capture failed for %s", sport_key)

    async def _grade(attempt: int = 1) -> None:
        # Grading runs once a day, so "failed, try again tomorrow" leaves the
        # ledger a day behind over a blip — and it fires at 06:00 UTC or on wake,
        # which is exactly when a resume breaks the first request. Same retry as
        # the poll, including for the settings read: a raise there would
        # otherwise end the run before the loop can book one.
        try:
            current = await load_settings(client, prefix=prefix)
        except Exception:
            log.exception("grading: settings unreadable")
            _retry_soon(_grade, [attempt + 1], kind="grade", attempt=attempt + 1)
            return

        # Only the sports with a recommendation whose game has started and has
        # no result yet (added 2026-09-23). A scores fetch costs 2 credits per
        # sport whether or not anything settles, and once the plan polls four
        # sports that is ~240 credits a month on a 500 budget — nearly as much
        # as the polls themselves, spent mostly on days with nothing to grade.
        try:
            sports = await sports_awaiting_settlement(client, prefix=prefix)
        except Exception as unreadable:
            # Not knowing is not a reason to leave a bet unsettled: grade every
            # sport a poll can reach, which is what this job did before.
            log.warning(
                "grading: could not tell which sports have bets to settle (%s); "
                "grading every active sport",
                unreadable,
            )
            sports = active_sports(current)
        if not sports:
            log.info("grading: no recommendation is waiting on a started game; no scores fetched")
            return

        failed = False
        for sport_key in sports:
            try:
                report = await grade(
                    provider, client, sport_key=sport_key, settings=current,
                    prefix=prefix, sink=sink,
                )
                if report.offline:
                    # Same reasoning as `_poll`: `last_grade_at` means scores
                    # were fetched and settlement was attempted against them.
                    continue
                await record_run(client, prefix=prefix, job="grade")
            except ProviderBudgetExceeded as refused:
                log.warning("grading %s refused: %s", sport_key, refused)
            except Exception:
                failed = True
                log.exception("grading failed for %s", sport_key)

        if failed:
            # The whole job, not the one sport that failed: settlement re-reads
            # what is still ungraded, so a sport that succeeded costs its 2
            # credits again and nothing else. Per-sport retry state would be the
            # more expensive mistake to get wrong.
            _retry_soon(_grade, [attempt + 1], kind="grade", attempt=attempt + 1)

    async def _poll_startup() -> None:
        """A catch-up poll at startup, when one is actually due.

        An APScheduler interval job first fires one *full* interval after start,
        which at the dev cadence is 12 hours. This process is expected to run in
        short bursts on a laptop that sleeps, so without this the common case is
        a worker that is started, does nothing, and is stopped — polling on the
        way to never. Same reasoning as `grade_startup` below, for the job that
        feeds it.

        Conditional, because it spends real credits: §8.4's budget covers the
        *cadence*, not the number of times the process is restarted, and each
        cycle costs markets × regions credits. If a poll already landed inside
        the current interval the cadence is being met, so this stands down.

        On the weekly plan there is no interval to be due against, and a cron
        slot fires at its own time whenever the worker started. What a start can
        still miss is a slot that came due while the process was down, so this
        runs exactly those — the ones inside `SCHEDULED_POLL_GRACE_S`, which is
        the lateness a sleep is allowed too — and each still asks the stand-down
        rule, so a restart just after a slot that ran buys nothing.
        """
        if polls:
            missed = missed_slots(polls, datetime.now(timezone.utc))
            if not missed:
                log.info(
                    "startup poll skipped: no slot of the weekly plan came due in the "
                    "last %d minutes",
                    SCHEDULED_POLL_GRACE_S // 60,
                )
                return
            for poll in missed:
                await _poll_slot(poll.day, poll.time, poll.sport)
            return
        if not await poll_is_due(client, prefix=prefix, interval_s=plan.featured_interval_s):
            log.info("startup poll skipped: a cycle already landed inside the interval")
            return
        for sport_key in settings.sports_enabled:
            await _poll(sport_key)

    async def _realign_polls() -> None:
        """Re-anchor the cadence on the last poll that actually landed.

        A poll can land from outside this scheduler: the dashboard's button
        (§10's `POST /api/system/poll`), `engine --once`, a second process. The
        interval job knows nothing about any of them, so a press two hours before
        a scheduled slot would buy the same market twice — and §8.4's budget pays
        for the cadence, not for how often a person presses a button.

        So the cadence is measured from the stamp rather than from process start,
        which is also the honest reading of "every twelve hours". Inside
        `REALIGN_TOLERANCE_S` the stamp is this scheduler's own poll and nothing
        moves.
        """
        if not scheduler.running:
            # Called against an unstarted scheduler (the §16 offline sweep does
            # exactly that). There is nothing to re-anchor and `modify_job` would
            # be reaching into a pending job.
            return
        try:
            doc = await client.get(
                index=with_prefix(SETTINGS_INDEX, prefix), id="runtime"
            )
            stamp = doc["_source"].get("last_poll_at")
        except Exception:
            # A readout, not a guardrail: the next tick is sixty seconds away.
            log.debug("could not read last_poll_at to re-anchor", exc_info=True)
            return

        target = realign_target(
            stamp, interval_s=plan.featured_interval_s, now=datetime.now(timezone.utc)
        )
        if target is None:
            return

        for job in scheduler.get_jobs():
            if not job.id.startswith("poll_featured:"):
                continue
            current = getattr(job, "next_run_time", None)
            if (
                current is not None
                and abs((target - current).total_seconds()) <= REALIGN_TOLERANCE_S
            ):
                continue
            scheduler.modify_job(job.id, next_run_time=target)
            log.info(
                "cadence re-anchored on the last poll: %s fires %s (was %s)",
                job.id,
                target.isoformat(timespec="seconds"),
                current.isoformat(timespec="seconds") if current else "unscheduled",
            )

    if polls:
        # The weekly plan: one cron job per slot, on the plan's Eastern clock so
        # DST moves the UTC fire time rather than the slot. Bounded lateness
        # (`SCHEDULED_POLL_GRACE_S`) instead of `RUN_WHEN_LATE`, since a slot's
        # games do not wait for it; `coalesce` so a sleep across a slot still
        # costs one poll.
        for poll in polls:
            scheduler.add_job(
                _poll_slot,
                CronTrigger(
                    day_of_week=poll.day,
                    hour=poll.hour,
                    minute=poll.minute,
                    timezone=PLAN_TIMEZONE,
                ),
                args=[poll.day, poll.time, poll.sport],
                id=poll.job_id,
                max_instances=1,
                coalesce=True,
                misfire_grace_time=SCHEDULED_POLL_GRACE_S,
            )
    else:
        for sport_key in settings.sports_enabled:
            scheduler.add_job(
                _poll,
                "interval",
                seconds=plan.featured_interval_s,
                args=[sport_key],
                id=f"poll_featured:{sport_key}",
                max_instances=1,
                coalesce=True,
                misfire_grace_time=RUN_WHEN_LATE,
            )

    async def _heartbeat() -> None:
        await heartbeat(client, prefix=prefix, upcoming=next_poll(scheduler.get_jobs()))

    scheduler.add_job(
        _poll_startup,
        "date",
        run_date=datetime.now(timezone.utc) + timedelta(seconds=STARTUP_POLL_DELAY_S),
        id="poll_startup",
    )

    scheduler.add_job(
        _closing_sweep,
        "interval",
        seconds=CLOSING_SWEEP_INTERVAL_S,
        id="closing_capture",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=RUN_WHEN_LATE,
    )
    scheduler.add_job(
        _grade, "cron", hour=6, minute=0, id="grade",
        coalesce=True, misfire_grace_time=RUN_WHEN_LATE,
    )
    # A catch-up grade shortly after startup. §13's cron alone assumes a worker
    # that is up at 06:00 UTC; this one is expected to run in short bursts, so
    # without this a run that never spans 06:00 would never settle anything and
    # the ledger would sit empty however long the system had been used.
    scheduler.add_job(
        _grade,
        "date",
        run_date=datetime.now(timezone.utc) + timedelta(seconds=STARTUP_GRADE_DELAY_S),
        id="grade_startup",
    )
    # A reset that is skipped for being late is skipped for a month, and the pace
    # guard then refuses every paid request against last month's spend.
    scheduler.add_job(
        reset_quota, "cron", day=1, hour=0, minute=5, id="quota_reset",
        kwargs={"client": client, "prefix": prefix},
        coalesce=True, misfire_grace_time=RUN_WHEN_LATE,
    )
    # The two jobs that keep APScheduler's default grace, both because they
    # replace themselves a minute later: the heartbeat stamps `utc_now_iso()`
    # rather than its slot, and a re-anchoring that is skipped is simply redone
    # on the next tick against the same stamp.
    scheduler.add_job(
        _heartbeat, "interval", seconds=HEARTBEAT_INTERVAL_S, id="heartbeat",
    )
    if not polls:
        # The interval's alone: a slot of the plan is a clock time, and there is
        # nothing to re-anchor on a poll that landed elsewhere — the plan's
        # stand-down rule answers that question instead.
        scheduler.add_job(
            _realign_polls, "interval", seconds=REALIGN_INTERVAL_S, id="poll_realign",
            max_instances=1, coalesce=True,
        )
    return scheduler


async def _run() -> int:
    from .es import close_client, ensure_indices, get_client
    from .engine import load_settings
    from .providers.the_odds_api import TheOddsApiProvider

    client = get_client()
    provider = TheOddsApiProvider()
    try:
        await ensure_indices(client)
        settings = await load_settings(client, prefix="edgeline-")

        if not settings.offline_mode and hasattr(provider, "arm_budget_guard"):
            # Free `/sports` call: teaches the pace guard what has already been
            # spent, so the first *paid* request of this process is guarded
            # rather than the second.
            quota = await provider.arm_budget_guard()
            # The same free call that arms the guard also carries `x-requests-used`
            # (measured 2026-09-13: `/sports` costs nothing and still reports
            # `20 of 500`). So the dashboard's meter is correct from the moment
            # the worker starts, rather than staying stale until the first paid
            # poll — which at the dev cadence can be twelve hours away.
            await record_quota(client, provider.key, quota, prefix="edgeline-")
            log.info(
                "budget guard armed: %s of %s credits used this month",
                quota.used,
                settings.quota_monthly_budget,
            )

        scheduler = build_scheduler(provider, client, settings)
        scheduler.start()
        polls = scheduled_polls(settings)
        upcoming = next_poll(scheduler.get_jobs())
        if polls:
            log.info(
                "poll plan: %d polls a week at fixed %s times (%s); next %s %s",
                len(polls),
                PLAN_TIMEZONE,
                ", ".join(dict.fromkeys(poll.sport for poll in polls)),
                upcoming["next_poll_at"],
                ", ".join(upcoming["next_poll_sports"]),
            )
        else:
            log.info(
                "poll cadence: every %ds (poll_schedule %s); next %s",
                featured_interval_s(settings),
                "empty" if not settings.poll_schedule else "not in effect above the free tier",
                upcoming["next_poll_at"],
            )
        log.info(
            "worker started: %d job(s). PAPER MODE=%s. This process recommends "
            "bets and never places them.",
            len(scheduler.get_jobs()),
            settings.paper_mode,
        )

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                # Windows' proactor loop has no signal handlers; Ctrl-C still
                # raises KeyboardInterrupt out of the wait below.
                pass
        try:
            await stop.wait()
        except KeyboardInterrupt:
            pass
        scheduler.shutdown(wait=False)
    finally:
        await provider.aclose()
        await close_client()
    return 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m edgeline.scheduler",
        description="Edgeline worker: polling, closing capture, grading. Never places bets.",
    )
    parser.add_argument(
        "--check-budget",
        action="store_true",
        help="print the projected monthly credit cost and exit",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.check_budget:
        return asyncio.run(_check_budget_only())
    return asyncio.run(_run())


async def _check_budget_only() -> int:
    from .es import close_client, get_client
    from .engine import load_settings

    client = get_client()
    try:
        settings = await load_settings(client, prefix="edgeline-")
        plan = plan_budget(settings)
        if plan.scheduled:
            sports = ", ".join(dict.fromkeys(poll.sport for poll in scheduled_polls(settings)))
            cadence = (
                f"poll plan          {plan.scheduled_polls_per_week} polls/week at fixed "
                f"{PLAN_TIMEZONE} times\n"
                f"sports             {plan.sports} ({sports})\n"
            )
        else:
            cadence = (
                f"featured interval  {plan.featured_interval_s}s\n"
                f"sports             {plan.sports}\n"
            )
        print(
            f"{cadence}"
            f"markets x regions  {plan.markets} x {plan.regions}\n"
            f"projected credits  {plan.projected_monthly_credits}/month\n"
            f"budget             {plan.budget}\n"
            f"verdict            {'OK' if plan.affordable else 'OVER BUDGET'}"
        )
        return 0 if plan.affordable else 1
    finally:
        await close_client()


if __name__ == "__main__":
    raise SystemExit(main())

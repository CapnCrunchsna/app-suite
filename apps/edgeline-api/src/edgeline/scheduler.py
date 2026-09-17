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
from typing import Any

from .config import Settings
from .indices import PROVIDERS_INDEX, SETTINGS_INDEX, with_prefix
from .schemas import utc_now_iso

log = logging.getLogger(__name__)

SECONDS_PER_DAY = 86_400
DAYS_PER_MONTH = 30
#: §13: the free tier's budget is what selects the dev cadence.
FREE_TIER_BUDGET = 500
HEARTBEAT_INTERVAL_S = 60
CLOSING_SWEEP_INTERVAL_S = 60
#: Long enough for the first poll to settle, short enough to matter in a brief run.
STARTUP_GRADE_DELAY_S = 15
#: Just past startup logging, so the catch-up poll's output is not interleaved with it.
STARTUP_POLL_DELAY_S = 3
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

    @property
    def affordable(self) -> bool:
        return self.projected_monthly_credits <= self.budget


def featured_interval_s(settings: Settings) -> int:
    """§13: the dev cadence applies while the budget is still the free tier's."""
    if settings.quota_monthly_budget <= FREE_TIER_BUDGET:
        return settings.poll_interval_dev_s
    return settings.poll_interval_s


def plan_budget(settings: Settings) -> BudgetPlan:
    """§8.4: `(86400/interval) x markets x regions x 30`, per enabled sport.

    `regions` is counted from the setting rather than assumed. It used to be a
    hardcoded 1, which would have under-reported the cost by half the moment a
    second region was added — and under-reporting is the one direction this
    calculation must never fail in, since its whole job is refusing to start.
    """
    interval = featured_interval_s(settings)
    markets = len(settings.markets_featured)
    regions = max(len(settings.regions), 1)
    sports = max(len(settings.sports_enabled), 1)
    per_sport = (SECONDS_PER_DAY / interval) * markets * regions * DAYS_PER_MONTH
    # `offline_mode` makes every provider request a no-op (§3.2), so the cadence
    # costs nothing and no cadence can be unaffordable. Without this the guard
    # would refuse to start an offline worker over a bill it will never incur.
    projected = 0 if settings.offline_mode else int(per_sport * sports)
    return BudgetPlan(
        featured_interval_s=interval,
        markets=markets,
        regions=regions,
        sports=sports,
        projected_monthly_credits=projected,
        budget=settings.quota_monthly_budget,
    )


def check_budget(settings: Settings) -> BudgetPlan:
    """Log the projected cost and refuse an unaffordable cadence (§13, §8.4)."""
    plan = plan_budget(settings)
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
        raise BudgetExceeded(
            f"cadence would cost ~{plan.projected_monthly_credits} credits/month, "
            f"over the quota_monthly_budget of {plan.budget}. Raise the budget "
            f"(T4.1, needs the paid tier) or lengthen poll_interval_s."
        )
    return plan


async def heartbeat(client, *, prefix: str) -> None:
    """§13: keep the `runtime` settings document current for `/api/system/health`."""
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={"last_heartbeat_at": utc_now_iso()},
        refresh=False,
    )


async def record_run(client, *, prefix: str, job: str) -> None:
    """Stamp a job's last successful run onto the `runtime` document."""
    await client.update(
        index=with_prefix(SETTINGS_INDEX, prefix),
        id="runtime",
        doc={f"last_{job}_at": utc_now_iso()},
        refresh=False,
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
    """Register §13's jobs. Returns the scheduler, not started."""
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    from .engine import capture_closing_lines, load_settings, run_once
    from .grading import grade

    plan = check_budget(settings)
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

    async def _poll(sport_key: str) -> None:
        try:
            report = await run_once(
                provider, client, sport_key=sport_key, prefix=prefix, sink=sink
            )
            if report.offline:
                # Deliberately *not* stamped. `last_poll_at` means "odds were
                # fetched at", and two things read it that way: `/health`, where
                # a fresh stamp over stale data reads as working, and
                # `poll_is_due`, which would then skip the startup catch-up poll
                # on the first run after coming back online — leaving a real
                # poll up to a full interval away, which is the exact failure
                # `poll_startup` exists to prevent.
                log.info("poll %s: skipped, offline_mode is on", sport_key)
                return
            await record_run(client, prefix=prefix, job="poll")
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
        except Exception:
            # A failed cycle must not take the scheduler down; the next tick
            # retries and the datastore keeps whatever the last one wrote.
            log.exception("poll cycle failed for %s", sport_key)

    async def _closing_sweep() -> None:
        # Re-read §3.2 each tick, the way `run_once` already does for `_poll`,
        # so flipping `offline_mode` (or any other setting) in the UI takes
        # effect on the next sweep instead of on the next restart. An unreadable
        # settings document falls back to §3.2 defaults here exactly as it does
        # for polling; the due check inside `capture_closing_lines` fails closed
        # in that case anyway, so no request goes out on a sick datastore.
        current = await load_settings(client, prefix=prefix)
        _refresh_budget(current)
        for sport_key in current.sports_enabled:
            try:
                await capture_closing_lines(
                    provider, client, sport_key=sport_key, settings=current, prefix=prefix
                )
            except Exception:
                log.exception("closing capture failed for %s", sport_key)

    async def _grade() -> None:
        current = await load_settings(client, prefix=prefix)
        for sport_key in current.sports_enabled:
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
            except Exception:
                log.exception("grading failed for %s", sport_key)

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
        """
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
        heartbeat, "interval", seconds=HEARTBEAT_INTERVAL_S, id="heartbeat",
        kwargs={"client": client, "prefix": prefix},
    )
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
        print(
            f"featured interval  {plan.featured_interval_s}s\n"
            f"markets x regions  {plan.markets} x {plan.regions}\n"
            f"sports             {plan.sports}\n"
            f"projected credits  {plan.projected_monthly_credits}/month\n"
            f"budget             {plan.budget}\n"
            f"verdict            {'OK' if plan.affordable else 'OVER BUDGET'}"
        )
        return 0 if plan.affordable else 1
    finally:
        await close_client()


if __name__ == "__main__":
    raise SystemExit(main())

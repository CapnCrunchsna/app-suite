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

from .config import Settings
from .indices import SETTINGS_INDEX, with_prefix
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
    return BudgetPlan(
        featured_interval_s=interval,
        markets=markets,
        regions=regions,
        sports=sports,
        projected_monthly_credits=int(per_sport * sports),
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


async def reset_quota(client, *, prefix: str) -> None:
    """§13's monthly job: zero `quota_used` on every provider."""
    from .indices import PROVIDERS_INDEX

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

    from .engine import capture_closing_lines, run_once
    from .grading import grade

    plan = check_budget(settings)
    scheduler = AsyncIOScheduler(timezone="UTC")

    async def _poll(sport_key: str) -> None:
        try:
            report = await run_once(
                provider, client, sport_key=sport_key, prefix=prefix, sink=sink
            )
            await record_run(client, prefix=prefix, job="poll")
            log.info(
                "poll %s: %d snapshots, %d detections, %d alerted",
                sport_key,
                report.snapshots,
                len(report.detections),
                len(report.alerted),
            )
        except Exception:
            # A failed cycle must not take the scheduler down; the next tick
            # retries and the datastore keeps whatever the last one wrote.
            log.exception("poll cycle failed for %s", sport_key)

    async def _closing_sweep() -> None:
        for sport_key in settings.sports_enabled:
            try:
                await capture_closing_lines(
                    provider, client, sport_key=sport_key, settings=settings, prefix=prefix
                )
            except Exception:
                log.exception("closing capture failed for %s", sport_key)

    async def _grade() -> None:
        for sport_key in settings.sports_enabled:
            try:
                await grade(
                    provider, client, sport_key=sport_key, settings=settings,
                    prefix=prefix, sink=sink,
                )
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

    for sport_key in settings.sports_enabled:
        scheduler.add_job(
            _poll,
            "interval",
            seconds=plan.featured_interval_s,
            args=[sport_key],
            id=f"poll_featured:{sport_key}",
            max_instances=1,
            coalesce=True,
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
    )
    scheduler.add_job(_grade, "cron", hour=6, minute=0, id="grade")
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
    scheduler.add_job(
        reset_quota, "cron", day=1, hour=0, minute=5, id="quota_reset",
        kwargs={"client": client, "prefix": prefix},
    )
    scheduler.add_job(
        heartbeat, "interval", seconds=HEARTBEAT_INTERVAL_S, id="heartbeat",
        kwargs={"client": client, "prefix": prefix},
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

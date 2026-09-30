"""Month-end sidecar: spend what is left of September's credits on 2026-09-30.

Throwaway, to be deleted with its test once the day's data has been read. The
Odds API allowance resets on 1 October, so whatever the key has not spent by
then is lost; this spends it on information. Every poll goes through
`engine.run_once`, exactly as the dashboard's "Poll now" does, so what lands in
Elasticsearch is shaped like the worker's own data. No setting is written,
`last_poll_at` is not stamped (the weekly plan's stand-down rules never see
this), and the worker is left alone.

What the day buys, most valuable first:

1. **Edge lifetimes.** NCAAF every 45 minutes and NFL hourly, 07:30-19:30 ET.
   Their games are Thursday to Monday, so each opportunity is watched all day
   and §7.4's lifecycle stamps when its line dies, at that resolution.
2. **CLV that is not circular.** Those detections come days before kickoff,
   and the weekly plan's own polls price the games again shortly before they
   start: the later price that seven of the eight graded bets never had.
3. **True closing lines** for today's two MLB wild-card games and tonight's
   NHL games, bought in the minutes before each start, and only when an
   opportunity exists on one of those games. A closing line nobody bet against
   measures nothing.
4. **Three experiments for October** (about 3 credits): whether naming the ten
   enabled books bills as one region instead of two, whether the same Maryland
   books come back that way, and whether a poll filtered to an empty time
   window is free.

Whatever is left at 19:30 ET goes on back-to-back rounds before 20:00, in case
the allowance resets at midnight UTC. The 22:06 closing sweep runs only if the
counter has not reset by then and anything is left.

Guard rails:

- A free `/sports` call precedes every paid request. If `x-requests-used` has
  gone *down*, the allowance has reset and anything more would be October's
  money, so the sidecar stops.
- Until 17:45 ET it holds 12 credits back for the worker's 17:30 NHL/NBA slot,
  and it never polls NHL within 15 minutes of that slot, so two cycles never
  reconcile the same sport's opportunities at once. It never polls NBA, whose
  next game is 20 October.
- Settings are re-read before every action, so a kill switch or offline mode
  set in the UI during the day applies here too.
- It sleeps in one-minute steps against the wall clock, so a laptop sleep
  delays the next item rather than pushing the whole day back.

Start it any time before 07:25 ET on the 30th; started later, it skips what it
missed and carries on. `--dry-run` prints the day and spends nothing::

    uv run --directory C:/Users/Galavant/Documents/MetrumDigital/app-suite/apps/edgeline-api python sidecars/month_end_2026_09.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DAY = date(2026, 9, 30)
PREFIX = "edgeline-"

NCAAF = "americanfootball_ncaaf"
NFL = "americanfootball_nfl"
NHL = "icehockey_nhl"
MLB = "baseball_mlb"
NBA = "basketball_nba"

#: One featured poll at the worker's settings: 3 markets x 2 regions.
POLL_COST = 6
#: The three experiments are h2h only: at most 1 + 2 + 2.
EXPERIMENT_COST = 5
#: The worker's 17:30 slot polls NHL and NBA; this much stays unspent until it has.
WORKER_RESERVE = 12
WORKER_SLOT = time(17, 30)
RESERVE_UNTIL = time(17, 45)
BURN_FROM = time(19, 30)
BURN_UNTIL = time(19, 58)
BURN_SPORTS = (NCAAF, NFL, NHL)

RUN_LOG = Path(__file__).parent / "runs" / f"{DAY.isoformat()}.jsonl"

log = logging.getLogger("sidecar")


def at(hhmm: str) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime.combine(DAY, time(hour, minute), tzinfo=ET)


def now_et() -> datetime:
    return datetime.now(ET)


def iso_utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Action:
    at: datetime
    kind: str  # "experiments" | "poll" | "close" | "burn"
    sport: str | None = None
    #: For "close": how far past `at` a start still counts as closing.
    window_s: int = 0

    @property
    def budgeted(self) -> int:
        """The most this item can spend. A burn spends whatever is left."""
        return {"experiments": EXPERIMENT_COST, "poll": POLL_COST, "close": POLL_COST}.get(
            self.kind, 0
        )


def build_plan() -> list[Action]:
    """The day, in ET. The test holds its total to what the worker leaves."""
    plan = [Action(at("07:25"), "experiments")]
    slot = at("07:30")
    while slot <= at("19:30"):  # NCAAF: 61 games Thursday to Saturday, the richest slate
        plan.append(Action(slot, "poll", NCAAF))
        slot += timedelta(minutes=45)
    plan += [Action(at(f"{hour:02d}:40"), "poll", NFL) for hour in range(7, 19)]
    plan += [
        Action(at(hhmm), "poll", NHL)
        for hhmm in ("08:00", "10:00", "12:00", "14:00", "16:00", "18:30")
    ]
    plan += [Action(at(hhmm), "poll", MLB) for hhmm in ("08:05", "11:05", "13:30", "16:30")]
    plan += [
        Action(at("13:56"), "close", MLB, window_s=600),  # first pitch 14:00
        Action(at("16:56"), "close", MLB, window_s=600),  # 17:00
        Action(at("19:26"), "close", NHL, window_s=900),  # 19:30 and 19:40
        Action(at("22:06"), "close", NHL, window_s=600),  # 22:10, only if not yet reset
        Action(datetime.combine(DAY, BURN_FROM, tzinfo=ET), "burn"),
    ]
    return sorted(plan, key=lambda action: action.at)


def coalesce(due: list[Action], now: datetime) -> list[Action]:
    """Of everything that came due while the process slept, what is still worth doing.

    Missed polls of one sport collapse to the latest: two back-to-back polls of
    the same slate measure nothing the second would not. A closing sweep whose
    games have started is dropped, because that closing line can no longer be
    bought.
    """
    latest: dict[tuple[str, str | None], Action] = {}
    for action in sorted(due, key=lambda item: item.at):
        if action.kind == "close" and now >= action.at + timedelta(seconds=action.window_s):
            continue
        latest[(action.kind, action.sport)] = action
    return sorted(latest.values(), key=lambda item: item.at)


def spend_decision(
    *, used: int | None, remaining: int | None, last_used: int | None, cost: int, now: datetime
) -> str:
    """"ok", "short" (skip this item) or "reset" (stop: the rest is October's)."""
    if used is None or remaining is None:
        return "short"  # counters unknown: never spend blind
    if last_used is not None and used < last_used:
        return "reset"
    held = WORKER_RESERVE if now.astimezone(ET).time() < RESERVE_UNTIL else 0
    return "ok" if remaining - cost >= held else "short"


async def sleep_until(moment: datetime) -> None:
    """Wall-clock sleep in one-minute steps, so a laptop sleep costs only itself."""
    while (left := (moment - now_et()).total_seconds()) > 0:
        await asyncio.sleep(min(60.0, left))


class Sidecar:
    def __init__(self, provider: Any, client: Any) -> None:
        self.provider = provider
        self.client = client
        self.last_used: int | None = None
        self.stopped: str | None = None
        self.spent = 0
        self.totals = {"polls": 0, "detections": 0, "alerted": 0, "closing_events": 0}

    async def run(self, action: Action) -> None:
        if action.kind == "experiments":
            await self.experiments()
        elif action.kind == "poll":
            await self.poll(action.sport)
        elif action.kind == "close":
            await self.close(action)
        elif action.kind == "burn":
            await self.burn()

    async def _gate(self, cost: int) -> bool:
        """Read the counters for free, then decide whether `cost` may be spent."""
        try:
            await self.provider.list_sports()
        except Exception as exc:
            log.warning("could not read the counters (%s); skipping this item", exc)
            return False
        quota = self.provider.quota
        verdict = spend_decision(
            used=quota.used,
            remaining=quota.remaining,
            last_used=self.last_used,
            cost=cost,
            now=now_et(),
        )
        if verdict == "reset":
            self.stopped = (
                f"the allowance reset ({self.last_used} used before, {quota.used} now); "
                "stopping so October keeps its credits"
            )
            log.warning(self.stopped)
            return False
        self.last_used = quota.used
        if verdict == "short":
            log.info("skipping: %s credits left, %s needed plus any reserve", quota.remaining, cost)
        return verdict == "ok"

    def _record(self, kind: str, sport: str | None, cost: int, **fields: Any) -> None:
        quota = self.provider.quota
        if quota.used is not None:
            # max(): a counter lower than the last one seen is a reset, and the
            # next `_gate` has to be able to see that.
            self.last_used = max(self.last_used or 0, quota.used)
        self.spent += max(cost, 0)
        row = {
            "at": iso_utc(now_et()),
            "kind": kind,
            "sport": sport,
            "cost": cost,
            "used": quota.used,
            "remaining": quota.remaining,
            **fields,
        }
        RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
        with RUN_LOG.open("a", encoding="utf-8") as out:
            out.write(json.dumps(row) + "\n")
        detail = " ".join(f"{key}={value}" for key, value in fields.items())
        log.info("%-10s %-22s cost=%s left=%s %s", kind, sport or "", cost, quota.remaining, detail)

    async def poll(self, sport: str) -> bool:
        """One ordinary featured cycle. True when it spent anything."""
        from edgeline.engine import load_settings, run_once
        from edgeline.scheduler import record_quota

        if not await self._gate(POLL_COST):
            return False
        settings = await load_settings(self.client, prefix=PREFIX)
        before = self.provider.quota.used or 0
        report = await run_once(
            self.provider, self.client, sport_key=sport, prefix=PREFIX, settings=settings
        )
        await record_quota(self.client, self.provider.key, self.provider.quota, prefix=PREFIX)
        cost = (self.provider.quota.used or before) - before
        self.totals["polls"] += 1
        self.totals["detections"] += len(report.detections)
        self.totals["alerted"] += len(report.alerted)
        self._record(
            "poll",
            sport,
            cost,
            events=report.events,
            snapshots=report.snapshots,
            detections=len(report.detections),
            alerted=len(report.alerted),
            closed=len(report.closed),
            expired=len(report.expired),
            line_deaths=len(report.line_deaths),
            offline=report.offline,
            skipped=report.skipped_reason,
        )
        return cost > 0

    async def close(self, action: Action) -> None:
        """True closing lines for games about to start, if anything was found on them."""
        from edgeline.engine import capture_closing_lines, load_settings
        from edgeline.scheduler import record_quota

        games = await self._games_with_opportunities(action.sport, action.window_s)
        if not games:
            self._record("close", action.sport, 0, skipped="no opportunity on the games starting")
            return
        if not await self._gate(POLL_COST):
            return
        settings = await load_settings(self.client, prefix=PREFIX)
        # "all" in memory only, never stored: the check above has already limited
        # this sweep to games something was detected on.
        tuned = settings.model_copy(
            update={"closing_capture_mode": "all", "closing_capture_offset_s": action.window_s}
        )
        before = self.provider.quota.used or 0
        captured = await capture_closing_lines(
            self.provider, self.client, sport_key=action.sport, settings=tuned, prefix=PREFIX
        )
        await record_quota(self.client, self.provider.key, self.provider.quota, prefix=PREFIX)
        self.totals["closing_events"] += len(captured)
        self._record(
            "close",
            action.sport,
            (self.provider.quota.used or before) - before,
            games_with_opportunities=len(games),
            captured=len(captured),
        )

    async def _games_with_opportunities(self, sport: str, window_s: int) -> list[str]:
        """Games starting inside the window that at least one opportunity was found on."""
        from edgeline.indices import EVENTS_INDEX, OPPORTUNITIES_INDEX, with_prefix

        now = datetime.now(timezone.utc)
        end = now + timedelta(seconds=window_s)
        starting = await self.client.search(
            index=with_prefix(EVENTS_INDEX, PREFIX),
            query={
                "bool": {
                    "filter": [
                        {"term": {"sport_key": sport}},
                        {"range": {"commence_time": {"gt": iso_utc(now), "lte": iso_utc(end)}}},
                    ]
                }
            },
            size=50,
            source=False,
        )
        ids = [hit["_id"] for hit in starting["hits"]["hits"]]
        if not ids:
            return []
        found = await self.client.search(
            index=with_prefix(OPPORTUNITIES_INDEX, PREFIX),
            query={"terms": {"event_id": ids}},
            size=100,
            source=["event_id"],
        )
        return sorted({hit["_source"]["event_id"] for hit in found["hits"]["hits"]})

    async def experiments(self) -> None:
        """Three cheap questions October's plan depends on, asked of the real API."""
        from edgeline.engine import load_enabled_books

        enabled = sorted(await load_enabled_books(self.client, prefix=PREFIX))
        now = datetime.now(timezone.utc)
        base = {"markets": "h2h", "oddsFormat": "decimal"}
        asks = {
            # Ten or fewer named books should bill as one region: half of us,us2.
            "named_books": (NCAAF, {**base, "bookmakers": ",".join(enabled)}),
            "two_regions": (NCAAF, {**base, "regions": "us,us2"}),
            # NBA lists games out to 12-25, so its plain /odds is never empty.
            # Limited to the next day it should be, and an empty answer is free.
            "empty_window": (
                NBA,
                {
                    **base,
                    "regions": "us,us2",
                    "commenceTimeFrom": iso_utc(now),
                    "commenceTimeTo": iso_utc(now + timedelta(days=1)),
                },
            ),
        }
        books_by_ask: dict[str, dict[str, set[str]]] = {}
        for name, (sport, params) in asks.items():
            if not await self._gate(2):
                return
            before = self.provider.quota.used or 0
            # The adapter's request path, for its HTTP policy and key handling; it
            # has no public method for these parameters, and this file is throwaway.
            response = await self.provider._request(
                "odds", f"/sports/{sport}/odds", params, sport_key=sport
            )
            books = {
                event["id"]: {book["key"] for book in event.get("bookmakers", [])}
                for event in response.payload
            }
            books_by_ask[name] = books
            self._record(
                "experiment",
                sport,
                (self.provider.quota.used or before) - before,
                ask=name,
                events=len(books),
                books=sorted(set().union(*books.values())) if books else [],
            )
        named, regions = books_by_ask["named_books"], books_by_ask["two_regions"]
        missing = sum(
            1
            for event_id, present in regions.items()
            if (present & set(enabled)) - named.get(event_id, set())
        )
        self._record(
            "experiment",
            NCAAF,
            0,
            ask="coverage",
            events_compared=len(regions),
            events_missing_an_enabled_book_when_named=missing,
        )

    async def burn(self) -> None:
        """Spend what is left before 20:00 ET, in case the reset is at midnight UTC."""
        until = datetime.combine(DAY, BURN_UNTIL, tzinfo=ET)
        while now_et() < until and not self.stopped:
            spent = False
            for sport in BURN_SPORTS:
                if now_et() >= until or self.stopped:
                    break
                spent = await self.poll(sport) or spent
            if not spent:
                return  # nothing left to spend
            await sleep_until(min(until, now_et() + timedelta(minutes=4)))


async def main(dry_run: bool) -> int:
    from edgeline.engine import load_settings
    from edgeline.es import close_client, get_client
    from edgeline.providers.the_odds_api import TheOddsApiProvider

    plan = build_plan()
    client = get_client()
    settings = await load_settings(client, prefix=PREFIX)
    # The adapter's own pace guard stays on as a backstop: on the last day of
    # the month it allows the whole allowance, and it still refuses at 500.
    provider = TheOddsApiProvider(monthly_budget=settings.quota_monthly_budget)
    try:
        await provider.list_sports()  # free
        budgeted = sum(a.budgeted for a in plan if a.at < at(BURN_FROM.strftime("%H:%M")))
        log.info(
            "counters: %s used, %s left. The day budgets up to %d before the 19:30 burn "
            "and holds %d for the worker's 17:30 slot.",
            provider.quota.used,
            provider.quota.remaining,
            budgeted,
            WORKER_RESERVE,
        )
        if dry_run:
            for action in plan:
                window = f"  (starts within {action.window_s // 60} min)" if action.window_s else ""
                print(
                    f"{action.at:%H:%M} ET  {action.kind:<11} {action.sport or '':<22} "
                    f"<= {action.budgeted}{window}"
                )
            return 0
        if now_et().date() > DAY:
            log.warning("%s is over; nothing to do", DAY)
            return 0

        sidecar = Sidecar(provider, client)
        pending = plan
        while pending and not sidecar.stopped:
            now = now_et()
            if now.date() > DAY:
                break
            due = [action for action in pending if action.at <= now]
            if not due:
                await sleep_until(min(action.at for action in pending))
                continue
            pending = [action for action in pending if action.at > now]
            for action in coalesce(due, now):
                if sidecar.stopped:
                    break
                try:
                    await sidecar.run(action)
                except Exception:
                    log.exception("%s %s failed; carrying on", action.kind, action.sport or "")
        log.info(
            "done: %d credits spent%s. %s",
            sidecar.spent,
            f" ({sidecar.stopped})" if sidecar.stopped else "",
            sidecar.totals,
        )
        return 0
    finally:
        await provider.aclose()
        await close_client()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--dry-run", action="store_true", help="print the day and the counters; spend nothing"
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    # httpx logs full request URLs at INFO and the key is a query parameter. The
    # adapter masks it; this keeps the line out entirely, along with the
    # Elasticsearch client's request log, which is only noise here.
    for chatty in ("httpx", "httpcore", "elastic_transport"):
        logging.getLogger(chatty).setLevel(logging.WARNING)
    raise SystemExit(asyncio.run(main(args.dry_run)))

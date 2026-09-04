"""Opportunity hashing and lifecycle — spec §7.4.

The hash is the document `_id` in `edgeline-opportunities`, which makes it the
only uniqueness constraint the system has (§4.4 rule 1): there is nothing else to
rely on, so re-processing the same detection must produce a byte-identical hash or
it silently becomes a second opportunity. The formula is transcribed from §7.4
literally, `sorted()`'s list repr included — it is a wire format now, not an
implementation detail, and "tidying" it would orphan every stored document.

Two independent gates stand between a detection and an alert, and they answer
different questions. `edge_improved` asks whether *this* opportunity is now
materially better than when it was last alerted. The cooldown asks whether *any*
alert has gone out for this sport and market recently. Both must pass.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone

STATUS_OPEN = "open"
STATUS_ALERTED = "alerted"
STATUS_CLOSED = "closed"
STATUS_EXPIRED = "expired"
LIVE_STATUSES = frozenset({STATUS_OPEN, STATUS_ALERTED})


def opp_hash(
    event_id: str,
    market_key: str,
    leg_selections: Iterable[str],
    leg_books: Iterable[str],
) -> str:
    """§7.4's `opp_hash`, used as the `_id` in `edgeline-opportunities`.

    Sorting both lists is what makes the hash order-independent: the same two
    legs discovered in the opposite order are the same opportunity, and must not
    produce a second document.
    """
    payload = (
        f"{event_id}|{market_key}|{sorted(leg_selections)}|{sorted(leg_books)}"
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_iso(value: str) -> datetime:
    """Parse a §1 UTC ISO-8601 string, `Z` suffix included, as an aware datetime."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def edge_improved(previous_edge_pct: float, new_edge_pct: float, delta_pct: float) -> bool:
    """§7.4: re-alert only if the edge grew by at least `edge_improve_delta_pct`.

    Strictly "grew": an opportunity whose edge decayed, or wobbled by less than
    the delta, is updated in place and stays quiet. Without this a single
    long-lived mispricing would re-alert on every cycle.
    """
    return (new_edge_pct - previous_edge_pct) >= delta_pct


def cooldown_expired(
    last_alert_at: str | None, now: datetime, cooldown_s: int
) -> bool:
    """Whether `alert_cooldown_s` has elapsed since the last alert on this key."""
    if last_alert_at is None:
        return True
    return (now - parse_iso(last_alert_at)).total_seconds() >= cooldown_s


def cooldown_key(sport_key: str, market_key: str) -> tuple[str, str]:
    """§7.4's cooldown is per `(sport, market_key)`, not per opportunity."""
    return (sport_key, market_key)


def select_cooldown_winners(
    candidates: Sequence[tuple[tuple[str, str], object, float]],
    *,
    last_alert_at_by_key: dict[tuple[str, str], str],
    now: datetime,
    cooldown_s: int,
) -> list[object]:
    """Pick at most one alert per `(sport, market_key)` — the highest edge (§7.4).

    `candidates` are `(cooldown_key, detection, edge_pct)` triples. Detections
    that lose the slot are not discarded by this function; they are simply not
    alerted, and the caller still stores them.
    """
    best: dict[tuple[str, str], tuple[float, object]] = {}
    for key, detection, edge_pct in candidates:
        if not cooldown_expired(last_alert_at_by_key.get(key), now, cooldown_s):
            continue
        current = best.get(key)
        if current is None or edge_pct > current[0]:
            best[key] = (edge_pct, detection)
    return [detection for _, detection in best.values()]


def is_expired(commence_time: str, now: datetime) -> bool:
    """§7.4: an opportunity expires when its event starts."""
    return now >= parse_iso(commence_time)


def closing_transition(
    stored_edge_pct: float, *, now_iso: str
) -> dict[str, object]:
    """The partial document for an opportunity that vanished from the feed (§7.4).

    The edge it carried when it disappeared becomes `closing_edge_pct`, which is
    what later CLV work compares against.
    """
    return {
        "status": STATUS_CLOSED,
        "closed_at": now_iso,
        "closing_edge_pct": stored_edge_pct,
    }


def expiry_transition(*, now_iso: str) -> dict[str, object]:
    return {"status": STATUS_EXPIRED, "closed_at": now_iso}

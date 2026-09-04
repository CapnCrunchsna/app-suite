"""Provider JSON -> canonical rows — spec §7.2, §7.3.

Thin by design. The Odds API returns consistent event and team names across
bookmakers *within one response*, so while it is the only provider there is no
cross-book fuzzy matching to do (§7.2) — and per §16.3 there is none to invent
either. The rule this module enforces above all others is: **anything that does
not parse is quarantined with its raw JSON, never guessed at.** A wrong selection
string here does not surface as an error; it surfaces as a recommendation to bet
on the wrong thing.

Two outputs beyond the snapshot list, both optional keyword sinks so the §7.2
signature ``normalize(provider_key, raw) -> list[BookOddsSnapshot]`` stays intact:

* ``quarantine`` collects :class:`UnmatchedRow` for ``edgeline-unmatched`` (§7.3).
* ``skipped_middles`` collects the spread/total pairings v1 refuses to treat as
  opportunities (§7.2's same-line-only rule).

Comparison grouping lives here too, in :func:`group_same_line`, because "same
line only" is a property of how rows may be grouped, not something each detector
should re-decide.
"""

from __future__ import annotations

import itertools
import logging
from collections.abc import MutableSequence
from dataclasses import dataclass, field
from typing import Any

from .indices import event_doc_id
from .schemas import BookOddsSnapshot, utc_now_iso

log = logging.getLogger(__name__)

# Market families. Anything outside these three that carries a per-outcome
# `description` (the player) is treated as a prop; anything else is quarantined
# as an unknown market key rather than parsed on a hunch (§7.3).
H2H_MARKETS = frozenset({"h2h"})
SPREAD_MARKETS = frozenset({"spreads"})
TOTALS_MARKETS = frozenset({"totals"})
OVER_UNDER_NAMES = frozenset({"Over", "Under"})

# §7.3 quarantine reasons, plus the structural ones a malformed payload needs.
UNKNOWN_MARKET_KEY = "unknown_market_key"
MISSING_POINT = "missing_point"
UNKNOWN_OUTCOME_SHAPE = "unknown_outcome_shape"
DUPLICATE_CONFLICTING_PRICE = "duplicate_conflicting_price"
MALFORMED_EVENT = "malformed_event"
MALFORMED_BOOKMAKER = "malformed_bookmaker"
MALFORMED_MARKET = "malformed_market"
MISSING_PRICE = "missing_price"


@dataclass(frozen=True)
class UnmatchedRow:
    """One quarantined fragment, shaped for ``edgeline-unmatched`` (§4.3)."""

    provider_key: str
    reason: str
    raw: Any
    created_at: str = field(default_factory=utc_now_iso)

    def to_document(self) -> dict[str, Any]:
        return {
            "provider_key": self.provider_key,
            "raw": self.raw,
            "reason": self.reason,
            "resolved": False,
            "created_at": self.created_at,
        }


@dataclass(frozen=True)
class SkippedMiddle:
    """A spread/total pairing across different lines. v1 logs and skips (§7.2)."""

    event_id: str
    market_key: str
    over: BookOddsSnapshot
    under: BookOddsSnapshot


class _Quarantine(Exception):
    """Internal control flow: this fragment goes to ``edgeline-unmatched``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def normalize(
    provider_key: str,
    raw: Any,
    *,
    quarantine: MutableSequence[UnmatchedRow] | None = None,
    skipped_middles: MutableSequence[SkippedMiddle] | None = None,
    fetched_at: str | None = None,
) -> list[BookOddsSnapshot]:
    """Map one provider odds response to canonical snapshots.

    Accepts either the featured-odds shape (a list of events) or the per-event
    odds shape (a single event object). Never raises on bad provider data: every
    unparseable fragment becomes an :class:`UnmatchedRow` instead.
    """
    stamp = fetched_at or utc_now_iso()
    sink: MutableSequence[UnmatchedRow] = (
        quarantine if quarantine is not None else []
    )
    before = len(sink)

    snapshots: list[BookOddsSnapshot] = []
    for event in _iter_events(raw, provider_key, sink):
        snapshots.extend(_normalize_event(provider_key, event, stamp, sink))

    if skipped_middles is not None:
        skipped_middles.extend(find_skipped_middles(snapshots))
    else:
        find_skipped_middles(snapshots)  # still logged, per §7.2

    if quarantine is None and len(sink) > before:
        # Losing quarantine rows silently is exactly the failure §7.3 exists to
        # prevent, so a caller that did not pass a sink at least hears about it.
        log.warning(
            "%s: %d fragment(s) quarantined but no sink was supplied; "
            "pass quarantine= to persist them",
            provider_key,
            len(sink) - before,
        )

    return snapshots


def canonical_selection(market_key: str, outcome: dict[str, Any]) -> tuple[str, float | None]:
    """The §7.2 canonical selection string, plus the line it belongs to.

    * ``h2h`` -> the team name exactly as the provider gives it, line ``None``
    * ``totals`` -> ``"Over 8.5"`` / ``"Under 8.5"``
    * ``spreads`` -> ``"New York Yankees -1.5"`` (sign always explicit)
    * props -> ``"Aaron Judge Over 0.5"``, player from the outcome's ``description``

    §7.2 spells the prop form as ``"{player} Over {point}"``. The Over/Under word
    is taken from the outcome rather than hard-coded: hard-coding "Over" would
    label an Under outcome as its opposite, which is not a formatting slip but a
    wrong bet. An outcome whose name is neither is quarantined, not renamed.
    """
    name = outcome.get("name")
    if not isinstance(name, str) or not name.strip():
        raise _Quarantine(UNKNOWN_OUTCOME_SHAPE)
    name = name.strip()

    point = outcome.get("point")
    description = outcome.get("description")

    if market_key in H2H_MARKETS:
        return name, None

    if market_key in TOTALS_MARKETS:
        value = _require_point(point)
        if name not in OVER_UNDER_NAMES:
            raise _Quarantine(UNKNOWN_OUTCOME_SHAPE)
        return f"{name} {_format_point(value)}", value

    if market_key in SPREAD_MARKETS:
        value = _require_point(point)
        return f"{name} {_format_signed(value)}", value

    if isinstance(description, str) and description.strip():
        value = _require_point(point)
        if name not in OVER_UNDER_NAMES:
            raise _Quarantine(UNKNOWN_OUTCOME_SHAPE)
        return f"{description.strip()} {name} {_format_point(value)}", value

    raise _Quarantine(UNKNOWN_MARKET_KEY)


def group_same_line(
    snapshots: list[BookOddsSnapshot],
) -> dict[tuple[str, str, float | None], list[BookOddsSnapshot]]:
    """Group rows into the only comparison sets v1 permits (§7.2).

    The key is ``(event_id, market_key, line)``. Because the line is part of the
    key, two prices on different lines can never end up in the same group, which
    is the same-line-only rule expressed as a data structure rather than as a
    check every detector has to remember to perform.
    """
    groups: dict[tuple[str, str, float | None], list[BookOddsSnapshot]] = {}
    for snapshot in snapshots:
        key = (
            event_doc_id(snapshot.sport_key, snapshot.provider_event_id),
            snapshot.market_key,
            snapshot.line,
        )
        groups.setdefault(key, []).append(snapshot)
    return groups


def find_skipped_middles(snapshots: list[BookOddsSnapshot]) -> list[SkippedMiddle]:
    """Spread/total pairings on different lines that v1 skips and logs (§7.2).

    A middle is a pairing where both sides can win: ``Over 8.0`` against
    ``Under 8.5``, or ``Yankees -1.5`` against ``Red Sox +2.5``. v1 does not act
    on them — they are recorded here purely so the count is visible when the
    question of supporting them comes up.
    """
    middles: list[SkippedMiddle] = []

    by_market: dict[tuple[str, str], list[BookOddsSnapshot]] = {}
    for snapshot in snapshots:
        if snapshot.market_key not in TOTALS_MARKETS | SPREAD_MARKETS:
            continue
        if snapshot.line is None:
            continue
        key = (
            event_doc_id(snapshot.sport_key, snapshot.provider_event_id),
            snapshot.market_key,
        )
        by_market.setdefault(key, []).append(snapshot)

    for (event_id, market_key), rows in by_market.items():
        if market_key in TOTALS_MARKETS:
            overs = [r for r in rows if r.selection.startswith("Over ")]
            unders = [r for r in rows if r.selection.startswith("Under ")]
            pairs = (
                (over, under)
                for over, under in itertools.product(overs, unders)
                # Under 8.5 pays when the total lands under 8.5; Over 8.0 pays
                # from 8.5 up. Both win in the gap, so any under-line strictly
                # above the over-line is a middle.
                if under.line > over.line  # type: ignore[operator]
            )
        else:
            pairs = (
                (a, b)
                for a, b in itertools.combinations(rows, 2)
                # Opposite teams whose handicaps sum above zero leave a gap in
                # which both sides cover. Equal-and-opposite lines sum to zero.
                if _spread_team(a) != _spread_team(b)
                and (a.line + b.line) > 0  # type: ignore[operator]
            )

        for first, second in pairs:
            middle = SkippedMiddle(
                event_id=event_id, market_key=market_key, over=first, under=second
            )
            middles.append(middle)
            log.info(
                "skipped middle (v1 is same-line only): %s %s | %s @ %s %s vs %s @ %s %s",
                event_id,
                market_key,
                first.selection,
                first.book_key,
                first.price_decimal,
                second.selection,
                second.book_key,
                second.price_decimal,
            )

    return middles


# ---- internals -------------------------------------------------------------


def _iter_events(
    raw: Any, provider_key: str, sink: MutableSequence[UnmatchedRow]
) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        events = []
        for item in raw:
            if isinstance(item, dict):
                events.append(item)
            else:
                sink.append(UnmatchedRow(provider_key, MALFORMED_EVENT, item))
        return events
    sink.append(UnmatchedRow(provider_key, MALFORMED_EVENT, raw))
    return []


def _normalize_event(
    provider_key: str,
    event: dict[str, Any],
    fetched_at: str,
    sink: MutableSequence[UnmatchedRow],
) -> list[BookOddsSnapshot]:
    try:
        header = _event_header(event)
    except _Quarantine as exc:
        sink.append(UnmatchedRow(provider_key, exc.reason, event))
        return []

    # (book_key, market_key, selection) -> snapshot, so a second price for the
    # same selection in one response can be spotted (§7.3).
    seen: dict[tuple[str, str, str], BookOddsSnapshot] = {}
    conflicted: set[tuple[str, str, str]] = set()

    bookmakers = event.get("bookmakers")
    if bookmakers is None:
        return []
    if not isinstance(bookmakers, list):
        sink.append(UnmatchedRow(provider_key, MALFORMED_EVENT, event))
        return []

    for bookmaker in bookmakers:
        if not isinstance(bookmaker, dict) or not _nonempty_str(bookmaker.get("key")):
            sink.append(UnmatchedRow(provider_key, MALFORMED_BOOKMAKER, bookmaker))
            continue
        book_key = bookmaker["key"].strip()

        markets = bookmaker.get("markets") or []
        if not isinstance(markets, list):
            sink.append(UnmatchedRow(provider_key, MALFORMED_BOOKMAKER, bookmaker))
            continue

        for market in markets:
            if not isinstance(market, dict) or not _nonempty_str(market.get("key")):
                sink.append(UnmatchedRow(provider_key, MALFORMED_MARKET, market))
                continue
            market_key = market["key"].strip()

            outcomes = market.get("outcomes") or []
            if not isinstance(outcomes, list):
                sink.append(UnmatchedRow(provider_key, MALFORMED_MARKET, market))
                continue

            for outcome in outcomes:
                if not isinstance(outcome, dict):
                    sink.append(UnmatchedRow(provider_key, UNKNOWN_OUTCOME_SHAPE, outcome))
                    continue
                try:
                    selection, line = canonical_selection(market_key, outcome)
                    price = _require_price(outcome.get("price"))
                except _Quarantine as exc:
                    sink.append(
                        UnmatchedRow(
                            provider_key,
                            exc.reason,
                            {"book_key": book_key, "market_key": market_key, "outcome": outcome},
                        )
                    )
                    continue

                key = (book_key, market_key, selection)
                previous = seen.get(key)
                if previous is not None:
                    if previous.price_decimal != price:
                        # Two different prices for one selection in one response:
                        # neither can be trusted, so drop both and quarantine.
                        conflicted.add(key)
                        sink.append(
                            UnmatchedRow(
                                provider_key,
                                DUPLICATE_CONFLICTING_PRICE,
                                {
                                    "book_key": book_key,
                                    "market_key": market_key,
                                    "selection": selection,
                                    "prices": [previous.price_decimal, price],
                                },
                            )
                        )
                    continue

                seen[key] = BookOddsSnapshot(
                    **header,
                    book_key=book_key,
                    market_key=market_key,
                    selection=selection,
                    line=line,
                    price_decimal=price,
                    fetched_at=fetched_at,
                )

    return [snapshot for key, snapshot in seen.items() if key not in conflicted]


def _event_header(event: dict[str, Any]) -> dict[str, str]:
    fields = {
        "provider_event_id": event.get("id"),
        "sport_key": event.get("sport_key"),
        "commence_time": event.get("commence_time"),
        "home_team": event.get("home_team"),
        "away_team": event.get("away_team"),
    }
    if not all(_nonempty_str(value) for value in fields.values()):
        raise _Quarantine(MALFORMED_EVENT)
    return {name: value.strip() for name, value in fields.items()}  # type: ignore[union-attr]


def _spread_team(snapshot: BookOddsSnapshot) -> str:
    """The team out of a ``"{team} {+/-point}"`` selection."""
    return snapshot.selection.rsplit(" ", 1)[0]


def _require_point(point: Any) -> float:
    # bool is an int subclass in Python; a `true` where a number belongs is bad
    # data, not the line 1.0.
    if isinstance(point, bool) or not isinstance(point, (int, float)):
        raise _Quarantine(MISSING_POINT)
    return float(point)


def _require_price(price: Any) -> float:
    if isinstance(price, bool) or not isinstance(price, (int, float)):
        raise _Quarantine(MISSING_PRICE)
    value = float(price)
    # Decimal odds are a payout multiplier; 1.0 would be a bet that returns the
    # stake and nothing else, and below 1.0 is not a price at all.
    if value <= 1.0:
        raise _Quarantine(MISSING_PRICE)
    return value


def _format_point(value: float) -> str:
    return str(float(value))


def _format_signed(value: float) -> str:
    return f"{float(value):+}"


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())

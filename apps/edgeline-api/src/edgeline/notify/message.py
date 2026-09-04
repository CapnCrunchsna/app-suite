"""Alert rendering — spec §9.2's formats, without a channel attached.

§9.2 is written in Discord's vocabulary (`discord.Embed`, `discord.ui.View`,
`custom_id`). Everything it actually specifies, though, is content: a title, an
ordered set of lines, a footer, a colour, and a set of buttons carrying stable
ids. `AlertMessage` holds exactly that, so §9.2 can be implemented and tested now
and a Discord or Telegram adapter becomes a mapping over it later rather than a
rewrite of the pipeline.

Two deviations from a literal reading, both forced and both deliberate:

* **No link line when there is no link.** §9.2's `[Open {book}](link)` assumes a
  usable deep link. No book has a verified template yet (§9.4, T4.3), so emitting
  the line would render `[Open dk]()` — a dead control on a real money decision.
  The line is omitted instead, which is visibly incomplete rather than quietly
  broken.
* **Display timezone is a parameter, not a setting.** §17 lists it as a user
  input "used in §9.2, UI", but §3.2's key set does not contain it, and adding a
  key to that table is a spec change rather than an implementation choice. It
  defaults to §9.2's America/New_York and is threaded through explicitly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

from ..dedup import parse_iso
from ..oddsmath import decimal_to_american
from ..schemas import StakePlan

DEFAULT_TIMEZONE = "America/New_York"
EV_COLOR = 0x2DD4BF
ARB_COLOR = 0xF59E0B

LEG_NUMERALS = ("1️⃣", "2️⃣", "3️⃣")


@dataclass(frozen=True)
class AlertButton:
    """One tappable control. `custom_id` is §9.3's routing key and must be stable."""

    custom_id: str
    label: str


@dataclass(frozen=True)
class AlertMessage:
    """A rendered alert, before any channel has seen it."""

    kind: str  # 'ev' | 'arb'
    title: str
    lines: list[str] = field(default_factory=list)
    footer: str = ""
    color: int = EV_COLOR
    buttons: list[AlertButton] = field(default_factory=list)

    def to_text(self) -> str:
        """Plain-text rendering, for the log sink and for test assertions."""
        body = "\n".join([self.title, *self.lines])
        if self.footer:
            body += f"\n— {self.footer}"
        if self.buttons:
            body += "\n[" + "] [".join(b.label for b in self.buttons) + "]"
        return body


def format_money(cents: int) -> str:
    """`$11` for whole dollars, `$11.50` otherwise.

    Stakes are rounded to `stake_rounding_cents` (default 100), so the common
    case is whole dollars and a trailing `.00` is noise on a phone screen.
    """
    if cents % 100 == 0:
        return f"${cents // 100}"
    return f"${cents / 100:.2f}"


def format_american(price_decimal: float) -> str:
    american = decimal_to_american(price_decimal)
    return f"{american:+d}"


def format_local_time(iso: str, timezone_name: str = DEFAULT_TIMEZONE) -> str:
    """Event start in the reader's timezone — §1 stores UTC, the UI converts."""
    try:
        zone = ZoneInfo(timezone_name)
    except Exception:
        # An unknown zone must not take an alert down; §9.2's default stands in.
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    local = parse_iso(iso).astimezone(zone)
    # %-I is glibc-only and this runs on Windows, so strip the zero by hand.
    return local.strftime("%a %d %b %I:%M %p").replace(" 0", " ")


def _link_line(label: str, deep_link: str) -> str | None:
    """§9.2's link line, or nothing when no verified template exists (§9.4)."""
    if not deep_link:
        return None
    return f"[{label} ➜]({deep_link})"


def render_ev(
    detection,
    plan: StakePlan,
    *,
    recommendation_id: str,
    paper_mode: bool,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> AlertMessage:
    """§9.2's +EV embed."""
    leg = detection.legs[0]
    stake_leg = plan.legs[0]
    fair_price = 1.0 / detection.consensus_prob if detection.consensus_prob else None

    lines = [
        f"{leg.selection} @ {format_american(leg.price_decimal)}"
        + (f" · fair {format_american(fair_price)}" if fair_price else "")
    ]
    lines.append(f"Stake: `{format_money(stake_leg.stake_cents)}`")
    link = _link_line(f"Open {leg.book_key}", stake_leg.deep_link)
    if link:
        lines.append(link)

    footer = (
        "PAPER"
        if paper_mode
        else f"{leg.book_key} · {format_local_time(detection.commence_time, timezone_name)}"
    )

    return AlertMessage(
        kind="ev",
        title=(
            f"⚡ +EV {detection.edge_pct:.2f}% — "
            f"{leg.book_key} {detection.market_key}"
        ),
        lines=lines,
        footer=footer,
        color=EV_COLOR,
        buttons=[
            AlertButton(f"rec:{recommendation_id}:bet", "✅ Bet placed"),
            AlertButton(f"rec:{recommendation_id}:skip", "❌ Skip"),
            AlertButton(
                f"snooze:{detection.sport_key}:{detection.market_key}", "\U0001f634 1 h"
            ),
        ],
    )


def render_arb(
    detection,
    plan: StakePlan,
    *,
    recommendation_id: str,
    paper_mode: bool,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> AlertMessage:
    """§9.2's arbitrage embed. The stale leg is always leg 1."""
    order = sorted(
        range(len(detection.legs)),
        key=lambda i: (not detection.legs[i].bet_first, i),
    )

    lines: list[str] = []
    buttons: list[AlertButton] = []
    for position, index in enumerate(order):
        leg = detection.legs[index]
        stake_leg = plan.legs[index]
        numeral = LEG_NUMERALS[position] if position < len(LEG_NUMERALS) else f"{position + 1}."
        stale = " \U0001f525 STALE —" if leg.bet_first else ""
        line = (
            f"{numeral}{stale} {leg.book_key}: {leg.selection} @ "
            f"{format_american(leg.price_decimal)} → stake "
            f"`{format_money(stake_leg.stake_cents)}`"
        )
        link = _link_line("Open", stake_leg.deep_link)
        if link:
            line += f" · {link}"
        lines.append(line)
        buttons.append(
            AlertButton(
                f"rec:{recommendation_id}:bet_leg{position + 1}",
                f"✅ Leg {position + 1} placed",
            )
        )

    first_leg = detection.legs[order[0]]
    if first_leg.staleness is not None:
        matched = getattr(detection, "leg_consensus_books", None)
        count = matched[order[1]] if matched and len(order) > 1 else None
        tail = f"leg 2 matches {count} books." if count else "leg 2 matches the field."
        lines.append(
            f"Leg 1 deviates {first_leg.staleness:.1f}σ from consensus; {tail}"
        )

    footer = (
        "PAPER"
        if paper_mode
        else format_local_time(detection.commence_time, timezone_name)
    )

    return AlertMessage(
        kind="arb",
        title=f"\U0001f500 ARB {detection.edge_pct:.2f}% — bet leg 1 first",
        lines=lines,
        footer=footer,
        color=ARB_COLOR,
        buttons=buttons,
    )


def render_alert(
    detection,
    plan: StakePlan,
    *,
    recommendation_id: str,
    paper_mode: bool,
    timezone_name: str = DEFAULT_TIMEZONE,
) -> AlertMessage:
    """Dispatch on detection type."""
    renderer = render_arb if detection.type == "arb" else render_ev
    return renderer(
        detection,
        plan,
        recommendation_id=recommendation_id,
        paper_mode=paper_mode,
        timezone_name=timezone_name,
    )

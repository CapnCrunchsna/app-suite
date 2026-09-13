"""Deep-link ladder — spec §9.4.

Assembly rule: use the highest non-null level whose placeholders can all be
filled, and record which level was chosen.

**Corrected 2026-09-12: "The Odds API returns no book-native ids" is false, and
this module said it for a week.** The provider documents `includeLinks=true` and
`includeSids=true` on `/odds` and `/events/odds`, returning `event.link`,
`market.link`, `outcome.link` — betslip-level — and `sid`, the bookmaker's own
identifier for each event, market and outcome. That is this whole ladder,
supplied by the provider already in use. The request built in
`providers/the_odds_api.py` passes neither parameter, which is the real and much
smaller fact underneath the claim.

What is **not** yet known, and must not be assumed: whether the flags cost extra
credits, whether the free tier serves them at all, and which of the ten books are
covered — the provider says only that "availability of links will depend on the
bookmaker". None of it can be tested until the quota resets in October, so the
rungs stay empty and the ladder keeps falling through to `league`. An untested
capability is not a link.

§16.3 forbids inventing a URL schema, and a plausible-looking guess is the worst
possible failure here: it sends a person to the wrong market on a real
sportsbook with money in hand. An empty link is visibly broken; a wrong one is
not.

**`event` cannot be verified from a machine, measured 2026-09-11**, which is why
`league` exists below it. Books split two ways under a plain fetch, and neither
way yields a template:

- DraftKings, FanDuel and bet365 answer any non-browser client with 403.
- The rest serve a client-rendered shell with no links in the HTML, and some —
  Caesars measured — return 200 with an identical title for *every* path,
  `/us/md/bet/this-path-does-not-exist` included. A 200 there is not evidence,
  and reading it as evidence would manufacture precisely the confident-but-wrong
  template §16.3 exists to prevent.

Probing a known-bad path first tells you which kind of host you have: betPARX
and Fanatics 404 nonsense, so a 200 on a candidate means the path routes. Even
then "the path routes" is a weaker claim than "the page shows this market",
which is the one the ladder rests on and only a rendered page can support. So
every rung above `book_home` is a value a **person** supplies through the
Sportsbooks page's link editor, having looked at it.
"""

from __future__ import annotations

from typing import Any

#: Highest to lowest, per §9.4.
#:
#: `league` (2026-09-11) is one sport's landing page at a book — the MLB page
#: rather than the front door with a casino carousel on it. `market` (2026-09-12)
#: exists because the provider returns that level for some books and it is a real
#: rung between a betslip and a whole event page; only theScore Bet supplied one
#: in the first sample, and inventing a name for it would have been worse than
#: naming what arrived.
LINK_LEVELS = ("betslip", "market", "event", "league", "book_home")

#: Which provider field feeds which rung. The provider's own hierarchy is
#: outcome → market → event, and §9.4's names for those are betslip → market →
#: event, so this is the whole of the translation.
PROVIDER_FIELDS = (
    ("outcome_link", "betslip"),
    ("market_link", "market"),
    ("event_link", "event"),
)

#: Not one of §9.4's rungs — it is the honest state below all of them, for a book
#: whose templates have not been verified yet. Callers must render it as
#: "no link", never fall back to a guessed URL.
NO_LINK = "none"


def build_deep_link(
    link_templates: dict[str, Any] | None,
    placeholders: dict[str, Any],
    provider_links: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """Return ``(url, link_level)`` for one leg.

    **The provider is tried first, rung by rung, before any stored template.**
    Not a preference for freshness: a provider link is keyed to *this* event and
    outcome, while a stored template is a human's generalisation that was true
    when they wrote it. Where both exist the provider's is the one that cannot
    have gone stale against a book's URL scheme.

    Provider links go through the same ``.format()`` as templates, because some
    of them *are* templates — BetMGM and betPARX return a literal ``{state}``.

    Falls through to ``("", "none")`` when nothing survives, which stays the
    correct output for a book the provider does not cover and nobody has filled
    in by hand.
    """
    for field, level in PROVIDER_FIELDS:
        url = _fill((provider_links or {}).get(field), placeholders)
        if url is not None:
            return url, level

    templates = link_templates or {}
    for level in LINK_LEVELS:
        url = _fill(templates.get(level), placeholders)
        if url is not None:
            return url, level

    return "", NO_LINK


def _fill(template: Any, placeholders: dict[str, Any]) -> str | None:
    """A usable URL, or `None` to drop to the next rung.

    `ValueError` is in the catch list for provider links specifically: those are
    arbitrary third-party URLs, and a stray brace in one would otherwise raise
    out of a format string and take down the cycle. A rung we cannot fill is a
    rung we skip — never a URL with a hole in it, and never an exception.
    """
    if not template or not isinstance(template, str):
        return None
    try:
        return template.format(**placeholders)
    except (KeyError, IndexError, ValueError):
        return None


def has_verified_link(link_level: str) -> bool:
    """Whether a leg's link can actually be handed to a person."""
    return link_level in LINK_LEVELS

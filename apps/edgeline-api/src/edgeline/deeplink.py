"""Deep-link ladder — spec §9.4.

Assembly rule: use the highest non-null level whose placeholders can all be
filled, and record which level was chosen.

**v1 reality, and it is a hard boundary rather than an omission.** The Odds API
returns no book-native ids, so `betslip` is null for every book. The rungs below
it have to be verified by hand, book by book — that is task T4.3.

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

#: Highest to lowest, per §9.4. `league` was added 2026-09-11 between `event`
#: and `book_home`: one sport's landing page at a book — the MLB page rather
#: than the front door with a casino carousel on it. It is the highest rung a
#: person can actually confirm today, and it carries no placeholders while
#: `sports_enabled` holds one sport.
LINK_LEVELS = ("betslip", "event", "league", "book_home")

#: Not one of §9.4's rungs — it is the honest state below all of them, for a book
#: whose templates have not been verified yet. Callers must render it as
#: "no link", never fall back to a guessed URL.
NO_LINK = "none"


def build_deep_link(
    link_templates: dict[str, Any] | None,
    placeholders: dict[str, Any],
) -> tuple[str, str]:
    """Return ``(url, link_level)`` for one leg.

    Falls all the way through to ``("", "none")`` when no template survives —
    which is every book today.
    """
    templates = link_templates or {}

    for level in LINK_LEVELS:
        template = templates.get(level)
        if not template or not isinstance(template, str):
            continue
        try:
            url = template.format(**placeholders)
        except (KeyError, IndexError):
            # A template whose placeholders we cannot fill is not usable; drop to
            # the next rung rather than emitting a URL with a hole in it.
            continue
        return url, level

    return "", NO_LINK


def has_verified_link(link_level: str) -> bool:
    """Whether a leg's link can actually be handed to a person."""
    return link_level in LINK_LEVELS

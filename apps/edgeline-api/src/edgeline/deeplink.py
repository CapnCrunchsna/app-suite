"""Deep-link ladder — spec §9.4.

Assembly rule: use the highest non-null level whose placeholders can all be
filled, and record which level was chosen.

**v1 reality, and it is a hard boundary rather than an omission.** The Odds API
returns no book-native ids, so `betslip` is null for every book. `event` and
`book_home` templates have to be verified by hand, book by book (open the site,
copy a real event URL, generalise it) — that is task T4.3. Until then
`edgeline-sportsbooks` ships `link_templates: {}` for every book, on purpose.

So this module will return no link at all for now, and that is the correct
output. §16.3 forbids inventing a URL schema, and a plausible-looking guess is
the worst possible failure here: it sends a person to the wrong market on a real
sportsbook with money in hand. An empty link is visibly broken; a wrong one is
not.
"""

from __future__ import annotations

from typing import Any

#: Highest to lowest, per §9.4.
LINK_LEVELS = ("betslip", "event", "book_home")

#: Not one of §9.4's three levels — it is the honest fourth state for a book
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

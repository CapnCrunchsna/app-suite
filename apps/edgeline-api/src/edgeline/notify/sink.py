"""Where a rendered alert goes — the one seam a channel plugs into.

`AlertSink` is deliberately one method. Everything channel-specific (Discord's
embeds and persistent views, Telegram's inline keyboards, a webhook's JSON body)
lives behind it, and the pipeline never learns which one it is talking to.

`send` returns a `message_ref` — whatever handle the channel gives back for the
message it posted. §4.3 stores that on the recommendation so §9.3's interaction
handlers can find their way back to the row a tap belongs to.
"""

from __future__ import annotations

import logging
import uuid
from typing import Protocol

from .message import AlertMessage

log = logging.getLogger(__name__)


class AlertSink(Protocol):
    """A channel that can deliver an `AlertMessage`."""

    name: str

    async def send(self, message: AlertMessage, *, recommendation_id: str) -> str | None:
        """Deliver the message; return a channel-specific reference, or None."""
        ...


class LogSink:
    """Writes alerts to the log. The stand-in until a real channel exists.

    Not a placeholder to be tolerated: while `paper_mode` is on and nobody is
    placing anything, a logged alert carries the same information as a delivered
    one, and it lets Phase 1's "seven consecutive days of paper recommendations"
    accumulate with fully rendered messages rather than waiting on a token.
    """

    name = "log"

    def __init__(self, logger: logging.Logger | None = None) -> None:
        self._log = logger or log

    async def send(self, message: AlertMessage, *, recommendation_id: str) -> str:
        self._log.info("ALERT %s\n%s", recommendation_id, message.to_text())
        return f"log:{uuid.uuid4().hex[:12]}"


class RecordingSink:
    """Keeps messages in memory. For tests, and for `--once` to print."""

    name = "recording"

    def __init__(self) -> None:
        self.sent: list[tuple[str, AlertMessage]] = []

    async def send(self, message: AlertMessage, *, recommendation_id: str) -> str:
        self.sent.append((recommendation_id, message))
        return f"recorded:{len(self.sent)}"


class NullSink:
    """Delivers nothing. What the kill switch and `paper_mode` audits want."""

    name = "null"

    async def send(self, message: AlertMessage, *, recommendation_id: str) -> None:
        return None

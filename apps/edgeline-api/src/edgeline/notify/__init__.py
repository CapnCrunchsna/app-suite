"""Alert dispatch.

Split deliberately into a channel-neutral half and (later) per-channel adapters.
`message.py` renders §9.2's formats into an `AlertMessage`; `sink.py` defines the
one-method protocol a channel implements. Discord (§9) is the spec's channel and
is not yet built — it needs a bot token that does not exist yet — so `LogSink`
stands in and the seven days of paper recommendations Phase 1's exit wants can
accumulate with realistic messages in the meantime.

The point of the split: whichever channel eventually lands, it is an adapter over
`AlertMessage`, not a rewrite of the pipeline.
"""

from __future__ import annotations

from .message import AlertButton, AlertMessage, render_alert, render_arb, render_ev
from .sink import AlertSink, LogSink, NullSink, RecordingSink

__all__ = [
    "AlertButton",
    "AlertMessage",
    "AlertSink",
    "LogSink",
    "NullSink",
    "RecordingSink",
    "render_alert",
    "render_arb",
    "render_ev",
]

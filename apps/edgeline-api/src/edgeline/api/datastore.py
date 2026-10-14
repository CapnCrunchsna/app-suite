"""Telling "the datastore is down" apart from "the datastore has nothing" — §10.

Added 2026-10-13, after Docker Desktop failed to start and took Elasticsearch
with it. The API stayed up, and every page went wrong in two ways at once:

- **Slowly.** A refused connection to a closed port on Windows takes ~2.0 s, and
  the client tries four times, so each Elasticsearch call cost 8.1 s before it
  failed (measured that day against a closed port). `/api/system/health` makes
  four of them in a row, so the dashboard's first paint waited half a minute.
- **Wrongly.** The display helpers in `deps` answer an empty table or §3.2's
  defaults for *any* failure, so after the wait the dashboard rendered "0 books
  enabled" and "worker never seen" — a picture of an unconfigured install,
  painted over an outage — with no error anywhere.

This module fixes both. `gate` is a TCP probe in front of every route,
answering in at most `PROBE_TIMEOUT_S` and remembering the answer briefly, so a
down cluster costs one fast probe instead of 8 s per call. And a datastore that
cannot answer — unreachable, or a 503 while shards recover after a start — is a
**503 with `detail.code == "datastore_unavailable"`** from every route, which is
what the UI keys its "start Docker" banner on. The lenient helpers still answer
empties for everything else (a missing index on a part-bootstrapped install),
because that is still a true answer.

The probe is the API's alone. The worker keeps the client's own retries, which
are what carry it across a laptop sleep (`es.get_client`).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from contextlib import suppress
from typing import Literal
from urllib.parse import urlsplit

from elastic_transport import ConnectionError as TransportConnectionError
from elastic_transport import ConnectionTimeout
from elasticsearch import ApiError
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..config import es_url

log = logging.getLogger(__name__)

#: `detail.code` on every 503 this module produces. The UI matches on it.
DATASTORE_UNAVAILABLE = "datastore_unavailable"

Reason = Literal["unreachable", "recovering"]

#: A local cluster accepts a connection in well under a millisecond, so half a
#: second is only ever spent on a port nobody is listening on.
PROBE_TIMEOUT_S = 0.5
#: How long an answer is trusted. "Up" for longer, because a request that finds
#: it wrong fails anyway and marks the gate down; "down" briefly, so the first
#: request after `es-up` sees the cluster within a couple of seconds.
UP_TTL_S = 5.0
DOWN_TTL_S = 2.0

_MESSAGES: dict[Reason, str] = {
    "unreachable": (
        "Elasticsearch is not reachable. It runs in Docker: `nx run edgeline-api:es-up` "
        "starts Docker Desktop if needed, then the cluster."
    ),
    "recovering": (
        "Elasticsearch is up but still recovering its shards after a start. "
        "This clears by itself within a minute or so."
    ),
}


class DatastoreUnavailable(Exception):
    """Raised where a route would otherwise have answered an empty or a default."""

    def __init__(self, reason: Reason):
        super().__init__(reason)
        self.reason: Reason = reason


def unavailable_reason(exc: BaseException) -> Reason | None:
    """Why `exc` means the datastore cannot answer, or `None` if it does not.

    The client's two roots, as `routers.settings` names them: no answer at all
    (a refused connection, a timeout that outlived the retries) and an error
    answer. Only a **503** error answer counts — that is the cluster saying its
    shards are not ready (a red cluster right after `es-up`), whereas a 404 is a
    real answer about one index and stays the caller's to interpret.
    """
    if isinstance(exc, DatastoreUnavailable):
        return exc.reason
    if isinstance(exc, (TransportConnectionError, ConnectionTimeout)):
        return "unreachable"
    if isinstance(exc, ApiError) and getattr(exc.meta, "status", None) == 503:
        return "recovering"
    return None


def raise_if_unavailable(exc: BaseException) -> None:
    """For a lenient `except Exception`: let an outage through, keep the rest."""
    reason = unavailable_reason(exc)
    if reason is None:
        return
    if reason == "unreachable":
        gate.mark_down()
    raise DatastoreUnavailable(reason) from exc


class ReachabilityGate:
    """A remembered TCP probe of `ES_URL`.

    A probe and not a `ping`: the client's ping goes through the same four
    attempts at ~2 s each that this exists to avoid. Concurrent requests share
    one probe — the dashboard fires five at once.
    """

    def __init__(
        self,
        url: Callable[[], str] = es_url,
        *,
        timeout: float = PROBE_TIMEOUT_S,
        up_ttl: float = UP_TTL_S,
        down_ttl: float = DOWN_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._url = url
        self._timeout = timeout
        self._up_ttl = up_ttl
        self._down_ttl = down_ttl
        self._clock = clock
        self._reachable: bool | None = None
        self._checked_at = 0.0
        self._lock = asyncio.Lock()

    async def check(self) -> None:
        if not await self.reachable():
            raise DatastoreUnavailable("unreachable")

    async def reachable(self) -> bool:
        if self._fresh():
            return bool(self._reachable)
        async with self._lock:
            if not self._fresh():
                self._reachable = await self._probe()
                self._checked_at = self._clock()
            return bool(self._reachable)

    def mark_down(self) -> None:
        """A real request just failed to connect: believe it over the last probe."""
        self._reachable = False
        self._checked_at = self._clock()

    def _fresh(self) -> bool:
        if self._reachable is None:
            return False
        ttl = self._up_ttl if self._reachable else self._down_ttl
        return self._clock() - self._checked_at < ttl

    async def _probe(self) -> bool:
        parts = urlsplit(self._url())
        host = parts.hostname or "localhost"
        port = parts.port or (443 if parts.scheme == "https" else 9200)
        try:
            # Happy eyeballs, because `localhost` resolves to `::1` first here and
            # the compose file binds `127.0.0.1` only: tried in turn, the refused
            # IPv6 attempt alone would spend the whole timeout and read as down.
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port, happy_eyeballs_delay=0.05),
                self._timeout,
            )
        except (OSError, TimeoutError):
            return False
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()
        return True


#: The process-wide gate `deps.get_context` consults.
gate = ReachabilityGate()


def unavailable_response(reason: Reason) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "detail": {
                "code": DATASTORE_UNAVAILABLE,
                "reason": reason,
                "message": _MESSAGES[reason],
            }
        },
    )


def install(app: FastAPI) -> None:
    """Answer every datastore outage, from any route, as the one 503 shape."""

    async def handle(request: Request, exc: Exception):
        reason = unavailable_reason(exc)
        if reason is None:
            # An `ApiError` that is not a 503 — a mapping conflict, a bad query.
            # Not an outage; let it be the 500 it was before this handler.
            raise exc
        if reason == "unreachable":
            gate.mark_down()
        log.warning(
            "%s %s: datastore %s (%s)",
            request.method,
            request.url.path,
            reason,
            type(exc.__cause__ or exc).__name__,
        )
        return unavailable_response(reason)

    for kind in (DatastoreUnavailable, TransportConnectionError, ConnectionTimeout, ApiError):
        app.add_exception_handler(kind, handle)

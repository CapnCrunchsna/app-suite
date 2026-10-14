"""A datastore outage is a fast, named 503 — `edgeline.api.datastore`, 2026-10-13.

No cluster anywhere in this file: the outage is the thing under test, so every
datastore here is a stand-in that fails the way a down one does.
"""

from __future__ import annotations

import asyncio
import socket
import time

import httpx
import pytest

from edgeline.api import datastore
from edgeline.api.datastore import DATASTORE_UNAVAILABLE, ReachabilityGate


@pytest.fixture(autouse=True)
def _fresh_gate(monkeypatch):
    """A failed request marks the process-wide gate down; keep that per test."""
    monkeypatch.setattr(datastore, "gate", ReachabilityGate())


def _closed_port() -> int:
    """A loopback port that was free a moment ago and has nothing listening."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Meta:
    """Just enough of `ApiResponseMeta` for `ApiError.__str__`."""

    def __init__(self, status: int):
        self.status = status


class _Down:
    """A client every call to which fails with `exc`, recording what was tried."""

    def __init__(self, exc: Exception):
        self.exc = exc
        self.calls: list[str] = []

    def __getattr__(self, name):
        async def fail(**_kwargs):
            self.calls.append(name)
            raise self.exc

        return fail


def _app(client):
    from edgeline.api.deps import Context, get_context
    from edgeline.api.main import create_app

    app = create_app()
    app.dependency_overrides[get_context] = lambda: Context(client=client, prefix="edgeline-")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _refused():
    from elastic_transport import ConnectionError

    return ConnectionError("Cannot connect to host localhost:9200")


async def test_a_refused_probe_answers_inside_its_timeout():
    """The point of the gate. The client itself took 8.1 s to fail here — four
    attempts at the ~2 s Windows spends on a refused loopback connect."""
    gate = ReachabilityGate(lambda: f"http://localhost:{_closed_port()}")

    started = time.perf_counter()
    assert await gate.reachable() is False
    assert time.perf_counter() - started < 1.0


async def test_a_listening_cluster_probes_as_reachable_by_name():
    """By `localhost`, which resolves to `::1` first here while the compose file
    binds `127.0.0.1` only — the probe must not spend its timeout on the wrong one."""
    server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        assert await ReachabilityGate(lambda: f"http://localhost:{port}").reachable() is True
    finally:
        server.close()
        await server.wait_closed()


async def test_the_gate_remembers_briefly_and_believes_a_failed_request():
    now = [0.0]
    probes: list[float] = []

    class Counted(ReachabilityGate):
        async def _probe(self):
            probes.append(now[0])
            return True

    gate = Counted(clock=lambda: now[0], up_ttl=5.0, down_ttl=2.0)

    assert await gate.reachable() and await gate.reachable()
    assert len(probes) == 1  # concurrent and repeated requests share one probe

    gate.mark_down()  # a real request just failed to connect
    assert await gate.reachable() is False
    assert len(probes) == 1

    now[0] += 2.5  # past the down TTL: look again
    assert await gate.reachable() is True
    assert len(probes) == 2


async def test_health_against_an_unreachable_cluster_is_a_named_503_not_defaults():
    """What the dashboard got on 2026-10-13 was a 200 of §3.2's defaults — "0
    books enabled", "worker never seen" — half a minute late."""
    async with _app(_Down(_refused())) as http:
        response = await http.get("/api/system/health")

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == DATASTORE_UNAVAILABLE
    assert detail["reason"] == "unreachable"
    assert "Docker" in detail["message"]


@pytest.mark.parametrize(
    "path",
    ["/api/settings", "/api/sportsbooks", "/api/opportunities", "/api/recommendations"],
)
async def test_every_display_route_says_so_rather_than_rendering_an_empty_table(path):
    async with _app(_Down(_refused())) as http:
        response = await http.get(path)

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == DATASTORE_UNAVAILABLE


async def test_a_cluster_recovering_its_shards_is_named_as_that():
    """A red cluster right after `es-up` answers 503s of its own. That is the
    same outage to a reader, with a different thing to do about it: wait."""
    from elasticsearch import ApiError

    recovering = ApiError("no_shard_available_action_exception", _Meta(503), None)
    async with _app(_Down(recovering)) as http:
        response = await http.get("/api/system/health")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "recovering"


async def test_a_missing_settings_index_still_answers_defaults():
    """The lenient loader's real job is unchanged: a part-bootstrapped install
    has no document, and that is an answer, not an outage."""
    from elasticsearch import NotFoundError

    async with _app(_Down(NotFoundError("index_not_found_exception", _Meta(404), None))) as http:
        response = await http.get("/api/settings")

    assert response.status_code == 200
    assert response.json()["paper_mode"] is True


async def test_a_write_against_a_down_cluster_is_not_a_404():
    """Three routes read any failure as "not found". A sportsbook toggle pressed
    during an outage said the book did not exist."""
    async with _app(_Down(_refused())) as http:
        response = await http.patch("/api/sportsbooks/draftkings", json={"enabled": True})

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == DATASTORE_UNAVAILABLE


async def test_the_live_context_refuses_before_any_request_is_made(monkeypatch):
    """No override this time: the real `get_context`, with the gate pointed at a
    closed port. The route must not start the client's own 8-second search."""
    from edgeline.api.main import create_app

    monkeypatch.setattr(
        datastore, "gate", ReachabilityGate(lambda: f"http://localhost:{_closed_port()}")
    )
    app = create_app()

    started = time.perf_counter()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as http:
        response = await http.get("/api/system/health")

    assert response.status_code == 503
    assert response.json()["detail"]["reason"] == "unreachable"
    assert time.perf_counter() - started < 1.5

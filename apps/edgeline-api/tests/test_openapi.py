"""The committed OpenAPI document — spec §11.3.

`openapi.json` is committed because it is the input the TypeScript client is
generated from, so it is the contract between this app and the UI. A drifted copy
would mean the generated client describes an API that no longer exists, and
nothing would say so until something failed at runtime in the browser.

This test is the thing that stops that: it regenerates the document in memory and
compares. It needs no server and no datastore.
"""

from __future__ import annotations

from edgeline.api.openapi import OPENAPI_PATH, document, render

REGENERATE = "cd apps/edgeline-api && uv run python -m edgeline.api.openapi"


def test_the_committed_openapi_document_is_current():
    assert OPENAPI_PATH.exists(), f"{OPENAPI_PATH} is missing. Run: {REGENERATE}"
    assert OPENAPI_PATH.read_text(encoding="utf-8") == render(document()), (
        f"{OPENAPI_PATH} is stale — the API changed but the contract was not "
        f"regenerated.\n  {REGENERATE}\n"
        "then: npx nx run edgeline-api-client:generate-client"
    )


def test_every_operation_has_an_explicit_id():
    """The generator refuses to invent names, so a missing `operation_id` is an
    error here rather than an ugly method name in the client."""
    paths = document()["paths"]
    missing = [
        f"{method.upper()} {path}"
        for path, item in paths.items()
        for method, operation in item.items()
        if "operationId" not in operation
    ]
    assert not missing, f"routes without an explicit operation_id: {missing}"


def test_operation_ids_are_unique():
    ids = [
        operation["operationId"]
        for item in document()["paths"].values()
        for operation in item.values()
    ]
    assert len(ids) == len(set(ids)), "duplicate operationId would collide in the client"


def test_the_openapi_document_covers_every_section_10_route():
    """A route that exists but is not published cannot be called from the UI."""
    paths = set(document()["paths"])
    for expected in [
        "/api/settings",
        "/api/providers",
        "/api/sportsbooks",
        "/api/opportunities",
        "/api/recommendations",
        "/api/results/summary",
        "/api/bankroll",
        "/api/matching",
        "/api/system/health",
        "/api/system/kill",
        "/api/system/resume",
    ]:
        assert expected in paths, f"{expected} is missing from the published contract"

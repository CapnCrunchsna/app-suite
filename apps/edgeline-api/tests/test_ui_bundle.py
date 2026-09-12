"""§10's "FastAPI serves the built Angular bundle at `/`".

Nothing here needs a datastore: the bug this file exists for was a path constant,
and it survived every ES-backed test in the suite because none of them look at
the filesystem.

**It had never worked.** `DEFAULT_UI_BUNDLE` pointed at
`apps/edgeline-ui/dist/edgeline-ui/browser`, an app-relative guess, while Nx
writes the bundle to `dist/apps/edgeline-ui/browser` from the workspace root.
`_mount_ui` checks `is_dir()`, finds nothing, logs at INFO and returns — so the
API came up healthy, `/api/*` answered, and every UI route returned
`{"detail":"Not Found"}`. That reads as a broken Angular route, which is where
the time goes.

So the constant is pinned against the build's own `project.json` rather than
re-typed here. A rename of `outputPath` fails this test with the new path in the
message, which is the only way the two stay in step.
"""

from __future__ import annotations

import json

import httpx
import pytest

from edgeline.api.main import DEFAULT_UI_BUNDLE, WORKSPACE_ROOT, UI_BUNDLE_ENV, create_app

UI_PROJECT = WORKSPACE_ROOT / "apps" / "edgeline-ui" / "project.json"


def _configured_output_path() -> str:
    config = json.loads(UI_PROJECT.read_text(encoding="utf-8"))
    return config["targets"]["build"]["options"]["outputPath"]


def test_workspace_root_is_the_workspace_root():
    """The anchor everything below resolves against."""
    assert (WORKSPACE_ROOT / "nx.json").is_file()
    assert (WORKSPACE_ROOT / "apps" / "edgeline-api").is_dir()


def test_default_ui_bundle_matches_the_build_output():
    """The pin. `browser` is the Angular application builder's own subdirectory
    under `outputPath`, and `serve-static` in the same `project.json` spells the
    full path out the same way."""
    expected = WORKSPACE_ROOT / _configured_output_path() / "browser"
    assert DEFAULT_UI_BUNDLE == expected


def test_the_static_serve_target_agrees_with_us():
    """A third copy of the path exists in `project.json`, so it gets checked too
    rather than left to drift on its own."""
    config = json.loads(UI_PROJECT.read_text(encoding="utf-8"))
    static_path = config["targets"]["serve-static"]["options"]["staticFilePath"]
    assert WORKSPACE_ROOT / static_path == DEFAULT_UI_BUNDLE


@pytest.fixture
def served(tmp_path, monkeypatch):
    """The app with a one-file bundle behind it. No cluster: httpx's ASGI
    transport sends no lifespan events, so nothing bootstraps indices here."""
    (tmp_path / "index.html").write_text("<!doctype html><title>bundle</title>", "utf-8")
    (tmp_path / "main-abc123.js").write_text("// asset", "utf-8")
    monkeypatch.setenv(UI_BUNDLE_ENV, str(tmp_path))
    app = create_app()
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    )


async def test_an_angular_route_gets_the_bundle_not_a_404(served):
    """The symptom that started this: `/` worked and every real page 404'd."""
    async with served as http:
        for path in ("/sportsbooks", "/settings", "/opportunities"):
            response = await http.get(path)
            assert response.status_code == 200, path
            assert "<title>bundle</title>" in response.text, path


async def test_a_real_asset_is_served_as_itself(served):
    async with served as http:
        response = await http.get("/main-abc123.js")
        assert response.status_code == 200
        assert response.text == "// asset"


async def test_javascript_is_served_as_javascript(served):
    """Not pedantry — it is the difference between the app running and a blank
    page. `mimetypes` seeds from the Windows registry, which maps `.js` to
    `text/plain` on this machine, and a browser refuses an ES module served that
    way. Everything else looks healthy: 200 in the network tab, nothing in the
    server log. Asserted through a real response rather than against
    `mimetypes.guess_type`, so it fails if the registration ever stops being
    applied at the point it matters."""
    async with served as http:
        response = await http.get("/main-abc123.js")
        assert response.headers["content-type"].startswith(
            ("text/javascript", "application/javascript")
        )


async def test_an_unknown_api_path_stays_a_json_404(served):
    """The fallback must not swallow these. It did on Windows only, because
    Starlette hands `get_response` an OS-separated path and the guard compared
    against `api/` — so a caller got 200 and a page of HTML where it expected a
    404 and a JSON body."""
    async with served as http:
        response = await http.get("/api/no-such-route")
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/json")

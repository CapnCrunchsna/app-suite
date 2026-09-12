"""FastAPI application — spec §10. `nx run edgeline-api:serve`.

All routes live under `/api`, OpenAPI is published at `/api/openapi.json` (which
feeds §11.3's generated TypeScript client), and in production the built Angular
bundle is served as static files at `/`.

The app binds to localhost only, like Elasticsearch does (§4.1). Security is off
across this stack precisely because nothing in it is reachable off this machine;
that stops being true the moment it moves to the home server, and §4.1 says what
has to happen first.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from ..config import PROJECT_ROOT
from .routers import (
    bankroll,
    matching,
    opportunities,
    providers,
    recommendations,
    results,
    settings,
    sportsbooks,
    system,
)

log = logging.getLogger(__name__)

#: Where `nx build edgeline-ui` puts the bundle. Absent in dev, and that is fine.
#:
#: **Workspace-relative, not app-relative** — `outputPath` in that project's
#: `project.json` is `dist/apps/edgeline-ui`, resolved from the workspace root
#: like every other Nx output. This pointed at `apps/edgeline-ui/dist/...` until
#: 2026-09-12, so §10's "FastAPI serves the bundle at `/`" had never once
#: happened: `is_dir()` was false, the mount was skipped, and the only symptom
#: was `{"detail":"Not Found"}` on every UI route — which reads as a routing bug
#: in the app rather than as a missing mount. `test_default_ui_bundle_matches_the_build_output`
#: now pins this against `project.json` so the two cannot drift apart again.
UI_BUNDLE_ENV = "EDGELINE_UI_DIST"
WORKSPACE_ROOT = PROJECT_ROOT.parents[1]
DEFAULT_UI_BUNDLE = WORKSPACE_ROOT / "dist" / "apps" / "edgeline-ui" / "browser"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Bootstrap indices at startup (§4.2), and close the client on the way out."""
    from ..es import close_client, ensure_indices, get_client

    try:
        report = await ensure_indices(get_client())
        if report.changed:
            log.info(
                "bootstrap: created %d index/indices, seeded %d document(s)",
                len(report.created_indices),
                len(report.seeded_documents),
            )
    except Exception:
        # The API is still useful read-only against an existing cluster, and
        # failing to boot because the datastore is briefly down would be worse
        # than starting and reporting it through /api/system/health.
        log.exception("index bootstrap failed; continuing")
    yield
    await close_client()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Edgeline API",
        version="0.1.0",
        summary="Sports betting intelligence. Recommends bets; never places them.",
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    for router in (
        settings.router,
        providers.router,
        sportsbooks.router,
        opportunities.router,
        recommendations.router,
        results.router,
        bankroll.router,
        matching.router,
        system.router,
    ):
        app.include_router(router, prefix="/api")

    _mount_ui(app)
    return app


def _spa_files(directory: str):
    """`StaticFiles`, plus the fallback an Angular router actually needs.

    `html=True` alone does **not** do this, despite what the comment here used to
    claim. It serves `index.html` for a *directory* request — `/` — and answers a
    404 for any other unmatched path, so `/sportsbooks` was a 404 while `/` was
    fine. Angular's routes exist only once the bundle is running in the browser,
    so an unmatched path is a route to hand over, not a missing file.

    `/api/*` is excluded from the fallback. Those paths are matched by the
    routers first and only reach here when they match nothing, and answering a
    mistyped API path with a page of HTML would turn "no such route" into a
    parse error at the caller.

    The separators in `path` are the **host OS's**: Starlette builds it with
    `os.path.join`, so this is `api\\thing` on Windows and `api/thing` elsewhere.
    A plain `startswith("api/")` therefore passes every API path straight into
    the fallback on Windows only — which is where this is developed.
    """
    import mimetypes

    from fastapi.staticfiles import StaticFiles
    from starlette.exceptions import HTTPException as StarletteHTTPException

    # `mimetypes` seeds itself from the **Windows registry**, where `.js` is
    # `text/plain` on this machine. Starlette asks `mimetypes` for every file it
    # serves, so the whole bundle came back as text/plain, and a browser refuses
    # an ES module with that type outright ("Strict MIME type checking is
    # enforced for module scripts"). The page then renders blank with a console
    # error and a 200 in the network tab — nothing in the server log is wrong at
    # all. `.css` happens to be correct in the same registry, which is why the
    # styles loaded and only the app was missing.
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/javascript", ".mjs")
    mimetypes.add_type("application/json", ".json")
    mimetypes.add_type("image/svg+xml", ".svg")

    class SpaFiles(StaticFiles):
        async def get_response(self, path: str, scope):
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as exc:
                requested = path.replace("\\", "/").lstrip("/")
                if exc.status_code != 404 or requested.startswith("api/"):
                    raise
                return await super().get_response("index.html", scope)

    return SpaFiles(directory=directory, html=True)


def _mount_ui(app: FastAPI) -> None:
    """Serve the Angular bundle at `/` when one has been built (§10)."""
    configured = os.environ.get(UI_BUNDLE_ENV)
    bundle = Path(configured) if configured else DEFAULT_UI_BUNDLE
    if not bundle.is_dir():
        log.info("no UI bundle at %s; serving the API only", bundle)
        return
    app.mount("/", _spa_files(str(bundle)), name="ui")
    log.info("serving UI bundle from %s", bundle)


app = create_app()

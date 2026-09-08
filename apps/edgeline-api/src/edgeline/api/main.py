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
UI_BUNDLE_ENV = "EDGELINE_UI_DIST"
DEFAULT_UI_BUNDLE = PROJECT_ROOT.parent / "edgeline-ui" / "dist" / "edgeline-ui" / "browser"


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


def _mount_ui(app: FastAPI) -> None:
    """Serve the Angular bundle at `/` when one has been built (§10)."""
    from fastapi.staticfiles import StaticFiles

    configured = os.environ.get(UI_BUNDLE_ENV)
    bundle = Path(configured) if configured else DEFAULT_UI_BUNDLE
    if not bundle.is_dir():
        log.info("no UI bundle at %s; serving the API only", bundle)
        return
    # html=True makes unknown paths fall back to index.html, which is what an
    # Angular router needs for deep links to survive a page refresh.
    app.mount("/", StaticFiles(directory=str(bundle), html=True), name="ui")
    log.info("serving UI bundle from %s", bundle)


app = create_app()

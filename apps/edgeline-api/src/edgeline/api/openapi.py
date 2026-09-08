"""Write `openapi.json` from the app, without running a server.

    uv run python -m edgeline.api.openapi           # write
    uv run python -m edgeline.api.openapi --check   # fail if the committed file is stale

§11.3 says the client is generated "from the running engine's /api/openapi.json".
Taking the document straight from the app object instead is the same document —
FastAPI serves exactly what `app.openapi()` returns — but it needs no port, no
datastore and no timing, which is what makes regeneration reproducible in a check
that has to pass on a machine with nothing running.

The file is committed so the TypeScript emitter has a stable input and so an API
change shows up as a reviewable diff of the contract, not just of Python.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from ..config import PROJECT_ROOT

OPENAPI_PATH = PROJECT_ROOT / "openapi.json"


def document() -> dict:
    """The OpenAPI document exactly as the app would serve it."""
    from .main import create_app

    return create_app().openapi()


def render(doc: dict) -> str:
    # Two spaces, no key sorting, trailing newline: FastAPI emits routes in
    # registration order, which is stable, so preserving it keeps the diff of an
    # added endpoint local instead of reshuffling the file.
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    rendered = render(document())

    if "--check" in argv:
        if not OPENAPI_PATH.exists():
            print(f"missing {OPENAPI_PATH}; run: uv run python -m edgeline.api.openapi")
            return 1
        if OPENAPI_PATH.read_text(encoding="utf-8") != rendered:
            print(
                f"{OPENAPI_PATH} is stale. Regenerate with:\n"
                "    uv run python -m edgeline.api.openapi\n"
                "then regenerate the TypeScript client:\n"
                "    npx nx run edgeline-api-client:generate-client"
            )
            return 1
        print(f"{OPENAPI_PATH} is up to date")
        return 0

    OPENAPI_PATH.write_text(rendered, encoding="utf-8")
    print(f"wrote {OPENAPI_PATH} ({len(rendered)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

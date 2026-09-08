"""FastAPI JSON API — spec §10. Consumed by the Angular UI (§11).

Pure JSON (§1): no server-side HTML rendering. The one non-JSON thing this app
serves is the built Angular bundle as static files in production.

Nothing here places a bet (§16.1). `POST /recommendations/{id}/confirm` records
that a *human* placed one — it is a bookkeeping entry after the fact, and the
distinction is the whole architecture.
"""

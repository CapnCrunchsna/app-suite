# App Suite — Nx Monorepo

Child of `../CLAUDE.md` (inherits the artifact system, **Elasticsearch-first** datastore
preference, and branding). This folder is the **Nx monorepo** that houses all Angular/TypeScript
UIs and Ionic/Capacitor mobile apps, with polyglot backends (Python) wired via Nx `run-commands`.

Initialize here with `npx create-nx-workspace@latest` (Angular preset), then generate apps/libs
inside it.

## Projects that live here
- **Ledgerline** — Angular UI + Node/TS Fastify API bound to `127.0.0.1`; local statement
  analyzer. **This app bootstraps the workspace.** On-disk store is **SQLite** via
  `better-sqlite3` behind a repository layer — the documented ES exception for a single-user
  local desktop app, with an Elasticsearch re-index planned for the home server. Spec:
  `docs/ledgerline-spec.md`.
- **Meal Planner** — Ionic + Capacitor (Android-first) + PWA; local-first **SQLite on device**
  (the ES exception for local-first mobile; keep the data model sync-friendly).
- **Photo-to-Calendar** — Ionic + Capacitor (Android); Claude vision API (Haiku); Android
  CalendarProvider.
- **Edgeline** — Angular UI + Python API/jobs; server datastore **Elasticsearch** (revisit the
  existing Postgres implementation spec before build).

## Stack defaults (inherited, restated)
- UI: Angular + TypeScript; shared `ui`, generated `api-client`.
- Server datastore: Elasticsearch. On-device mobile data: SQLite.
- Backends serve pure JSON APIs; UIs consume generated TypeScript clients.

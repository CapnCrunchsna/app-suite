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

## Cross-project conventions
- A shared `ui` library and a generated `api-client` library.
- Backends serve pure JSON APIs; UIs consume generated TypeScript clients.

## Worktrees: never `npm install` in one

A worktree under `.claude/worktrees/` shares the root `node_modules` for free — it sits inside
the repo, so Node's resolver walks up and finds it. `npm install` there would read the
`workspaces` field, treat the worktree as its own install root, and re-materialize half a
gigabyte.

The one thing a worktree does *not* inherit is npm's links to this workspace's **own** packages:
`node_modules/@metrum/*` hold absolute paths into the main checkout, so a cross-package import
compiles the wrong copy of the source — silently, with both symptoms pointing elsewhere. The
`SessionStart` hook repairs that before anything can run. **A worktree created mid-session has
not been through that hook**, so run it by hand there, from the worktree root:

```bash
node ../../../../scripts/link-workspace-packages.mjs
```

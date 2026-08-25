/**
 * The Node-only half of `domain` — the part a browser bundle must never load.
 *
 * `lib/dedupe.ts` hashes with `node:crypto`, and that is correct: §3.3's key is computed
 * server-side, at import time, and nothing in the UI has a reason to compute one. The bug
 * was the barrel. `src/index.ts` re-exported it, so every §6 page that imported
 * `formatCents` for display pulled `node:crypto` into the Angular bundle, and
 * `nx build ledgerline-ui` failed on it — a §2.2 boundary violation surfacing as a
 * bundler resolution error.
 *
 * ## Split by platform, not by feature
 *
 * The entry point is named for the property that puts code here: **it reaches for
 * `node:*`**. That makes the rule for a future addition mechanical rather than a
 * judgement call — a `/dedupe` entry point would have answered "what is inside" and left
 * the next Node-only helper with nowhere obvious to go — and it makes each call site say
 * which half it is asking for:
 *
 * ```ts
 * import { collapseV1, daysBetweenIso } from '@metrum/ledgerline-domain';
 * import { dedupeKey } from '@metrum/ledgerline-domain/node';
 * ```
 *
 * The root barrel is now loadable in any runtime, and stays that way only as long as
 * nothing here is re-exported from `./index.ts`. `nx run-many -t build` is part of
 * `npm run check` so that re-adding it fails a command someone actually runs; before
 * that it failed nothing, which is why this shipped unnoticed.
 */

export * from './lib/dedupe.js';

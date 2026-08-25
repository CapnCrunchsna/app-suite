/**
 * The universal entry point: types and arithmetic, safe in Node and in a browser bundle.
 *
 * `./lib/dedupe.js` is deliberately absent. It imports `node:crypto`, so re-exporting it
 * here puts a Node builtin in the import graph of every Angular page that wants
 * `formatCents`. It ships as `@metrum/ledgerline-domain/node` instead — see `./node.ts`
 * for why the split is by platform rather than by feature.
 */

export * from './lib/types.js';
export * from './lib/money.js';
export * from './lib/dates.js';
export * from './lib/collapse.js';

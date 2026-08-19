/**
 * §6's pages as routes, owned by this lib rather than by the shell.
 *
 * `apps/ledgerline-ui` is "shell only" (§2.2): it holds chrome and routing and
 * knows the *names* of the sections, not their contents. Exporting the routes from
 * here means adding the Findings page is a change to this file and one line in the
 * shell's rail, not a change to the shell's route table every time.
 *
 * Lazy, via `loadComponent`. Eight pages of which two are built; eagerly
 * importing the lot would put every page's code in the initial bundle for the
 * sake of the one the user opened.
 */

import type { Routes } from '@angular/router';

export const ledgerlineRoutes: Routes = [
  {
    path: 'imports',
    title: 'Import · Ledgerline',
    loadComponent: () => import('./imports/imports-page.js').then((module) => module.ImportsPage),
  },
  {
    path: 'findings',
    title: 'Findings · Ledgerline',
    loadComponent: () =>
      import('./findings/findings-page.js').then((module) => module.FindingsPage),
  },
  {
    path: 'transactions',
    title: 'Transactions · Ledgerline',
    loadComponent: () =>
      import('./transactions/transactions-page.js').then((module) => module.TransactionsPage),
  },
  // §6.4 is the page §6 calls the hero — the three numbers that justify the app —
  // so it is where the app opens now that it exists.
  { path: '', pathMatch: 'full', redirectTo: 'findings' },
];

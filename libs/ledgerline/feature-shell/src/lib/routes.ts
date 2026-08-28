/**
 * §6's pages as routes, owned by this lib rather than by the shell.
 *
 * `apps/ledgerline-ui` is "shell only" (§2.2): it holds chrome and routing and
 * knows the *names* of the sections, not their contents. Exporting the routes from
 * here means adding the Findings page is a change to this file and one line in the
 * shell's rail, not a change to the shell's route table every time.
 *
 * Lazy, via `loadComponent`. Nine §6 pages of which seven are built, plus the
 * home page at `''`; eagerly importing the lot would put every page's code in the
 * initial bundle for the sake of the one the user opened.
 */

import type { Routes } from '@angular/router';

export const ledgerlineRoutes: Routes = [
  {
    path: 'imports',
    title: 'Import · Ledgerline',
    loadComponent: () => import('./imports/imports-page.js').then((module) => module.ImportsPage),
  },
  {
    path: 'accounts',
    title: 'Accounts · Ledgerline',
    loadComponent: () =>
      import('./accounts/accounts-page.js').then((module) => module.AccountsPage),
  },
  {
    path: 'findings',
    title: 'Findings · Ledgerline',
    loadComponent: () =>
      import('./findings/findings-page.js').then((module) => module.FindingsPage),
  },
  {
    path: 'subscriptions',
    title: 'Subscriptions · Ledgerline',
    loadComponent: () =>
      import('./subscriptions/subscriptions-page.js').then((module) => module.SubscriptionsPage),
  },
  {
    path: 'transactions',
    title: 'Transactions · Ledgerline',
    loadComponent: () =>
      import('./transactions/transactions-page.js').then((module) => module.TransactionsPage),
  },
  {
    path: 'review',
    title: 'Review · Ledgerline',
    loadComponent: () => import('./review/review-page.js').then((module) => module.ReviewPage),
  },
  {
    path: 'settings',
    title: 'Settings · Ledgerline',
    loadComponent: () => import('./settings/settings-page.js').then((module) => module.SettingsPage),
  },
  // The front door (§9u). Not a §6 section: §6.4 is still the hero, and this
  // page's headline figure links straight to it. What it adds is the state you
  // are in — including the fresh-install state, where Findings is three
  // em-dashes and no indication that the next move is Import.
  {
    path: '',
    pathMatch: 'full',
    title: 'Ledgerline',
    loadComponent: () => import('./home/home-page.js').then((module) => module.HomePage),
  },
];

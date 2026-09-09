/**
 * §11.1's eight pages, in the order §11.1 lists them.
 *
 * Lazy, via `loadComponent`: eight pages, and the one a session opens is almost
 * always the dashboard. Eagerly importing the settings form and the matching
 * queue to render a health card would put both in the initial bundle for
 * nothing.
 *
 * `''` redirects to `/dashboard` rather than being a page of its own. §11.1 has
 * no front door above the eight, and the dashboard already is one — a tenth
 * screen would be a summary of a summary.
 *
 * The pages live in `apps/edgeline-ui/src/app/pages/` because §2.2 puts them
 * there (`src/app/pages/... # pages per §11`). Ledgerline's shell defers its
 * routes to a feature lib instead; that is a different arrangement for a
 * different reason — nine pages that three other projects' tests import — and
 * §2.2 reserves `libs/edgeline/` for "Edgeline-only libs, when any are needed".
 * None are needed for this.
 */

import type { Routes } from '@angular/router';

export const appRoutes: Routes = [
  {
    path: 'dashboard',
    title: 'Dashboard · Edgeline',
    loadComponent: () =>
      import('./pages/dashboard/dashboard-page').then((module) => module.DashboardPage),
  },
  {
    path: 'opportunities',
    title: 'Opportunities · Edgeline',
    loadComponent: () =>
      import('./pages/opportunities/opportunities-page').then(
        (module) => module.OpportunitiesPage,
      ),
  },
  {
    path: 'recommendations',
    title: 'Recommendations · Edgeline',
    loadComponent: () =>
      import('./pages/recommendations/recommendations-page').then(
        (module) => module.RecommendationsPage,
      ),
  },
  {
    path: 'results',
    title: 'Results · Edgeline',
    loadComponent: () =>
      import('./pages/results/results-page').then((module) => module.ResultsPage),
  },
  {
    path: 'settings',
    title: 'Settings · Edgeline',
    loadComponent: () =>
      import('./pages/settings/settings-page').then((module) => module.SettingsPage),
  },
  {
    path: 'sportsbooks',
    title: 'Sportsbooks · Edgeline',
    loadComponent: () =>
      import('./pages/sportsbooks/sportsbooks-page').then((module) => module.SportsbooksPage),
  },
  {
    path: 'providers',
    title: 'Providers · Edgeline',
    loadComponent: () =>
      import('./pages/providers/providers-page').then((module) => module.ProvidersPage),
  },
  {
    path: 'matching',
    title: 'Matching · Edgeline',
    loadComponent: () =>
      import('./pages/matching/matching-page').then((module) => module.MatchingPage),
  },
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'dashboard' },
];

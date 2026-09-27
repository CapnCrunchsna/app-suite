import type { Routes } from '@angular/router';
import { TabsPage } from './tabs/tabs-page';

/**
 * §10: four tabs and no other top-level navigation. Today is the landing tab — it is
 * the reason the app is opened — and the seeded library means it has something to plan
 * with on first launch.
 */
export const appRoutes: Routes = [
  {
    path: '',
    component: TabsPage,
    children: [
      { path: 'pantry', loadComponent: () => import('./pantry/pantry-page').then((m) => m.PantryPage) },
      { path: 'meals', loadComponent: () => import('./meals/meals-page').then((m) => m.MealsPage) },
      { path: 'today', loadComponent: () => import('./today/today-page').then((m) => m.TodayPage) },
      { path: 'settings', loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage) },
      { path: '', redirectTo: 'today', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: 'today' },
];

/**
 * The repositories, built once over the opened database — which, on first launch, is also
 * when the starter library is loaded (spec §15), so the first Generate has meals to plan.
 *
 * Pages reload what they show in `ionViewWillEnter` rather than subscribing to changes:
 * Ionic keeps each tab's page alive, the event fires every time a tab is shown, and a
 * pantry this size re-reads in a millisecond — cheaper than any invalidation scheme, and
 * never stale after cooking on Today and switching to Pantry.
 */

import { Injectable, inject } from '@angular/core';
import {
  MealsRepo,
  PantryRepo,
  ProductsRepo,
  SettingsRepo,
  loadSeedLibrary,
  type SeedLibrary,
  type SqlDb,
} from '@metrum/meal-planner-data';
import { Database, systemClock } from './database';

export interface Repos {
  readonly db: SqlDb;
  readonly products: ProductsRepo;
  readonly pantry: PantryRepo;
  readonly meals: MealsRepo;
  readonly settings: SettingsRepo;
}

@Injectable({ providedIn: 'root' })
export class Store {
  private readonly database = inject(Database);
  private repos: Promise<Repos> | null = null;

  ready(): Promise<Repos> {
    this.repos ??= this.open();
    return this.repos;
  }

  private async open(): Promise<Repos> {
    const db = await this.database.ready();
    await seed(db).catch((error) => console.error('Loading the starter library failed', error));
    return {
      db,
      products: new ProductsRepo(db, systemClock),
      pantry: new PantryRepo(db, systemClock),
      meals: new MealsRepo(db, systemClock),
      settings: new SettingsRepo(db),
    };
  }
}

async function seed(db: SqlDb): Promise<void> {
  const [products, meals] = await Promise.all([
    fetch('assets/seed/products.json').then((r) => r.json()),
    fetch('assets/seed/meals.json').then((r) => r.json()),
  ]);
  const library: SeedLibrary = { version: products.version, products: products.products, meals: meals.meals };
  await loadSeedLibrary(db, systemClock, library);
}

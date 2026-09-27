/**
 * The repositories, built once over the opened database.
 *
 * Pages reload what they show in `ionViewWillEnter` rather than subscribing to changes:
 * Ionic keeps each tab's page alive, the event fires every time a tab is shown, and a
 * pantry this size re-reads in a millisecond — cheaper than any invalidation scheme, and
 * never stale after cooking on Today and switching to Pantry.
 */

import { Injectable, inject } from '@angular/core';
import { PantryRepo, ProductsRepo, SettingsRepo, type SqlDb } from '@metrum/meal-planner-data';
import { Database, systemClock } from './database';

export interface Repos {
  readonly db: SqlDb;
  readonly products: ProductsRepo;
  readonly pantry: PantryRepo;
  readonly settings: SettingsRepo;
}

@Injectable({ providedIn: 'root' })
export class Store {
  private readonly database = inject(Database);
  private repos: Promise<Repos> | null = null;

  ready(): Promise<Repos> {
    this.repos ??= this.database.ready().then((db) => ({
      db,
      products: new ProductsRepo(db, systemClock),
      pantry: new PantryRepo(db, systemClock),
      settings: new SettingsRepo(db),
    }));
    return this.repos;
  }
}

/**
 * Opens the one SQLite database and brings it to the current schema.
 *
 * Opened once, on first use, and shared: `ready` is the same promise for every caller, so
 * two pages asking at startup do not race to create two connections. A failure to open
 * is kept as the rejected promise, and every page that awaits it shows the error — the
 * app never renders a pantry it could not read as an empty one.
 */

import { Injectable } from '@angular/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { migrate, type Clock, type SqlDb } from '@metrum/meal-planner-data';
import { capacitorSqlDb } from './capacitor-sql-db';

const DB_NAME = 'meal_planner';

/** UUID v4 from `getRandomValues`, which — unlike `randomUUID` — works off a LAN address too. */
function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  newId: uuidV4,
};

@Injectable({ providedIn: 'root' })
export class Database {
  private opening: Promise<SqlDb> | null = null;

  /** The migrated database. */
  ready(): Promise<SqlDb> {
    this.opening ??= open();
    return this.opening;
  }
}

async function open(): Promise<SqlDb> {
  const platform = Capacitor.getPlatform();
  const sqlite = new SQLiteConnection(CapacitorSQLite);

  if (platform === 'web') {
    // jeep-sqlite is the plugin's web implementation: a custom element hosting sql.js,
    // whose wasm the build copies to /assets (project.json). Its custom-elements build,
    // not its lazy loader: Ionic's components run on Stencil's shared custom-elements
    // runtime, and the dev server merged the loader's runtime into that one — after
    // which <jeep-sqlite> was "unknown to this Stencil runtime" and never opened.
    const { defineCustomElement } = await import('jeep-sqlite/dist/components/jeep-sqlite');
    defineCustomElement();
    if (!document.querySelector('jeep-sqlite')) document.body.appendChild(document.createElement('jeep-sqlite'));
    await customElements.whenDefined('jeep-sqlite');
    await sqlite.initWebStore();
  }

  const consistent = (await sqlite.checkConnectionsConsistency()).result;
  const exists = (await sqlite.isConnection(DB_NAME, false)).result;
  const conn =
    consistent && exists
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await conn.open();

  const db = capacitorSqlDb(conn, platform === 'web' ? () => sqlite.saveToStore(DB_NAME) : null);
  await migrate(db, systemClock);
  return db;
}

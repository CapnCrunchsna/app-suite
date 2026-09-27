/**
 * The storage port (meal-planner-spec.md §2). Every SQL statement in the app lives in
 * this lib; no driver does. The app implements `SqlDb` over `@capacitor-community/sqlite`,
 * and the tests implement it over `better-sqlite3`, so the same statements run in both.
 *
 * `transaction` hands its callback a scoped executor rather than relying on "whatever
 * runs next is inside the transaction". SQLite transactions are per connection, and a
 * phone app has one connection: an unrelated write that happened to land between BEGIN
 * and COMMIT would be committed — or rolled back — with someone else's work. The app's
 * adapter queues everything outside the scoped executor until the transaction ends.
 */

export type SqlValue = string | number | null;

export interface SqlExecutor {
  /** One or more parameterless statements, e.g. DDL. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

export interface SqlDb extends SqlExecutor {
  /** Runs `fn` in one transaction, committing on success and rolling back if it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Ids and timestamps are injected so tests are deterministic and the lib never reaches for a global. */
export interface Clock {
  /** ISO 8601 UTC, e.g. `new Date().toISOString()`. */
  now(): string;
  /** UUID v4 (§2). */
  newId(): string;
}

export const bool = (value: boolean): number => (value ? 1 : 0);

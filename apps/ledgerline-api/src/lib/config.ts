/**
 * Where the API listens and what it opens.
 *
 * **The host is a constant, not a setting.** `apps/CLAUDE.md` and §2.1 both say
 * this binds `127.0.0.1`, and the reason it is not configurable is that the only
 * way to get it wrong is to make it configurable. This process holds every
 * statement the user owns, has no authentication of any kind, and is designed
 * for one local user; `0.0.0.0` on a laptop that joins a coffee-shop network
 * publishes all of it.
 */

export const API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 4310;

export interface ApiConfig {
  readonly port: number;
  /** A path, or `:memory:` in tests. */
  readonly databaseFile: string;
  /** Seed `format_profile` rows from this directory at boot. */
  readonly profilesDir: string | null;
  /** Destination directory for `POST /api/data/backup`. */
  readonly backupDir: string;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv, workspaceRoot: string): ApiConfig {
  const port = Number(env['LEDGERLINE_PORT'] ?? DEFAULT_API_PORT);
  return {
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_API_PORT,
    // `data/` is gitignored and is where real statements and the live database
    // belong (docs/statement-parsing.md §3).
    databaseFile: env['LEDGERLINE_DB'] ?? `${workspaceRoot}/data/ledgerline.sqlite`,
    profilesDir: env['LEDGERLINE_PROFILES'] ?? `${workspaceRoot}/profiles`,
    backupDir: env['LEDGERLINE_BACKUPS'] ?? `${workspaceRoot}/data/backups`,
  };
}

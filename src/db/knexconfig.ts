import type { Knex } from 'knex';

/**
 * knexConfig builds the Knex configuration from the database URL. It is kept
 * under `src/` so it stays inside the TS program's rootDir (server code imports
 * it); the app never uses the knex CLI, so no repo-root knexfile is needed.
 */
export function knexConfig(databaseUrl = process.env['DATABASE_URL']): Knex.Config {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 0, max: 5 },
    migrations: {
      directory: 'src/db/migrations',
      extension: 'ts',
      tableName: 'knex_migrations',
    },
    seeds: {
      directory: 'src/db/seeds',
      extension: 'ts',
    },
  };
}

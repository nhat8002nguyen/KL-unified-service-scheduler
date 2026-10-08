import { Pool, type PoolClient } from 'pg';

/** The connection pool (a module-level dependency, injected rather than global). */
export type Db = Pool;

/** A single connection inside a transaction. */
export type DbTx = PoolClient;

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

import { Kysely, PostgresDialect, sql } from 'kysely';
import postgresDriver from 'pg';

// Replaced by the kysely-codegen output (src/generated/db.ts) once B1's migrations exist.
type Database = Record<string, never>;

export type DatabaseClient = Kysely<Database>;

type DatabaseOptions = {
  url: string;
  poolMax: number;
  /** An idle connection the server dropped (restart, failover). pg removes it and reconnects on the
   *  next query; without a listener the 'error' event would crash the process. */
  onIdleError: (error: Error) => void;
};

export const createDatabase = ({ url, poolMax, onIdleError }: DatabaseOptions): DatabaseClient => {
  const pool = new postgresDriver.Pool({ connectionString: url, max: poolMax });

  pool.on('error', onIdleError);

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
};

/** Resolves when PostgreSQL answers a query (readiness, ADR-017). */
export const pingDatabase = async (database: DatabaseClient): Promise<void> => {
  await sql`select 1`.execute(database);
};

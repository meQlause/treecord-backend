import { Kysely, PostgresDialect, sql } from 'kysely';
import postgresDriver from 'pg';

// Replaced by the kysely-codegen output (src/generated/db.ts) once B1's migrations exist.
type Database = Record<string, never>;

export type DatabaseClient = Kysely<Database>;

type DatabaseOptions = {
  url: string;
  poolMax: number;
  /** ADR-010, phases.md D-6: bounds connecting, the statement on the server and the wait for its answer. */
  timeoutMs: number;
  /** An idle connection the server dropped (restart, failover). pg removes it and reconnects on the
   *  next query; without a listener the 'error' event would crash the process. */
  onIdleError: (error: Error) => void;
};

export const createDatabase = ({
  url,
  poolMax,
  timeoutMs,
  onIdleError,
}: DatabaseOptions): DatabaseClient => {
  const pool = new postgresDriver.Pool({
    connectionString: url,
    max: poolMax,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  });

  pool.on('error', onIdleError);

  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
};

/** Resolves when PostgreSQL answers a query (readiness, ADR-017). */
export const pingDatabase = async (database: DatabaseClient): Promise<void> => {
  await sql`select 1`.execute(database);
};

// SQLSTATE 57014 query_canceled (statement timeout), 57P01–57P03 server shutting down, class 08 connection lost;
// Node socket errors; pg's own client-side timeouts, which carry no code.
const UNAVAILABLE_STATES = new Set(['57014', '57P01', '57P02', '57P03']);
const UNAVAILABLE_SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
]);
const UNAVAILABLE_MESSAGES =
  /Query read timeout|timeout exceeded when trying to connect|Connection terminated/;

/** ADR-010: PostgreSQL down or too slow is a 503, never a 500. */
export const isDatabaseUnavailable = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  if (typeof code === 'string') {
    return (
      UNAVAILABLE_STATES.has(code) || code.startsWith('08') || UNAVAILABLE_SOCKET_CODES.has(code)
    );
  }

  return UNAVAILABLE_MESSAGES.test(error.message);
};

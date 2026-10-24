import { Kysely, PostgresDialect } from 'kysely';
import postgresDriver from 'pg';
import type { DB } from '../../generated/db.js';

// ADR-001, ADR-021: the worker's SQL was written against these row shapes (bigint ids and blocks as JS numbers,
// timestamps as ISO strings), so its connections parse them the same way. The API's createDatabase keeps pg's
// defaults; the two never share a pool.
const { builtins } = postgresDriver.types;
const parseTimestamp = postgresDriver.types.getTypeParser(builtins.TIMESTAMPTZ) as (
  value: string,
) => Date;

/** int8 as a JS number, refusing a value a number cannot hold exactly. */
const parseInt8 = (value: string): number => {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`bigint ${value} does not fit a JS number`);
  }

  return parsed;
};

const parseIsoTimestamp = (value: string): string => parseTimestamp(value).toISOString();

const typeParsers = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => {
    if (oid === builtins.INT8) {
      return parseInt8;
    }

    if (oid === builtins.TIMESTAMPTZ) {
      return parseIsoTimestamp;
    }

    // numeric (uint256) stays a string; the SQL reads it with ::text anyway
    return format === 'binary'
      ? postgresDriver.types.getTypeParser(oid, 'binary')
      : postgresDriver.types.getTypeParser(oid);
  },
} as postgresDriver.CustomTypesConfig;

type WorkerDatabaseOptions = {
  url: string;
  poolMax: number;
  /** A dropped connection is reported, never thrown; the next query opens a new one. */
  onConnectionError: (error: Error) => void;
};

/** The worker's own pool (ADR-004): the same database as the API, its own connections and row parsers. */
export const createWorkerDatabase = ({
  url,
  poolMax,
  onConnectionError,
}: WorkerDatabaseOptions): Kysely<DB> => {
  const pool = new postgresDriver.Pool({ connectionString: url, max: poolMax, types: typeParsers });

  pool.on('error', onConnectionError);
  pool.on('connect', (client) => client.on('error', onConnectionError));

  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
};

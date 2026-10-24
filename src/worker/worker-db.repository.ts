// The worker's SQL helpers (ADR-001, ADR-021). The worker's statements are kept as they were written, with
// numbered parameters, and run through Kysely so no other module touches the database driver.
import { CompiledQuery, type Kysely, type Transaction } from 'kysely';
import postgresDriver from 'pg';
import type { DB, Json, RelayerJobKind, SubmissionStatus } from '../generated/db.js';

export type { Json, RelayerJobKind, SubmissionStatus };

/** The worker's pool. */
export type Db = Kysely<DB>;

/** The pool, or the transaction a chunk of writes runs in. */
export type Queryable = Kysely<DB> | Transaction<DB>;

export type Row = Record<string, unknown>;

/** Postgres unique violation. */
export const UNIQUE_VIOLATION = '23505';

/** Object storage buckets (ADR-020). */
export const EVIDENCE_BUCKET = 'evidence';

export const KEYFRAMES_BUCKET = 'keyframes';

/** The pino methods the worker logs with. */
export type Logger = {
  info: (object: object, message: string) => void;
  warn: (object: object, message: string) => void;
  error: (object: object, message: string) => void;
};

export class PipelineDbError extends Error {
  constructor(
    context: string,
    readonly pgError: { code: string | undefined; message: string },
  ) {
    super(`Database error during ${context}: ${pgError.message}`);
    this.name = 'PipelineDbError';
  }
}

/** Rows of a parameterized statement. Database errors are thrown as PipelineDbError. */
export const query = async <Result extends Row>(
  database: Queryable,
  context: string,
  text: string,
  values: unknown[] = [],
): Promise<Result[]> => {
  try {
    return (await database.executeQuery<Result>(CompiledQuery.raw(text, values))).rows;
  } catch (error) {
    if (error instanceof postgresDriver.DatabaseError) {
      throw new PipelineDbError(context, error);
    }

    throw error;
  }
};

/** The first row, or null. */
export const maybeOne = async <Result extends Row>(
  database: Queryable,
  context: string,
  text: string,
  values: unknown[] = [],
): Promise<Result | null> => (await query<Result>(database, context, text, values))[0] ?? null;

/** The first row; throws when there is none. */
export const one = async <Result extends Row>(
  database: Queryable,
  context: string,
  text: string,
  values: unknown[] = [],
): Promise<Result> => {
  const row = await maybeOne<Result>(database, context, text, values);

  if (!row) {
    throw new PipelineDbError(context, { code: undefined, message: 'no row found' });
  }

  return row;
};

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * `col = $n` pairs for an UPDATE, starting at $`first`. Undefined values are left out. pg sends objects as JSON
 * and arrays as Postgres arrays, so a jsonb value must be an object (every jsonb column the worker writes is).
 */
export const setClause = (
  changes: Record<string, unknown>,
  first = 1,
): { sql: string; values: unknown[] } => {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);

  return {
    sql: entries.map(([column], index) => `${ident(column)} = $${first + index}`).join(', '),
    values: entries.map(([, value]) => value),
  };
};

const conflictClause = (columns: string[], conflict?: 'ignore' | string[]): string => {
  if (conflict === undefined) {
    return '';
  }

  if (conflict === 'ignore') {
    return ' on conflict do nothing';
  }

  const updates = columns
    .filter((column) => !conflict.includes(column))
    .map((column) => `${ident(column)} = excluded.${ident(column)}`);

  return ` on conflict (${conflict.map(ident).join(', ')}) do update set ${updates.join(', ')}`;
};

/**
 * INSERT of one or more rows with the same columns. `conflict` "ignore" is `ON CONFLICT DO NOTHING` (an
 * idempotent event insert); a column list is an upsert that overwrites the other columns.
 */
export const insert = async (
  database: Queryable,
  context: string,
  { table, conflict }: { table: string; conflict?: 'ignore' | string[] },
  rows: Row | Row[],
): Promise<void> => {
  const list = Array.isArray(rows) ? rows : [rows];
  const [first] = list;

  if (!first) {
    return;
  }

  const columns = Object.keys(first);
  const values = list.flatMap((row) => columns.map((column) => row[column]));
  const placeholder = (rowIndex: number, columnIndex: number): string =>
    `$${rowIndex * columns.length + columnIndex + 1}`;
  const tuples = list.map(
    (_row, rowIndex) =>
      `(${columns.map((_column, columnIndex) => placeholder(rowIndex, columnIndex)).join(', ')})`,
  );
  const text = `insert into public.${ident(table)} (${columns.map(ident).join(', ')}) values ${tuples.join(', ')}`;

  await query(database, context, text + conflictClause(columns, conflict), values);
};

const MS_PER_SECOND = 1000;

/** A chain timestamp in seconds as the ISO string the mirror stores. */
export const isoFromSeconds = (seconds: bigint): string =>
  new Date(Number(seconds) * MS_PER_SECOND).toISOString();

/** Inserts an event row once: a duplicate (already recorded) is ignored. */
export const once = (
  database: Queryable,
  table: string,
  row: Row,
  context: string,
): Promise<void> => insert(database, context, { table, conflict: 'ignore' }, row);

/** UPDATE table SET changes WHERE `where`, whose parameters are `values`. */
export const updateWhere = async (
  database: Queryable,
  context: string,
  target: { table: string; where: string; values: unknown[] },
  changes: Row,
): Promise<void> => {
  const set = setClause(changes, target.values.length + 1);

  await query(
    database,
    context,
    `update public.${target.table} set ${set.sql} where ${target.where}`,
    [...target.values, ...set.values],
  );
};

/** Sum of the uint256 `amount` column of the matching rows, exact (read as text, added as bigint). */
export const sumAmounts = async (
  database: Queryable,
  context: string,
  target: { table: string; where: string; values: unknown[] },
): Promise<bigint> => {
  const rows = await query<{ amount: string }>(
    database,
    context,
    `select amount::text from public.${target.table} where ${target.where}`,
    target.values,
  );

  return rows.reduce((sum, row) => sum + BigInt(row.amount), BigInt(0));
};

/** Runs `work` in one transaction (ADR-004): commit on success, roll back on any error. */
export const inTransaction = <Result>(
  database: Db,
  work: (transaction: Queryable) => Promise<Result>,
): Promise<Result> => database.transaction().execute(work);

import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { inject } from 'vitest';
import { createDatabase, type DatabaseClient } from '../../src/shared/db/database.js';
import { migrateToLatest } from '../../src/shared/db/migrate.js';
import { databaseUrl, TEMPLATE } from './postgres.global.js';

export const CONTAINER_START_MS = 120_000;

export type TestDatabase = {
  /** The connection URI of this file's database, for a second pool (the worker's). */
  url: string;
  database: DatabaseClient;
  stop: () => Promise<void>;
};

const connect = (url: string, poolMax: number): DatabaseClient =>
  createDatabase({ url, poolMax, timeoutMs: 30_000, onConnectionError: () => undefined });

/**
 * A PostgreSQL 17 database with every migration applied (docs/BE/testing.md §7). By default it is a fresh copy of the
 * run's migrated template on the one shared container (postgres.global.ts). A test with its own `migrate` (rows
 * written between migrations) gets a container of its own: the bootstrap creates cluster-wide roles, which a second
 * database on the shared server could not create again.
 */
export const startMigratedDatabase = async (
  poolMax = 4,
  migrate?: (database: DatabaseClient) => Promise<unknown>,
): Promise<TestDatabase> => {
  const shared = migrate === undefined ? inject('postgresUri') : undefined;

  return shared === undefined
    ? ownContainer(poolMax, migrate ?? ((database) => migrateToLatest(database, 'migrations')))
    : copyOfTemplate(shared, poolMax);
};

const copyOfTemplate = async (server: string, poolMax: number): Promise<TestDatabase> => {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = connect(server, 1);

  await sql.raw(`create database ${name} template ${TEMPLATE}`).execute(admin);

  const url = databaseUrl(server, name);
  const database = connect(url, poolMax);

  return {
    url,
    database,
    stop: async () => {
      await database.destroy();
      await sql.raw(`drop database ${name} with (force)`).execute(admin);
      await admin.destroy();
    },
  };
};

const ownContainer = async (
  poolMax: number,
  migrate: (database: DatabaseClient) => Promise<unknown>,
): Promise<TestDatabase> => {
  const postgres = await new PostgreSqlContainer('postgres:17')
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();
  const url = postgres.getConnectionUri();
  const database = connect(url, poolMax);

  await migrate(database);

  return {
    url,
    database,
    stop: async () => {
      await database.destroy();
      await postgres.stop();
    },
  };
};

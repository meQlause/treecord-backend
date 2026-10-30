// Vitest globalSetup of the integration project: ONE PostgreSQL container per run instead of one per test file.
// Every migration is applied once, into a template database; each file then copies it (CREATE DATABASE … TEMPLATE,
// see database.ts), so files stay isolated without paying a container and a full migration each.
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/shared/db/database.js';
import { migrateToLatest } from '../../src/shared/db/migrate.js';

export const TEMPLATE = 'migrated_template';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The shared container's connection URI (its default database). */
    postgresUri: string;
  }
}

/** The same server, another database. */
export const databaseUrl = (uri: string, name: string): string => {
  const url = new URL(uri);

  url.pathname = `/${name}`;

  return url.toString();
};

const connect = (url: string) =>
  createDatabase({ url, poolMax: 1, timeoutMs: 60_000, onConnectionError: () => undefined });

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await new PostgreSqlContainer('postgres:17')
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();
  const uri = postgres.getConnectionUri();
  const admin = connect(uri);

  await sql.raw(`create database ${TEMPLATE}`).execute(admin);
  await admin.destroy();

  const template = connect(databaseUrl(uri, TEMPLATE));

  await migrateToLatest(template, 'migrations');
  // a template with an open connection cannot be copied
  await template.destroy();
  project.provide('postgresUri', uri);

  return async () => {
    await postgres.stop();
  };
}

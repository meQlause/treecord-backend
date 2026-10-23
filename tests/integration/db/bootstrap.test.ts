import { readFile } from 'node:fs/promises';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseClient } from '../../../src/shared/db/database.js';

const CONTAINER_START_MS = 120_000;

// Every role, schema, relation and function in the database, as one sorted list.
const catalog = async (database: DatabaseClient): Promise<string[]> => {
  const { rows } = await sql<{ object: string }>`
    select 'role ' || rolname || case when rolcanlogin then ' login' else ' nologin' end as object from pg_roles
    union all select 'schema ' || nspname from pg_namespace
    union all select 'relation ' || n.nspname || '.' || c.relname || ' (' || c.relkind::text || ')'
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    union all select 'function ' || n.nspname || '.' || p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
    order by 1`.execute(database);

  return rows.map(({ object }) => object);
};

describe('compatibility bootstrap — ADR-019 "inert"', () => {
  let postgres: StartedPostgreSqlContainer;
  let database: DatabaseClient;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start();
    database = createDatabase({
      url: postgres.getConnectionUri(),
      poolMax: 1,
      timeoutMs: 30_000,
      onConnectionError: () => undefined,
    });
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await database.destroy();
    await postgres.stop();
  });

  it('creates only the three Supabase roles, without login, and an empty storage.buckets', async () => {
    const before = await catalog(database);

    await sql.raw(await readFile('migrations/000_bootstrap.sql', 'utf8')).execute(database);

    const created = (await catalog(database)).filter((object) => !before.includes(object));

    expect(created).toEqual([
      'relation storage.buckets (r)',
      'relation storage.buckets_pkey (i)',
      'role anon nologin',
      'role authenticated nologin',
      'role service_role nologin',
      'schema storage',
    ]);

    const { rows } = await sql<{ count: string }>`select count(*) from storage.buckets`.execute(
      database,
    );

    expect(rows[0]?.count).toBe('0');
  });
});

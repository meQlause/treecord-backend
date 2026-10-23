import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabase, type DatabaseClient } from '../../src/shared/db/database.js';
import { migrateToLatest } from '../../src/shared/db/migrate.js';

export const CONTAINER_START_MS = 120_000;

export type TestDatabase = {
  postgres: StartedPostgreSqlContainer;
  database: DatabaseClient;
  stop: () => Promise<void>;
};

/** A throwaway PostgreSQL 17 in tmpfs with every migration applied (docs/BE/testing.md §7, docker-testing). */
export const startMigratedDatabase = async (poolMax = 4): Promise<TestDatabase> => {
  const postgres = await new PostgreSqlContainer('postgres:17')
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();
  const database = createDatabase({
    url: postgres.getConnectionUri(),
    poolMax,
    timeoutMs: 30_000,
    onIdleError: () => undefined,
  });

  await migrateToLatest(database, 'migrations');

  return {
    postgres,
    database,
    stop: async () => {
      await database.destroy();
      await postgres.stop();
    },
  };
};

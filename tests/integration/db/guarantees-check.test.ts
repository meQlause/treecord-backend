import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseClient } from '../../../src/shared/db/database.js';
import { migrateToLatest } from '../../../src/shared/db/migrate.js';

const CONTAINER_START_MS = 120_000;
// The runnable check written in S2, read from the specification, never copied (docs/data-spec.md §5.2, §6.2).
const CHECK = '../docs/data/guarantees-check.sql';

describe('data guarantees — docs/data/guarantees-check.sql on PostgreSQL 17', () => {
  let postgres: StartedPostgreSqlContainer;
  let database: DatabaseClient;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .withCopyFilesToContainer([{ source: CHECK, target: '/srv/guarantees-check.sql' }])
      .start();
    database = createDatabase({
      url: postgres.getConnectionUri(),
      poolMax: 1,
      timeoutMs: 30_000,
      onConnectionError: () => undefined,
    });
    await migrateToLatest(database, 'migrations');
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await database.destroy();
    await postgres.stop();
  });

  it('ends with ALL GUARANTEES HOLD, as psql -v ON_ERROR_STOP=1 runs it', async () => {
    const { exitCode, output } = await postgres.exec([
      'psql',
      '-U',
      postgres.getUsername(),
      '-d',
      postgres.getDatabase(),
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '/srv/guarantees-check.sql',
    ]);

    expect(output).toContain('ALL GUARANTEES HOLD');
    expect(exitCode).toBe(0);
  });
});

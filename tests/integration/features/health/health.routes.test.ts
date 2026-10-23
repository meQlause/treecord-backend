import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../../src/app.js';
import { createDatabase, pingDatabase } from '../../../../src/shared/db/database.js';
import { createLogger } from '../../../../src/shared/http/logger.js';

const CONTAINER_START_MS = 120_000;
// The chain stays behind a fake in integration tests (docs/BE/testing.md §1).
const chainUp = async (): Promise<bigint> => 17_000_015n;

const chainDown = async (): Promise<bigint> => {
  throw new Error('rpc unreachable');
};

describe('health and readiness — ADR-017', () => {
  let postgres: StartedPostgreSqlContainer;
  let database: ReturnType<typeof createDatabase>;
  let stopped = false;
  const idleErrors: Error[] = [];

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start();
    database = createDatabase({
      url: postgres.getConnectionUri(),
      poolMax: 2,
      onIdleError: (error) => idleErrors.push(error),
    });
  }, CONTAINER_START_MS);

  const appWith = (chain: () => Promise<bigint>) =>
    createApp({
      readiness: { database: () => pingDatabase(database), chain },
      logger: createLogger('silent'),
    });

  afterAll(async () => {
    await database.destroy();

    if (!stopped) {
      await postgres.stop();
    }
  });

  it('GET /healthz answers 200 while the process runs', async () => {
    const app = appWith(chainUp);

    await request(app).get('/healthz').expect(200, { status: 'ok' });
  });

  it('GET /readyz answers 200 when PostgreSQL and the RPC are reachable', async () => {
    const app = appWith(chainUp);

    await request(app).get('/readyz').expect(200, { status: 'ready' });
  });

  it('GET /readyz answers 503 when the RPC is unreachable', async () => {
    const app = appWith(chainDown);

    await request(app).get('/readyz').expect(503, { status: 'not_ready' });
  });

  it(
    'GET /readyz answers 503 with PostgreSQL stopped, while /healthz still answers 200',
    async () => {
      const app = appWith(chainUp);

      await postgres.stop();
      stopped = true;
      await request(app).get('/readyz').expect(503, { status: 'not_ready' });
      await request(app).get('/healthz').expect(200, { status: 'ok' });
      // the dropped idle connection reached the handler instead of crashing the process
      expect(idleErrors.length).toBeGreaterThan(0);
    },
    CONTAINER_START_MS,
  );
});

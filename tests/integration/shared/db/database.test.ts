import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import express from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DatabaseClient } from '../../../../src/shared/db/database.js';
import { errorHandler } from '../../../../src/shared/http/error-handler.js';
import { requestId } from '../../../../src/shared/http/request-id.js';

const CONTAINER_START_MS = 120_000;
const STATEMENT_TIMEOUT_MS = 800;
const SLACK_MS = 1_000;

// A route that holds a statement for 5 s: the fault ADR-010 asks to inject.
const appQuerying = (database: DatabaseClient) =>
  express()
    .use(requestId)
    .get('/slow', async (_req, res) => {
      await sql`select pg_sleep(5)`.execute(database);
      res.json({ done: true });
    })
    .use(errorHandler({ logUnexpected: vi.fn() }));

describe('database timeouts — ADR-010, phases.md D-6', () => {
  let postgres: StartedPostgreSqlContainer;
  let database: DatabaseClient;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start();
    database = createDatabase({
      url: postgres.getConnectionUri(),
      poolMax: 2,
      timeoutMs: STATEMENT_TIMEOUT_MS,
      onIdleError: () => undefined,
    });
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await database.destroy();
    await postgres.stop();
  });

  it('a statement held past the statement timeout answers 503 service_unavailable within the timeout plus 1 s', async () => {
    const started = performance.now();
    const response = await request(appQuerying(database)).get('/slow').expect(503);

    expect(response.body.error.code).toBe('service_unavailable');
    expect(performance.now() - started).toBeLessThan(STATEMENT_TIMEOUT_MS + SLACK_MS);
  });

  it('an unreachable database answers 503 service_unavailable, not 500', async () => {
    const unreachable = createDatabase({
      url: 'postgres://treecord:treecord@127.0.0.1:1/treecord',
      poolMax: 1,
      timeoutMs: STATEMENT_TIMEOUT_MS,
      onIdleError: () => undefined,
    });
    const response = await request(appQuerying(unreachable)).get('/slow').expect(503);

    expect(response.body.error.code).toBe('service_unavailable');
    await unreachable.destroy();
  });
});

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../../../../src/shared/db/database.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const aJob = (database: DatabaseClient, idempotencyKey: string | null) =>
  sql`insert into public.relayer_jobs (kind, payload, idempotency_key)
      values ('claim', '{"campaign":"0xcccc","count":2}'::jsonb, ${idempotencyKey})`.execute(
    database,
  );

const refusal = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('ADR-009 relayer_jobs.idempotency_key — unique, 1–200 characters', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await sql`delete from public.relayer_jobs`.execute(test.database);
  });

  it('the same key twice is refused by relayer_jobs_idempotency_key_key', async () => {
    await aJob(test.database, 'claim-0xcccc-2026-10-23-0001');

    expect(await refusal(aJob(test.database, 'claim-0xcccc-2026-10-23-0001'))).toMatchObject({
      code: '23505',
      constraint: 'relayer_jobs_idempotency_key_key',
    });
  });

  it.each([
    ['empty', ''],
    ['201 characters', 'k'.repeat(201)],
  ])('a %s key is refused by its length check', async (_name, key) => {
    expect(await refusal(aJob(test.database, key))).toMatchObject({
      code: '23514',
      constraint: 'relayer_jobs_idempotency_key_check',
    });
  });

  it('a 200-character key is accepted, and jobs without a key do not collide', async () => {
    await aJob(test.database, 'k'.repeat(200));
    await aJob(test.database, null);
    await aJob(test.database, null);

    const { rows } = await sql<{ count: string }>`select count(*) from public.relayer_jobs`.execute(
      test.database,
    );

    expect(rows[0]?.count).toBe('3');
  });
});

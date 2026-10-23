import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { aJob, aProfile } from '../fixtures/mirror.js';

// REG-004 (docs/BE/testing.md §4): the job page was gated by role instead of by creator.
const SARI = 'did:privy:cm2sari0000000000000000';
const DEWI = 'did:privy:cm2dewi0000000000000000';
const RAKA = 'did:privy:cm2raka0000000000000000';

let test: TestDatabase;
let api: TestApi;

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

it('the donor who created a job as a planter reads it; another planter gets 404; only the operator sees lastError', async () => {
  const sari = await aProfile(test.database, 'planter', SARI);

  await aProfile(test.database, 'planter', DEWI);
  await aProfile(test.database, 'operator', RAKA);

  const job = await aJob(test.database, sari, {
    status: 'failed',
    attempts: 5,
    last_error: 'Worker failure',
  });

  await sql`update public.profiles set role = 'donor' where id = ${sari}`.execute(test.database);

  const get = async (userId: string) =>
    request(api.app)
      .get(`/api/v1/jobs/${job}`)
      .set(await api.signedIn(userId));
  const asSari = await get(SARI);
  const asDewi = await get(DEWI);
  const asRaka = await get(RAKA);

  expect(asSari.status).toBe(200);
  expect(asSari.body.job).not.toHaveProperty('lastError');
  expect(asDewi.status).toBe(404);
  expect(asRaka.status).toBe(200);
  expect(asRaka.body.job.lastError).toBe('Worker failure');
});

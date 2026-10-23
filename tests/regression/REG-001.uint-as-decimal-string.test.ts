import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueue } from '../../src/features/jobs/jobs.service.js';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { aProfile } from '../fixtures/mirror.js';

// REG-001 (docs/BE/testing.md §4): amounts and ids lost digits when parsed as JS numbers. 2^53 + 1 is the first
// integer a JSON number cannot hold. B4a adds the campaign and tree figures to this file.
const BEYOND_DOUBLE = '9007199254740993';
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

it(`${BEYOND_DOUBLE} round-trips through a job payload as the exact decimal string`, async () => {
  const raka = await aProfile(test.database, 'operator', RAKA);
  const { job } = await test.database.transaction().execute((trx) =>
    enqueue(trx, {
      kind: 'set_price',
      payload: { batchId: BEYOND_DOUBLE, usdcPerTonne: BEYOND_DOUBLE },
      createdBy: raka,
      idempotencyKey: null,
    }),
  );
  const stored = await sql<{ batch_id: string; price: string }>`
    select payload->>'batchId' as batch_id, payload->>'usdcPerTonne' as price
    from public.relayer_jobs where id = ${job.id}`.execute(test.database);

  expect(stored.rows).toEqual([{ batch_id: BEYOND_DOUBLE, price: BEYOND_DOUBLE }]);

  const response = await request(api.app)
    .get(`/api/v1/jobs/${job.id}`)
    .set(await api.signedIn(RAKA));

  expect(response.body.job.context.batchId).toBe(BEYOND_DOUBLE);
  expect(response.text).toContain(`"batchId":"${BEYOND_DOUBLE}"`);
});

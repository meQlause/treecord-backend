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

// REG-008 (docs/BE/testing.md §4): a confirmed job hid its transaction hash.
const SARI = 'did:privy:cm2sari0000000000000000';
const TX_HASH = '0x9c4e2a7f1b8d3c6e0f5a9b2d7c4e1f8a3b6d9c2e5f0a7b4d1c8e3f6a9b2d5ce1';

let test: TestDatabase;
let api: TestApi;

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

it('GET /jobs/:id returns the txHash of a confirmed job', async () => {
  const sari = await aProfile(test.database, 'planter', SARI);
  const job = await aJob(test.database, sari, {
    status: 'confirmed',
    attempts: 1,
    tx_hash: TX_HASH,
  });

  const response = await request(api.app)
    .get(`/api/v1/jobs/${job}`)
    .set(await api.signedIn(SARI));

  expect(response.status).toBe(200);
  expect(response.body.job).toMatchObject({ status: 'confirmed', txHash: TX_HASH });
});

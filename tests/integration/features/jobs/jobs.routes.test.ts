import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { aJob, aPlantedTree, aProfile, CAMPAIGN, TREE_ID } from '../../../fixtures/mirror.js';

const SARI = 'did:privy:cm2sari0000000000000000';
const DEWI = 'did:privy:cm2dewi0000000000000000';
const RAKA = 'did:privy:cm2raka0000000000000000';
const CLAIM_ID = '3f2a9c1e-7b4d-4e8a-9c21-5d6f0a8b3e17';
const CLAIM_CAMPAIGN = '0x0000000000000000000000000000000000000003';
const SUBMISSION_ID = '7c1e4a9d-2b6f-4e83-a5d0-9f3b8c2e6a14';
const NOTE_HASH = `0x${'5e'.repeat(32)}`;
const ISSUED_TX = `0x${'7'.repeat(64)}`;

let test: TestDatabase;
let api: TestApi;
let sari: string;

const getJob = async (id: string, userId: string) =>
  request(api.app)
    .get(`/api/v1/jobs/${id}`)
    .set(await api.signedIn(userId));

// Seeded once: every test makes its own jobs. Tree #3001 and batch 101 sit in CAMPAIGN.
beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  sari = await aProfile(test.database, 'planter', SARI);
  await aProfile(test.database, 'planter', DEWI);
  await aProfile(test.database, 'operator', RAKA);
  await aPlantedTree(test.database);
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx)
    values (101, ${CAMPAIGN}, 1000, 'Verra', 'VCS-1', 'VCS-1000', 2026, 1, ${ISSUED_TX})`.execute(
    test.database,
  );
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/jobs.md §2, FR-023–FR-025.
describe('GET /api/v1/jobs/:id', () => {
  it("answers its creator with jobs §2's confirmed claim, never cached", async () => {
    await aJob(test.database, sari, {
      id: CLAIM_ID,
      status: 'confirmed',
      attempts: 1,
      tx_hash: '0x9c4e2a7f1b8d3c6e0f5a9b2d7c4e1f8a3b6d9c2e5f0a7b4d1c8e3f6a9b2d5ce1',
      payload: { campaign: CLAIM_CAMPAIGN, planter: `0x${'4b'.repeat(20)}`, count: 2 },
      created_at: new Date('2026-10-23T03:02:07.214Z'),
      updated_at: new Date('2026-10-23T03:03:12.889Z'),
    });

    const response = await getJob(CLAIM_ID, SARI);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      job: {
        id: CLAIM_ID,
        kind: 'claim',
        status: 'confirmed',
        attempts: 1,
        txHash: '0x9c4e2a7f1b8d3c6e0f5a9b2d7c4e1f8a3b6d9c2e5f0a7b4d1c8e3f6a9b2d5ce1',
        createdAt: '2026-10-23T03:02:07.214Z',
        updatedAt: '2026-10-23T03:03:12.889Z',
        context: { campaign: CLAIM_CAMPAIGN, treeId: null, batchId: null, submissionId: null },
      },
    });
  });

  it('finds the campaign through the tree for resolve_flag and through the batch for set_price', async () => {
    const flag = await aJob(test.database, null, {
      kind: 'resolve_flag',
      payload: { treeId: String(TREE_ID), uphold: false, noteHash: NOTE_HASH },
    });
    const price = await aJob(test.database, null, {
      kind: 'set_price',
      payload: { batchId: '101', usdcPerTonne: '18500000' },
    });
    const score = await aJob(test.database, null, {
      kind: 'score',
      payload: { submissionId: SUBMISSION_ID },
    });

    expect((await getJob(flag, RAKA)).body.job.context).toEqual({
      campaign: CAMPAIGN,
      treeId: String(TREE_ID),
      batchId: null,
      submissionId: null,
    });
    expect((await getJob(price, RAKA)).body.job.context).toEqual({
      campaign: CAMPAIGN,
      treeId: null,
      batchId: '101',
      submissionId: null,
    });
    expect((await getJob(score, RAKA)).body.job.context).toEqual({
      campaign: null,
      treeId: null,
      batchId: null,
      submissionId: SUBMISSION_ID,
    });
  });

  it('gives an operator a job nobody owns any more', async () => {
    expect((await getJob(await aJob(test.database, null), RAKA)).status).toBe(200);
  });
});

describe('GET /api/v1/jobs/:id refuses', () => {
  it.each([
    ['another planter', async () => aJob(test.database, sari), DEWI],
    ['a job nobody owns, to a planter', async () => aJob(test.database, null), SARI],
    ['an id that does not exist', async () => '0b6c2f1e-4d8a-4c3b-9e7f-1a2b3c4d5e6f', SARI],
  ])('answers 404 not_found for %s', async (_case, jobId, userId) => {
    const response = await getJob(await jobId(), userId);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('answers 400 invalid_path for an id that is not a uuid', async () => {
    const response = await getJob('3f2a9c1e', SARI);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_path');
  });
});

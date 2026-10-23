import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAuditService } from '../../src/features/audit/audit.service.js';
import { DEMO_AUDIT_BLOCK, testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { auditDemo, NADIA, OMAR } from '../fixtures/audit-demo.js';
import { ALEX, ROOTS } from '../fixtures/roots-that-stay.js';

// REG-005 (docs/BE/testing.md §4, DN-8): an auditor was blocked from evidence, and foreign records answered 403. Nadia's
// demo session samples 3001, 3091 and 3104: she reads the planting that became tree 3001 (logged first), but not a
// check-in on unsampled tree 3020; Omar and Alex get 404 for the planting, never 403.
const DEMO_AUDIT = 'e9219997-5281-4602-b694-f3c4b08cf7c3';
const UNSAMPLED = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

let test: TestDatabase;
let api: TestApi;
let planting = '';

const read = async (submissionId: string, userId: string) =>
  request(api.app)
    .get(`/api/v1/evidence/${submissionId}`)
    .set(await api.signedIn(userId));

const logRows = async () =>
  (
    await sql<{
      resource: string;
      session_id: string;
    }>`select resource, session_id from public.audit_access_log order by id`.execute(test.database)
  ).rows;

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await auditDemo(test.database);

  const nadia = await sql<{
    id: string;
  }>`select id from public.profiles where privy_user_id = ${NADIA}`.execute(test.database);

  await createAuditService({
    database: test.database,
    latestBlock: async () => DEMO_AUDIT_BLOCK,
    clock: () => new Date(),
    newId: () => DEMO_AUDIT,
    randomBytes: (count) => new Uint8Array(count),
    // no evidence is read by opening a session
    storage: {
      presignGet: async () => {
        throw new Error('no storage in this test');
      },
      sha256Of: async () => null,
    },
  }).open({ id: nadia.rows[0]?.id ?? '' }, { campaign: ROOTS, sampleSize: 3 });
  planting = (
    await sql<{
      id: string;
    }>`select id from public.submissions where kind = 'PLANTED' and campaign_address = ${ROOTS}
      and slot_id = 1`.execute(test.database)
  ).rows[0]?.id as string;
  await sql`insert into public.submissions (id, profile_id, campaign_address, kind, milestone, tree_id, video_sha256,
      status)
    select ${UNSAMPLED}, profile_id, ${ROOTS}, 'ALIVE', 2, 3020, ${'d'.repeat(64)}, 'needs_review'
    from public.submissions where id = ${planting}`.execute(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

it('the sampling auditor reads the planting of sampled tree 3001, logged against her session first', async () => {
  const response = await read(planting, NADIA);

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ id: planting, kind: 'PLANTED', treeId: '3001' });
  expect(await logRows()).toEqual([{ resource: `submission:${planting}`, session_id: DEMO_AUDIT }]);
});

it('a submission on an unsampled tree, another auditor and a donor all answer 404, never 403, unlogged', async () => {
  const before = await logRows();

  for (const [submissionId, userId] of [
    [UNSAMPLED, NADIA],
    [planting, OMAR],
    [planting, ALEX],
  ] as const) {
    const response = await read(submissionId, userId);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  }

  expect(await logRows()).toEqual(before);
});

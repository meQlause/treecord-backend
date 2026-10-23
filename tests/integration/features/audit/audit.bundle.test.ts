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
import { startMinio, type TestMinio } from '../../../helpers/minio.js';
import { planterPhone, sha256Hex } from '../../../helpers/planter-phone.js';
import { auditDemo, NADIA, OMAR } from '../../../fixtures/audit-demo.js';
import { ROOTS, SARI, SARI_WALLET } from '../../../fixtures/roots-that-stay.js';

// docs/BE/features/audit.md §4, FR-193–FR-196, NFR-053: Nadia's session samples the whole population; Sari signs a
// month-6 check-in for tree 3001 with a real device key and uploads its clip, so every check can be recomputed.
const CLIP = Buffer.from('month-6 check-in clip for tree 3001');
const TREE_3001 = { lat: -7.431205, lon: 109.247813 };

let test: TestDatabase;
let minio: TestMinio;
let api: TestApi;
let sessionId = '';
let checkInId = '';

const readTree = async (treeId: string, userId = NADIA) =>
  request(api.app)
    .get(`/api/v1/audit/sessions/${sessionId}/trees/${treeId}`)
    .set(await api.signedIn(userId));

const logged = async (resource: string): Promise<number> =>
  (
    await sql<{ n: number }>`select count(*)::int as n from public.audit_access_log
      where resource = ${resource}`.execute(test.database)
  ).rows[0]?.n ?? 0;

const checkInOf = async (treeId: string) =>
  (await readTree(treeId)).body.submissions.find(({ id }: { id: string }) => id === checkInId);

/** Sari's signed month-6 check-in for tree 3001, submitted through the API. */
const signedCheckIn = async (): Promise<string> => {
  const phone = await planterPhone(api, SARI);
  const id = await phone.record(
    { kind: 'ALIVE', campaign: ROOTS, treeId: '3001', milestone: 2, contentType: 'video/webm' },
    CLIP,
  );
  const signed = await phone.sign({
    v: 1,
    kind: 'ALIVE',
    campaign: ROOTS,
    slotId: null,
    treeId: '3001',
    milestone: 2,
    videoSha256: sha256Hex(CLIP),
    ...TREE_3001,
    acc: 8.4,
    capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
    challenge: null,
    deviceKey: phone.deviceKey,
    tag: 'TC-K7QM-3XRA',
  });
  const submitted = await request(api.app)
    .post(`/api/v1/evidence/${id}/submit`)
    .set(await api.signedIn(SARI))
    .send(signed);

  expect(submitted.status).toBe(202);

  return id;
};

beforeAll(async () => {
  [test, minio] = await Promise.all([startMigratedDatabase(), startMinio()]);
  api = testApi(test.database, await fakePrivy(), { clock: () => new Date(), env: minio.config });
  await auditDemo(test.database);
  checkInId = await signedCheckIn();
  sessionId = (
    await request(api.app)
      .post('/api/v1/audit/sessions')
      .set(await api.signedIn(NADIA))
      .send({ campaign: ROOTS, sampleSize: 7 })
  ).body.id as string;
}, CONTAINER_START_MS);

afterAll(async () => {
  await Promise.all([test.stop(), minio.stop()]);
});

describe('GET /api/v1/audit/sessions/:id/trees/:treeId', () => {
  it('logs the read, then answers tree 3001 with its exact place, progress, submissions, events and payouts', async () => {
    const response = await readTree('3001');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sessionId,
      sessionStatus: 'open',
      sample: { treeId: '3001', sampleSize: 7, finding: null, notes: null },
      tree: {
        treeId: '3001',
        status: 'alive',
        campaign: ROOTS,
        slotId: '1',
        planter: SARI_WALLET,
        location: { ...TREE_3001, precision: 'exact' },
        replantDeadline: null,
      },
      progress: { milestonesPaid: 2, month: 6 },
      challenge: null,
      openChallenge: null,
    });
    expect(response.body.submissions.map(({ kind }: { kind: string }) => kind)).toEqual([
      'PLANTED',
      'ALIVE',
      'ALIVE',
    ]);
    expect(response.body.events.map(({ kind }: { kind: string }) => kind)).toEqual([
      'planted',
      'check_in',
    ]);
    expect(response.body.payouts.map(({ milestone }: { milestone: number }) => milestone)).toEqual([
      0, 1,
    ]);
    expect(await logged('tree:3001')).toBe(1);
    await readTree('3001');
    expect(await logged('tree:3001')).toBe(2);
  });

  it('recomputes every check of the signed check-in; a record without them shows null, never a pass (FR-195)', async () => {
    const response = await readTree('3001');
    const [planting] = response.body.submissions;
    const checkIn = await checkInOf('3001');

    expect(checkIn.verification).toEqual({
      signatureValid: true,
      canonicalMatchesPayload: true,
      evidenceHashMatches: true,
      videoHashMatches: true,
      recomputedSha256: sha256Hex(CLIP),
    });
    expect(checkIn.video).toMatchObject({
      sha256: sha256Hex(CLIP),
      url: expect.stringContaining('X-Amz-Signature'),
    });
    expect(planting.verification).toMatchObject({
      signatureValid: null,
      canonicalMatchesPayload: null,
      evidenceHashMatches: null,
    });
  });
});

describe('GET /api/v1/audit/sessions/:id/trees/:treeId tampering and refusals', () => {
  it('a tampered canonical record fails its signature, canonical and hash checks', async () => {
    await sql`update public.submissions set canonical = '{"tampered":true}' where id = ${checkInId}`.execute(
      test.database,
    );

    expect((await checkInOf('3001')).verification).toMatchObject({
      signatureValid: false,
      canonicalMatchesPayload: false,
      evidenceHashMatches: false,
      videoHashMatches: true,
    });
  });

  it('a tree outside the sample and another auditor answer 404, and neither is logged', async () => {
    const before = await logged('tree:3001');

    expect((await readTree('3105')).body.error.code).toBe('not_found');
    expect((await readTree('3001', OMAR)).body.error.code).toBe('not_found');
    expect(await logged('tree:3105')).toBe(0);
    expect(await logged('tree:3001')).toBe(before);
  });
});

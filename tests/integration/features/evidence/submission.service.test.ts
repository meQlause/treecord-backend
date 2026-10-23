import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidencePayload } from '../../../../src/generated/frozen/evidence.js';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { startMinio, type TestMinio } from '../../../helpers/minio.js';
import { planterPhone, sha256Hex, type Phone } from '../../../helpers/planter-phone.js';
import { planterWorkspace, ROOTS, SARI } from '../../../fixtures/planter-workspace.js';

// Tree 3001's month-6 window holds this chain time; the server clock is real so MinIO honours the links it signs.
const CHAIN_TIME = new Date('2026-10-23T09:12:31Z');
const TREE_3001 = { lat: -7.42431, lon: 109.23987 };
const CHECK_IN_TARGET = {
  kind: 'ALIVE',
  campaign: ROOTS,
  treeId: '3001',
  milestone: 2,
  contentType: 'video/webm',
};

let test: TestDatabase;
let minio: TestMinio;
let api: TestApi;
let phone: Phone;
let clips = 0;

/** A clip nobody has sent before. */
const freshClip = (): Buffer => {
  clips += 1;

  return Buffer.from(`check-in clip ${clips} for tree 3001`);
};

const checkInPayload = (video: Buffer, change: Partial<EvidencePayload> = {}): EvidencePayload => ({
  v: 1,
  kind: 'ALIVE',
  campaign: ROOTS,
  slotId: null,
  treeId: '3001',
  milestone: 2,
  videoSha256: sha256Hex(video),
  ...TREE_3001,
  acc: 8.4,
  capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
  challenge: 'R4M9',
  deviceKey: phone.deviceKey,
  tag: 'TC-K7QM-3XRA',
  ...change,
});

const submit = async (submissionId: string, body: object) =>
  request(api.app)
    .post(`/api/v1/evidence/${submissionId}/submit`)
    .set(await api.signedIn(SARI))
    .send(body);

beforeAll(async () => {
  [test, minio] = await Promise.all([startMigratedDatabase(), startMinio()]);
  api = testApi(test.database, await fakePrivy(), {
    chainNow: async () => CHAIN_TIME,
    clock: () => new Date(),
    env: minio.config,
  });
  await planterWorkspace(test.database);
  await sql`update public.trees set exact_lat = ${TREE_3001.lat}, exact_lon = ${TREE_3001.lon}
    where tree_id = 3001`.execute(test.database);
  // tree 3001's month-6 check-in is the one being submitted here: the demo's rejected one is not in the way
  await sql`delete from public.submissions where tree_id = 3001 and kind = 'ALIVE'`.execute(
    test.database,
  );
  phone = await planterPhone(api, SARI);
}, CONTAINER_START_MS);

afterAll(async () => {
  await Promise.all([test.stop(), minio.stop()]);
});

// docs/BE/features/evidence.md §3, evidence-prechecks.md §4, FR-112, FR-115, FR-130.
describe('POST /api/v1/evidence/:submissionId/submit, failing prechecks', () => {
  it('answers 422 precheck_failed with its reasons, stores every check and rejects the row; no score job', async () => {
    const video = freshClip();
    const submissionId = await phone.record(CHECK_IN_TARGET, video);
    const response = await submit(
      submissionId,
      await phone.sign(checkInPayload(video, { acc: 41 })),
    );
    const [stored] = (
      await sql<{
        status: string;
        reject_reasons: string[];
        precheck_results: { check: string; ok: boolean }[];
      }>`
        select status, reject_reasons, precheck_results from public.submissions where id = ${submissionId}`.execute(
        test.database,
      )
    ).rows;
    const scoreKey = `score:${submissionId}`;
    const jobs = await sql<{ n: number }>`select count(*)::int as n from public.relayer_jobs
      where idempotency_key = ${scoreKey}`.execute(test.database);

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'precheck_failed',
      details: { reasons: ['gps_inaccurate'], submissionId, status: 'rejected' },
    });
    expect(stored?.status).toBe('rejected');
    expect(stored?.reject_reasons).toEqual(['gps_inaccurate']);
    expect(stored?.precheck_results.map((row) => row.check)).toHaveLength(14);
    expect(stored?.precheck_results.find((row) => row.check === 'gps_accuracy')).toMatchObject({
      ok: false,
      value: '41.0 m',
      limit: '≤ 30 m',
      reason: 'gps_inaccurate',
    });
    expect(jobs.rows[0]?.n).toBe(0);
  });

  it('a second submit of a rejected row answers the same 422 (FR-130 replay)', async () => {
    const video = freshClip();
    const submissionId = await phone.record(CHECK_IN_TARGET, video);
    const signed = await phone.sign(checkInPayload(video, { challenge: null }));
    const first = await submit(submissionId, signed);
    const again = await submit(submissionId, signed);

    expect(first.body.error.details.reasons).toEqual(['challenge_missing']);
    expect(again.status).toBe(422);
    expect(again.body.error.details).toEqual(first.body.error.details);
  });

  it('a payload changed after signing is the reason signature_invalid, beside any other', async () => {
    const video = freshClip();
    const submissionId = await phone.record(CHECK_IN_TARGET, video);
    const signed = await phone.sign(checkInPayload(video));
    const response = await submit(submissionId, {
      ...signed,
      payload: { ...signed.payload, tag: 'TC-AAAA-BBBB' },
    });

    expect(response.body.error.details.reasons).toEqual(['signature_invalid', 'tag_mismatch']);
  });

  it('a sound check-in goes to checking with its score job (202)', async () => {
    const video = freshClip();
    const submissionId = await phone.record(CHECK_IN_TARGET, video);
    const response = await submit(submissionId, await phone.sign(checkInPayload(video)));

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({ kind: 'score', status: 'pending', attempts: 0 });
  });
});

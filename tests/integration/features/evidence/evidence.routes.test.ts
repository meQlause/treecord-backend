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
import { aProfile } from '../../../fixtures/mirror.js';
import {
  DEVICE_ID,
  IN_REVIEW,
  planterWorkspace,
  ROOTS,
  SARI,
  SARI_WALLET,
} from '../../../fixtures/planter-workspace.js';

const CHAIN_TIME = new Date('2026-10-23T09:12:31Z');
const DEWI = 'did:privy:cm2dewi0000000000000000';
const DEWI_WALLET = `0x${'d'.repeat(40)}`;
const NO_WALLET = 'did:privy:cm2nowallet00000000000';
const DONOR = 'did:privy:cm2alex0000000000000000';
const ROOTS_CAMPAIGN = {
  address: ROOTS,
  title: 'Roots that stay',
  regionName: 'Banyumas, Central Java',
  regionRadiusM: 2500,
};
const TREE_EVIDENCE = `0x${'e'.repeat(64)}`;
const TREE_TX = `0x${'f'.repeat(64)}`;
const TAG_FORMAT = /^TC-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

let test: TestDatabase;
let api: TestApi;

const target = async (query: string, userId = SARI) =>
  request(api.app)
    .get(`/api/v1/evidence/capture-target?${query}`)
    .set(await api.signedIn(userId));

/** A tree planted on a slot that never got a tag (planted before tags existed). */
const untaggedTree = async (treeId: number, slotId: number, wallet: string): Promise<void> => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${ROOTS}, ${slotId}, 'open', 'planted', ${wallet})`.execute(test.database);
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx)
    values (${treeId}, ${ROOTS}, ${slotId}, ${wallet}, '2026-04-18T05:00:00Z', 'qqtttzp', ${TREE_EVIDENCE},
      ${TREE_TX})`.execute(test.database);
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy(), { chainNow: async () => CHAIN_TIME });
  await planterWorkspace(test.database);
  await aProfile(test.database, 'planter', DEWI, DEWI_WALLET);
  await aProfile(test.database, 'planter', NO_WALLET);
  await aProfile(test.database, 'donor', DONOR, `0x${'c'.repeat(40)}`);
  await sql`update public.campaigns set region_center_lat = -7.4251, region_center_lon = 109.2401
    where address = ${ROOTS}`.execute(test.database);
  await sql`update public.trees set exact_lat = -7.42431, exact_lon = 109.23987 where tree_id = 3001`.execute(
    test.database,
  );
  await untaggedTree(3200, 60, SARI_WALLET);
  await untaggedTree(3300, 61, DEWI_WALLET);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/evidence.md §1, FR-095, FR-099, FR-140.
describe('GET /api/v1/evidence/capture-target', () => {
  it("answers the §1 example for tree 3001's month-6 check-in", async () => {
    const response = await target('kind=ALIVE&treeId=3001');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      kind: 'ALIVE',
      slotId: null,
      treeId: '3001',
      milestone: 2,
      month: 6,
      campaign: ROOTS_CAMPAIGN,
      tag: 'TC-K7QM-3XRA',
      challenge: { code: 'R4M9', qr: 'TCH-R4M9', expiresAt: '2026-12-20T04:00:00.000Z' },
      reference: { kind: 'tree', lat: -7.42431, lon: 109.23987, radiusM: 15 },
      allowed: true,
      reasons: [],
      held: null,
      chainTime: '2026-10-23T09:12:31.000Z',
    });
  });

  it('issues a missing tag to its own planter before answering (FR-140)', async () => {
    const first = await target('kind=ALIVE&treeId=3200');
    const again = await target('kind=ALIVE&treeId=3200');

    expect(first.body.tag).toMatch(TAG_FORMAT);
    expect(first.body.reasons).not.toContain('tag_missing');
    expect(again.body.tag).toBe(first.body.tag);
  });

  it("someone else's untagged tree: no tag issued, no location, and tag_missing among its reasons", async () => {
    const response = await target('kind=ALIVE&treeId=3300');
    const stored = await sql<{ n: number }>`select count(*)::int as n from public.slot_tags
      where campaign_address = ${ROOTS} and slot_id = 61`.execute(test.database);

    expect(response.body).toMatchObject({
      tag: null,
      reference: null,
      allowed: false,
      reasons: ['tree_not_owned', 'milestone_not_open', 'tag_missing'],
    });
    expect(stored.rows[0]?.n).toBe(0);
  });

  it('a held month answers 200 with the holding submission, not an error', async () => {
    expect((await target('kind=ALIVE&treeId=3104')).body).toMatchObject({
      allowed: false,
      reasons: ['milestone_already_done'],
      held: { id: IN_REVIEW, status: 'needs_review', milestone: 2, month: 6, deviceId: DEVICE_ID },
    });
  });

  it('a planting target: the claimed slot with the region as its reference', async () => {
    expect((await target(`kind=PLANTED&campaign=${ROOTS}&slotId=41`)).body).toEqual({
      kind: 'PLANTED',
      slotId: '41',
      treeId: null,
      milestone: 0,
      month: 0,
      campaign: ROOTS_CAMPAIGN,
      tag: 'TC-B2YK-5ZWN',
      challenge: null,
      reference: { kind: 'region', lat: -7.4251, lon: 109.2401, radiusM: 2500 },
      allowed: true,
      reasons: [],
      held: null,
      chainTime: '2026-10-23T09:12:31.000Z',
    });
  });
});

describe('GET /api/v1/evidence/capture-target refuses', () => {
  const PLANTING = `kind=PLANTED&campaign=${ROOTS}&slotId=41`;

  it.each([
    { name: 'no kind', query: 'treeId=3001', status: 400, code: 'validation_error' },
    {
      name: 'a tree id on a planting',
      query: `${PLANTING}&treeId=3001`,
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a campaign on a check-in',
      query: `kind=ALIVE&treeId=3001&campaign=${ROOTS}`,
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a malformed tree id',
      query: 'kind=ALIVE&treeId=01',
      status: 400,
      code: 'validation_error',
    },
    { name: 'an unknown tree', query: 'kind=ALIVE&treeId=999999', status: 404, code: 'not_found' },
    {
      name: 'a slot the campaign does not have',
      query: `kind=PLANTED&campaign=${ROOTS}&slotId=999`,
      status: 404,
      code: 'not_found',
    },
    {
      name: 'a planter without a wallet',
      query: 'kind=ALIVE&treeId=3001',
      user: NO_WALLET,
      status: 403,
      code: 'wallet_missing',
    },
    {
      name: 'a donor',
      query: 'kind=ALIVE&treeId=3001',
      user: DONOR,
      status: 403,
      code: 'forbidden_role',
    },
  ])('$name', async ({ query, user = SARI, status, code }) => {
    const response = await target(query, user);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

const HASH = 'a'.repeat(64);
const CHECK_IN = {
  kind: 'ALIVE',
  campaign: ROOTS,
  treeId: '3001',
  milestone: 2,
  sha256: HASH,
  sizeBytes: 4194304,
  durationSec: 7.2,
  contentType: 'video/webm',
};

const announce = async (body: object, userId = SARI) =>
  request(api.app)
    .post('/api/v1/evidence/upload-url')
    .set(await api.signedIn(userId))
    .send(body);

const rowsWith = async (sha256: string) =>
  (
    await sql<{ n: number }>`select count(*)::int as n from public.submissions
      where video_sha256 = ${sha256}`.execute(test.database)
  ).rows[0]?.n;

// docs/BE/features/evidence.md §2, FR-101–FR-105, FR-132, FR-141, ADR-020.
describe('POST /api/v1/evidence/upload-url', () => {
  it('runs the link prechecks, writes the queued row and answers a 15-minute presigned PUT', async () => {
    const response = await announce(CHECK_IN);
    const { submissionId } = response.body;
    const [row] = (
      await sql<{
        status: string;
        video_path: string;
        profile_id: string;
      }>`select status, video_path, profile_id
        from public.submissions where id = ${submissionId}`.execute(test.database)
    ).rows;

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      submissionId: expect.any(String),
      status: 'queued',
      upload: {
        method: 'PUT',
        url: expect.stringContaining(`/evidence/${row?.profile_id}/${submissionId}.mp4?`),
        headers: {
          'Content-Type': 'video/webm',
          'x-amz-checksum-sha256': Buffer.from(HASH, 'hex').toString('base64'),
        },
        expiresAt: '2026-10-23T03:27:44.000Z',
      },
    });
    expect(response.body.upload.url).toMatch(/X-Amz-Expires=900&/);
    expect(response.body.upload.url).toMatch(
      /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256/,
    );
    expect(row).toMatchObject({
      status: 'queued',
      video_path: `${row?.profile_id}/${submissionId}.mp4`,
    });
  });

  it('the same planter re-announcing the same video gets the same row with a fresh link (FR-132)', async () => {
    const first = await announce({ ...CHECK_IN, sha256: 'b'.repeat(64) });
    const again = await announce({ ...CHECK_IN, sha256: 'b'.repeat(64) });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ submissionId: first.body.submissionId, idempotent: true });
    expect(await rowsWith('b'.repeat(64))).toBe(1);
  });

  it('two announcements racing for one video end in one row', async () => {
    const body = { ...CHECK_IN, sha256: 'c'.repeat(64) };
    const responses = await Promise.all([announce(body), announce(body)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(new Set(responses.map((response) => response.body.submissionId)).size).toBe(1);
  });
});

describe('POST /api/v1/evidence/upload-url refuses', () => {
  it('a video already used for another target is refused, with nothing written', async () => {
    await announce({ ...CHECK_IN, sha256: 'd'.repeat(64) });

    const response = await announce({
      ...CHECK_IN,
      sha256: 'd'.repeat(64),
      kind: 'DEAD',
      milestone: 0,
    });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'precheck_failed',
      details: { reasons: ['duplicate_video'] },
    });
  });

  it.each([
    ['a closed window', { milestone: 3 }, ['milestone_not_open']],
    ['a held month', { treeId: '3104' }, ['milestone_already_done']],
    ['a 3-second video', { durationSec: 3 }, ['video_too_short']],
    ["someone else's tree", { treeId: '3300' }, ['tree_not_owned', 'tag_missing']],
  ])(
    '%s answers 422 precheck_failed with every reason, and writes nothing',
    async (_case, change, reasons) => {
      const sha256 = 'e'.repeat(63) + String(reasons.length);
      const response = await announce({ ...CHECK_IN, ...change, sha256 });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toEqual({ reasons });
      expect(await rowsWith(sha256)).toBe(0);
    },
  );

  it.each([
    ['over 25 MiB', { sizeBytes: 26214401 }, 400, 'validation_error'],
    ['a check-in at milestone 0', { milestone: 0 }, 400, 'validation_error'],
    [
      'a planting naming a tree',
      { kind: 'PLANTED', slotId: '41', milestone: 0 },
      400,
      'validation_error',
    ],
    ['an unknown field', { videoPath: 'x' }, 400, 'validation_error'],
    ['a tree under another campaign', { campaign: `0x${'7'.repeat(40)}` }, 404, 'not_found'],
  ])('%s answers %i', async (_case, change, status, code) => {
    const response = await announce({ ...CHECK_IN, ...change, sha256: 'f'.repeat(64) });

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

const RAKA = 'did:privy:cm2raka0000000000000000';
const AUDITOR = 'did:privy:cm2auditor000000000000';

const detail = async (submissionId: string, userId: string) =>
  request(api.app)
    .get(`/api/v1/evidence/${submissionId}`)
    .set(await api.signedIn(userId));

// docs/BE/features/evidence.md §4, FR-113–FR-118, FR-155, ADR-008, ADR-020.
describe('GET /api/v1/evidence/:submissionId', () => {
  beforeAll(async () => {
    await aProfile(test.database, 'operator', RAKA);
    await sql`update public.submissions set
        keyframe_paths = ${[`${IN_REVIEW}/0.jpg`, `${IN_REVIEW}/1.jpg`]},
        policy_decision = 'needs_review', policy_score = 8550, reject_reasons = '{liveness_borderline}',
        ai_response = ${JSON.stringify({
          submissionId: IN_REVIEW,
          modelVersion: 'treecord-ai-0.1',
          scores: {
            liveness: 0.75,
            recapture: 0.08,
            treePresence: 0.94,
            speciesMatch: 0.71,
            growthConsistency: 0.82,
            duplicate: { maxSimilarity: 0.05, matchedSubmissionId: null },
            challengeVisible: null,
            ndvi: { value: 0.41, source: 'sentinel2-sample', date: '2026-10-01' },
            tagDecoded: 'TC-M3XV-7GPD',
          },
          keyframes: ['raw-keyframe-urls-stay-inside'],
        })}::jsonb
      where id = ${IN_REVIEW}`.execute(test.database);
  });

  it("answers its owner: the record, the AI's scores by known keys, and 15-minute keyframe links", async () => {
    const response = await detail(IN_REVIEW, SARI);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: IN_REVIEW,
      kind: 'ALIVE',
      status: 'needs_review',
      campaign: ROOTS_CAMPAIGN,
      slotId: null,
      treeId: '3104',
      milestone: 2,
      month: 6,
      deviceId: DEVICE_ID,
      rejectReasons: ['liveness_borderline'],
      policyDecision: 'needs_review',
      policyScore: 8550,
      ai: {
        modelVersion: 'treecord-ai-0.1',
        scores: {
          liveness: 0.75,
          duplicate: { maxSimilarity: 0.05, matchedSubmissionId: null },
          ndvi: { value: 0.41, source: 'sentinel2-sample' },
          tagDecoded: 'TC-M3XV-7GPD',
        },
      },
      keyframes: { expiresAt: '2026-10-23T03:27:44.000Z' },
      challenge: null,
      review: null,
      pipeline: { step: 3, failedAt: null },
      txHash: null,
    });
    expect(response.body.ai).not.toHaveProperty('keyframes');
    expect(response.body.keyframes.urls).toHaveLength(2);
    expect(response.body.keyframes.urls[0]).toContain(`/keyframes/${IN_REVIEW}/0.jpg?`);
    expect(response.body.keyframes.urls[0]).toContain('X-Amz-Expires=900&');
    expect(response.body).not.toHaveProperty('error');
  });
});

describe('GET /api/v1/evidence/:submissionId: who reads it', () => {
  it('answers an operator, who alone sees why a failed submission failed (NFR-055)', async () => {
    await sql`update public.submissions set status = 'failed', error = 'AI service unavailable'
      where id = ${IN_REVIEW}`.execute(test.database);

    const owner = await detail(IN_REVIEW, SARI);
    const operator = await detail(IN_REVIEW, RAKA);

    await sql`update public.submissions set status = 'needs_review', error = null
      where id = ${IN_REVIEW}`.execute(test.database);
    expect(operator.status).toBe(200);
    expect(operator.body.error).toBe('AI service unavailable');
    expect(owner.body).not.toHaveProperty('error');
  });

  it('its owner still reads it after switching to donor: ownership decides, not the role', async () => {
    await sql`update public.profiles set role = 'donor' where privy_user_id = ${SARI}`.execute(
      test.database,
    );

    const response = await detail(IN_REVIEW, SARI);

    await sql`update public.profiles set role = 'planter' where privy_user_id = ${SARI}`.execute(
      test.database,
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ['another planter', DEWI, 404, 'not_found'],
    ['a donor', DONOR, 404, 'not_found'],
    [
      'an auditor without the tree in a session (REG-005 with the audit feature)',
      AUDITOR,
      404,
      'not_found',
    ],
  ])('%s gets %i, never 403', async (_case, userId, status, code) => {
    const response = await detail(IN_REVIEW, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('a malformed id is 400 invalid_path; an unknown one 404', async () => {
    expect((await detail('5c1e9a7d', SARI)).body.error.code).toBe('invalid_path');
    expect((await detail('0b6c2f1e-4d8a-4c3b-9e7f-1a2b3c4d5e6f', SARI)).status).toBe(404);
  });
});

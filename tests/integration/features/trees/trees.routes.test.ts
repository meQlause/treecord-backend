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
import {
  ALEX,
  CHECK_IN_EVIDENCE,
  CHECK_IN_TX,
  IN_REVIEW_ID,
  OPEN_FLAG_ID,
  PLANTED_EVIDENCE,
  PLANTED_KEYFRAME,
  PLANTED_TX,
  RAKA,
  ROOTS,
  rootsThatStay,
  SARI,
  SARI_WALLET,
} from '../../../fixtures/roots-that-stay.js';

const PENDING_REASON_HASH = `0x${'96'.repeat(32)}`;

let test: TestDatabase;
let api: TestApi;

const getTree = async (treeId: string, userId?: string) =>
  request(api.app)
    .get(`/api/v1/trees/${treeId}`)
    .set(userId === undefined ? {} : await api.signedIn(userId));

// A 15-minute presigned GET on the public endpoint (ADR-020); the signature changes every second.
const thumbnail = (key: string) =>
  expect.stringMatching(
    new RegExp(
      `^http://127\\.0\\.0\\.1:9000/keyframes/${key}\\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Expires=900&.*X-Amz-Signature=`,
    ),
  );

const milestone = (index: number, month: number, opensAt: string, closesAt: string) => ({
  milestone: index,
  month,
  opensAt,
  closesAt,
});

const SCHEDULE = [
  milestone(0, 0, '2026-04-18T05:00:00.000Z', '2026-05-18T05:00:00.000Z'),
  milestone(1, 3, '2026-07-17T05:00:00.000Z', '2026-08-16T05:00:00.000Z'),
  milestone(2, 6, '2026-10-15T05:00:00.000Z', '2026-11-14T05:00:00.000Z'),
  milestone(3, 12, '2027-04-13T05:00:00.000Z', '2027-05-13T05:00:00.000Z'),
  milestone(4, 24, '2028-04-07T05:00:00.000Z', '2028-05-07T05:00:00.000Z'),
  milestone(5, 36, '2029-04-02T05:00:00.000Z', '2029-05-02T05:00:00.000Z'),
];
const AMOUNTS = ['1050000', '1050000', '1050000', '1575000', '1575000', '4200000'];

// trees §1's signed-out example: tree 3001 at chain time 2026-10-23T03:12:44Z.
const EXAMPLE_3001 = {
  tree: {
    treeId: '3001',
    status: 'alive',
    campaign: {
      address: ROOTS,
      title: 'Roots that stay',
      species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
      region: { name: 'Banyumas, Central Java' },
    },
    slotId: 1,
    planterAddress: SARI_WALLET,
    plantedAt: '2026-04-18T05:00:00.000Z',
    plantedTxHash: PLANTED_TX,
    location: { precision: 'geohash', lat: -7.431564, lon: 109.24736, geohash: 'qqtttzp' },
    tag: 'TC-K7QM-3XRA',
    replantDeadline: null,
  },
  timeline: [
    {
      kind: 'planted',
      at: '2026-04-18T05:00:00.000Z',
      blockNumber: '24118402',
      txHash: PLANTED_TX,
      evidenceHash: PLANTED_EVIDENCE,
      evidence: {
        kind: 'PLANTED',
        milestone: 0,
        month: 0,
        score: 9580,
        thumbnailUrl: thumbnail(PLANTED_KEYFRAME),
      },
    },
    {
      kind: 'check_in',
      at: '2026-07-20T05:00:00.000Z',
      blockNumber: '28136002',
      txHash: CHECK_IN_TX,
      evidenceHash: CHECK_IN_EVIDENCE,
      evidence: {
        kind: 'ALIVE',
        milestone: 1,
        month: 3,
        score: 9230,
        thumbnailUrl: thumbnail('a71d4e0b-6c3f-4b8a-8e2d-5f9c0b1a3d47/0.jpg'),
      },
    },
  ],
  milestones: SCHEDULE.map((window, index) => ({
    ...window,
    amount: AMOUNTS[index],
    status: ['paid', 'paid', 'open', 'upcoming', 'upcoming', 'upcoming'][index],
  })),
  payouts: [
    {
      milestone: 0,
      month: 0,
      amount: '1050000',
      planterAddress: SARI_WALLET,
      at: '2026-04-18T05:00:00.000Z',
      txHash: PLANTED_TX,
    },
    {
      milestone: 1,
      month: 3,
      amount: '1050000',
      planterAddress: SARI_WALLET,
      at: '2026-07-20T05:00:00.000Z',
      txHash: CHECK_IN_TX,
    },
  ],
  forfeits: [],
  summary: {
    milestonesPaid: 2,
    paidAmount: '2100000',
    perTreeIncentive: '10500000',
    currentMilestone: 2,
    currentMonth: 6,
  },
  flags: [],
  viewer: null,
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await rootsThatStay(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/trees.md §1, FR-052–FR-063, at chain time 2026-10-23T03:12:44Z.
describe('GET /api/v1/trees/:treeId signed out', () => {
  it('answers the §1 example for tree 3001', async () => {
    const response = await getTree('3001');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(EXAMPLE_3001);
  });
});

describe('GET /api/v1/trees/:treeId for other trees and bad ids', () => {
  it('a flagged tree pauses its unpaid milestones and lists its open flag (FR-056, FR-058)', async () => {
    const response = await getTree('3091');

    expect(response.body.milestones.map((row: { status: string }) => row.status)).toEqual([
      'paid',
      'paid',
      'paused',
      'paused',
      'paused',
      'paused',
    ]);
    expect(response.body.flags).toEqual([
      {
        id: OPEN_FLAG_ID,
        status: 'open',
        reasonText: 'Tree condition needs an independent check.',
        reasonHash: '0xc29baac38459527c791a529ef47d1cc43d3734cef04e63520492971274b411cb',
        resolutionNote: null,
        openedAt: '2026-10-20T09:14:27.000Z',
        openedTxHash: '0x1ce442d81b6082fbb178e08bddf5191b38417d30caae1a738e505a3a3303314c',
        resolvedAt: null,
        resolvedTxHash: null,
      },
    ]);
  });

  it.each([
    ['zero', '0', 400, 'invalid_path'],
    ['not a number', '30x1', 400, 'invalid_path'],
    ['past bigint', '9223372036854775808', 400, 'invalid_path'],
    ['a tree that does not exist', '424242', 404, 'not_found'],
  ])('%s answers its error', async (_case, treeId, status, code) => {
    const response = await getTree(treeId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

describe('GET /api/v1/trees/:treeId signed in', () => {
  it('the planter sees the exact location and cannot flag her own tree', async () => {
    const response = await getTree('3001', SARI);

    expect(response.body.tree.location).toEqual({
      precision: 'exact',
      lat: -7.431205,
      lon: 109.247813,
      geohash: 'qqtttzp',
    });
    expect(response.body.viewer).toEqual({
      isPlanter: true,
      liveSubmissions: [],
      flag: { eligible: false, blockedBy: 'not_contributor' },
      pendingFlag: null,
    });
  });

  it('the planter sees her check-in in review on 3104 (FR-063)', async () => {
    expect((await getTree('3104', SARI)).body.viewer.liveSubmissions).toEqual([
      { id: IN_REVIEW_ID, kind: 'ALIVE', milestone: 2, month: 6, status: 'needs_review' },
    ]);
  });

  it("a contributor may flag, sees his own pending flag, and the cell's centre only", async () => {
    await sql`insert into public.flags (tree_id, campaign_address, flagger_address, flagger_profile_id, reason_text,
        reason_hash, created_at)
      select 3001, ${ROOTS}, wallet_address, id, 'Reason saved; wallet transaction has not been confirmed.',
        ${PENDING_REASON_HASH}, '2026-10-22T08:41:09.330Z' from public.profiles where privy_user_id = ${ALEX}`.execute(
      test.database,
    );

    const response = await getTree('3001', ALEX);

    expect(response.body.tree.location.precision).toBe('geohash');
    expect(response.body.flags).toEqual([]);
    expect(response.body.viewer).toMatchObject({
      isPlanter: false,
      flag: { eligible: true, blockedBy: null },
      pendingFlag: {
        reasonText: 'Reason saved; wallet transaction has not been confirmed.',
        reasonHash: PENDING_REASON_HASH,
        createdAt: '2026-10-22T08:41:09.330Z',
      },
    });
  });

  it('an operator sees the exact location; a flagged tree is not flaggable', async () => {
    const operator = await getTree('3091', RAKA);

    expect(operator.body.tree.location.precision).toBe('exact');
    expect((await getTree('3091', ALEX)).body.viewer.flag).toEqual({
      eligible: false,
      blockedBy: 'tree_not_flaggable',
    });
  });

  it('a token that fails verification is 401 invalid_token', async () => {
    const response = await request(api.app)
      .get('/api/v1/trees/3001')
      .set('Authorization', 'Bearer not-a-jwt');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });
});

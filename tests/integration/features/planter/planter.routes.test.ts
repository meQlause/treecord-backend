import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy, type FakePrivy } from '../../../helpers/fake-privy.js';
import { aCampaign, aProfile } from '../../../fixtures/mirror.js';
import {
  CHALLENGE_3001,
  CHALLENGE_3104,
  DEVICE_ID,
  IN_REVIEW,
  planterWorkspace,
  PLANTING,
  REJECTED,
  ROOTS,
  SARI,
  SARI_WALLET,
} from '../../../fixtures/planter-workspace.js';

// planter.md §1's chain time
const CHAIN_TIME = new Date('2026-10-23T09:12:31Z');
const ROOTS_ITEM = {
  address: ROOTS,
  title: 'Roots that stay',
  regionName: 'Banyumas, Central Java',
};
const NO_WALLET = 'did:privy:cm2nowallet00000000000';
const DONOR = 'did:privy:cm2alex0000000000000000';

let test: TestDatabase;
let privy: FakePrivy;
let api: TestApi;

const get = async (path: string, userId = SARI) =>
  request(api.app)
    .get(`/api/v1/planter${path}`)
    .set(await api.signedIn(userId));

const MONTHS = [0, 3, 6, 12, 24, 36];
const AMOUNTS = ['1050000', '1050000', '1050000', '1575000', '1575000', '4200000'];

const window = (milestone: number, state: string, [opensAt, closesAt]: [string, string]) => ({
  milestone,
  month: MONTHS[milestone],
  amount: AMOUNTS[milestone],
  state,
  opensAt,
  closesAt,
});

// planter.md §1's tree 3001.
const TREE_3001 = {
  treeId: '3001',
  status: 'alive',
  campaign: { ...ROOTS_ITEM, speciesName: 'Mahogany' },
  slotId: '1',
  plantedAt: '2026-04-18T05:00:00.000Z',
  replantDeadline: null,
  tag: 'TC-K7QM-3XRA',
  currentMilestone: 2,
  milestones: [
    window(0, 'paid', ['2026-04-18T05:00:00.000Z', '2026-05-18T05:00:00.000Z']),
    window(1, 'paid', ['2026-07-17T05:00:00.000Z', '2026-08-16T05:00:00.000Z']),
    window(2, 'open', ['2026-10-15T05:00:00.000Z', '2026-11-14T05:00:00.000Z']),
    window(3, 'upcoming', ['2027-04-13T05:00:00.000Z', '2027-05-13T05:00:00.000Z']),
    window(4, 'upcoming', ['2028-04-07T05:00:00.000Z', '2028-05-07T05:00:00.000Z']),
    window(5, 'upcoming', ['2029-04-02T05:00:00.000Z', '2029-05-02T05:00:00.000Z']),
  ],
  capture: {
    ALIVE: { allowed: true, reasons: [], held: null },
    DEAD: { allowed: true, reasons: [], held: null },
    REPLANTED: { allowed: false, reasons: ['wrong_tree_status'], held: null },
  },
  openChallenge: { id: CHALLENGE_3001, code: 'R4M9', expiresAt: '2026-12-20T04:00:00.000Z' },
};

const HELD_3104 = {
  id: IN_REVIEW,
  status: 'needs_review',
  milestone: 2,
  month: 6,
  deviceId: DEVICE_ID,
};

const upload = (fields: object) => ({ campaign: ROOTS_ITEM, deviceId: DEVICE_ID, ...fields });

// planter.md §4's example.
const UPLOADS = {
  items: [
    upload({
      id: IN_REVIEW,
      kind: 'ALIVE',
      milestone: 2,
      month: 6,
      status: 'needs_review',
      slotId: null,
      treeId: '3104',
      capturedAt: '2026-10-18T07:05:00.000Z',
      uploadBy: '2026-10-21T07:05:00.000Z',
      durationSec: 7,
      accM: 8.4,
      pipeline: { step: 3, failedAt: null },
      rejection: null,
    }),
    upload({
      id: REJECTED,
      kind: 'ALIVE',
      milestone: 2,
      month: 6,
      status: 'rejected',
      slotId: null,
      treeId: '3001',
      capturedAt: '2026-10-17T06:40:00.000Z',
      uploadBy: '2026-10-20T06:40:00.000Z',
      durationSec: 6,
      accM: 41,
      pipeline: { step: 2, failedAt: 'prechecks' },
      rejection: {
        stage: 'precheck',
        reasons: [{ reason: 'gps_inaccurate', value: '341.0 m' }],
        note: null,
      },
    }),
    upload({
      id: PLANTING,
      kind: 'PLANTED',
      milestone: 0,
      month: 0,
      status: 'onchain',
      slotId: '1',
      treeId: '3001',
      capturedAt: '2026-04-18T05:12:00.000Z',
      uploadBy: '2026-04-21T05:12:00.000Z',
      durationSec: 8,
      accM: 6.2,
      pipeline: { step: 5, failedAt: null },
      rejection: null,
    }),
  ],
  nextCursor: null,
  total: 3,
  summary: { all: 3, sent: 2, rejected: 1 },
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
  api = testApi(test.database, privy, { chainNow: async () => CHAIN_TIME });
  await planterWorkspace(test.database);
  await aProfile(test.database, 'planter', NO_WALLET);
  await aProfile(test.database, 'donor', DONOR, `0x${'c'.repeat(40)}`);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/planter.md §1, FR-080–FR-083.
describe('GET /api/v1/planter/trees', () => {
  it("answers the §1 example: tree 3001 first of Sari's five Alive trees", async () => {
    const response = await get('/trees?status=alive&limit=1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [TREE_3001],
      nextCursor: 'eyJ0IjoiMzAwMSJ9',
      total: 5,
      summary: {
        treeCount: 8,
        survivalPct: 87.5,
        flaggedCount: 2,
        setAsideAmount: '84000000',
        paidAmount: '18900000',
        openCheckIns: 2,
      },
      chainTime: '2026-10-23T09:12:31.000Z',
    });
  });

  it('a check-in in review holds the month; a flagged tree is paused and cannot be checked in', async () => {
    const { items } = (await get('/trees?limit=100')).body;
    const byId = (treeId: string) =>
      items.find((item: { treeId: string }) => item.treeId === treeId);

    expect(byId('3104').capture.ALIVE).toEqual({
      allowed: false,
      reasons: ['milestone_already_done'],
      held: HELD_3104,
    });
    expect(byId('3091').milestones[2].state).toBe('paused');
    expect(byId('3091').capture.ALIVE.reasons).toEqual(['wrong_tree_status']);
    expect(byId('3100').capture.REPLANTED.reasons).toEqual(['replant_deadline_passed']);
  });
});

// docs/BE/features/planter.md §2, §5, FR-084–FR-086.
describe('GET /api/v1/planter/slots', () => {
  it('answers the §2 example: the claimed slot and the anchor slot, each with its tag', async () => {
    const slot = (slotId: string, kind: string, status: string, code: string) => ({
      campaign: { ...ROOTS_ITEM, status: 'active', regionRadiusM: 2500, speciesName: 'Mahogany' },
      slotId,
      kind,
      status,
      claimedAt: '2026-10-20T02:11:09.000Z',
      tag: { code, issuedAt: '2026-10-20T02:14:52.318Z' },
      capture: { allowed: true, reasons: [], held: null },
    });

    expect((await get('/slots')).body).toEqual({
      items: [
        slot('41', 'open', 'claimed', 'TC-B2YK-5ZWN'),
        slot('42', 'anchor', 'anchor', 'TC-R7DH-8QEX'),
      ],
      nextCursor: null,
      total: 2,
    });
  });

  it('issues one tag to a new slot, even when two first loads race', async () => {
    const other = `0x${'7'.repeat(40)}`;

    await aCampaign(test.database, { address: other, status: 'active' });
    await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address, claimed_at)
      values (${other}, 7, 'open', 'claimed', ${SARI_WALLET}, now())`.execute(test.database);

    const [first, second] = await Promise.all([get('/slots'), get('/slots')]);
    const tagOf = (body: { items: { slotId: string; tag: { code: string } }[] }) =>
      body.items.find((item) => item.slotId === '7')?.tag.code;
    const stored = await sql<{ n: number }>`select count(*)::int as n from public.slot_tags
      where campaign_address = ${other}`.execute(test.database);

    expect(tagOf(first.body)).toMatch(/^TC-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(tagOf(second.body)).toBe(tagOf(first.body));
    expect(stored.rows[0]?.n).toBe(1);
  });
});

// docs/BE/features/planter.md §3, FR-091–FR-093.
describe('GET /api/v1/planter/challenges', () => {
  it('lists open challenges soonest first, then by id; the one held by a review is not answerable', async () => {
    const response = await get('/challenges');
    const tree = (treeId: string, tag: string) => ({
      treeId,
      status: 'alive',
      tag,
      currentMilestone: 2,
      month: 6,
      campaign: ROOTS_ITEM,
    });

    expect(response.body).toEqual({
      items: [
        {
          id: CHALLENGE_3104,
          code: 'T2X8',
          qr: 'TCH-T2X8',
          issuedAt: '2026-10-21T04:00:00.000Z',
          expiresAt: '2026-12-20T04:00:00.000Z',
          tree: tree('3104', 'TC-M3XV-7GPD'),
          capture: { allowed: false, reasons: ['milestone_already_done'], held: HELD_3104 },
        },
        {
          id: CHALLENGE_3001,
          code: 'R4M9',
          qr: 'TCH-R4M9',
          issuedAt: '2026-10-21T04:00:00.000Z',
          expiresAt: '2026-12-20T04:00:00.000Z',
          tree: tree('3001', 'TC-K7QM-3XRA'),
          capture: { allowed: true, reasons: [], held: null },
        },
      ],
      nextCursor: null,
      total: 2,
      summary: { answerable: 1 },
    });
  });

  it('pages by cursor', async () => {
    const first = await get('/challenges?limit=1');
    const second = await get(`/challenges?limit=1&cursor=${first.body.nextCursor}`);

    expect([first.body.items[0].id, second.body.items[0].id]).toEqual([
      CHALLENGE_3104,
      CHALLENGE_3001,
    ]);
    expect(second.body.nextCursor).toBeNull();
  });
});

// docs/BE/features/planter.md §4, FR-108–FR-112.
describe('GET /api/v1/planter/uploads', () => {
  it('answers the §4 example: queued rows stay in the browser', async () => {
    expect((await get('/uploads')).body).toEqual(UPLOADS);
  });

  it('filters and pages', async () => {
    expect(
      (await get('/uploads?filter=rejected')).body.items.map((item: { id: string }) => item.id),
    ).toEqual([REJECTED]);

    const first = await get('/uploads?limit=2');
    const rest = await get(`/uploads?limit=2&cursor=${first.body.nextCursor}`);

    expect(rest.body.items.map((item: { id: string }) => item.id)).toEqual([PLANTING]);
  });

  it('needs no wallet', async () => {
    expect((await get('/uploads', NO_WALLET)).body).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
      summary: { all: 0, sent: 0, rejected: 0 },
    });
  });
});

describe('the planter lists refuse', () => {
  it.each([
    ['/trees', NO_WALLET, 403, 'wallet_missing'],
    ['/slots', NO_WALLET, 403, 'wallet_missing'],
    ['/challenges', NO_WALLET, 403, 'wallet_missing'],
    ['/trees', DONOR, 403, 'forbidden_role'],
    ['/uploads', DONOR, 403, 'forbidden_role'],
    ['/trees?status=lost', SARI, 400, 'validation_error'],
    ['/slots?all=1', SARI, 400, 'validation_error'],
    ['/uploads?filter=waiting', SARI, 400, 'validation_error'],
    ['/trees?cursor=nope', SARI, 400, 'invalid_cursor'],
  ])('%s for %s answers %i %s', async (path, userId, status, code) => {
    const response = await get(path, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

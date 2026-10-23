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

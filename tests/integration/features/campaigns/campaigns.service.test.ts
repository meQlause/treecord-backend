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
import { aCampaign, aProfile, theSpecies } from '../../../fixtures/mirror.js';

const address = (index: number): string => `0x${index.toString(16).padStart(40, '0')}`;
const ROOTS = address(3);
const FUNDING = address(1);
const CLOSED = address(4);
const SMALL = address(5);
const CAPPED = address(6);
const ALEX = 'did:privy:cm2alex0000000000000000';
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const DEWI = 'did:privy:cm2dewi0000000000000000';
const NO_WALLET = 'did:privy:cm2nowallet00000000000';

const DEMAK_METADATA = {
  title: 'A new tide for Demak',
  description: '',
  speciesCode: 'RHIZOPHORA_MUCRONATA',
  regionName: 'Demak, Central Java',
  regionCenter: { lat: -6.894, lon: 110.638 },
  regionRadiusM: 2500,
  imageUrls: [],
};

let test: TestDatabase;
let api: TestApi;

const post = async (path: string, body: object, userId: string, key?: string) =>
  request(api.app)
    .post(`/api/v1${path}`)
    .set({
      ...(await api.signedIn(userId)),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    })
    .send(body);

const claim = (campaign: string, count: number, key?: string, userId = SARI) =>
  post(`/campaigns/${campaign}/claims`, { count }, userId, key);

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await theSpecies(test.database);
  await aCampaign(test.database, { address: ROOTS, status: 'active' });
  await aCampaign(test.database, { address: FUNDING });
  await aCampaign(test.database, {
    address: CLOSED,
    status: 'active',
    claim_deadline: new Date('2026-10-01T00:00:00Z'),
  });
  await aCampaign(test.database, {
    address: SMALL,
    status: 'active',
    anchor_slots: 8,
    open_slots: 2,
    tree_target: 10,
  });
  await aCampaign(test.database, { address: CAPPED, status: 'active', per_planter_cap: 3 });
  await aProfile(test.database, 'donor', ALEX, `0x${'a'.repeat(40)}`);
  await aProfile(test.database, 'planter', SARI, SARI_WALLET);
  await aProfile(test.database, 'planter', DEWI, `0x${'d'.repeat(40)}`);
  await aProfile(test.database, 'planter', NO_WALLET);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/campaigns.md §4–§5, FR-076–FR-079.
describe('campaign metadata', () => {
  it('saves the S14 metadata and answers its id and the URI the factory stores; the URI resolves to it', async () => {
    const saved = await post('/campaigns/metadata', DEMAK_METADATA, ALEX);

    expect(saved.status).toBe(201);
    expect(saved.body).toEqual({
      id: expect.any(String),
      metadataURI: `http://localhost:3001/api/v1/campaigns/metadata/${saved.body.id}`,
    });

    const resolved = await request(api.app).get(`/api/v1/campaigns/metadata/${saved.body.id}`);

    expect(resolved.body).toEqual({
      id: saved.body.id,
      title: 'A new tide for Demak',
      description: '',
      species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
      region: { name: 'Demak, Central Java', center: { lat: -6.894, lon: 110.638 }, radiusM: 2500 },
      imageUrls: [],
      createdAt: expect.any(String),
    });
  });

  it.each([
    ['an unknown species', { speciesCode: 'BAOBAB' }, 'speciesCode'],
    ['a server-owned field', { id: '7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a' }, 'id'],
    ['a two-letter title', { title: 'Hi' }, 'title'],
    ['a radius under 100 m', { regionRadiusM: 99 }, 'regionRadiusM'],
    ['a non-http image', { imageUrls: ['data:image/png;base64,AA=='] }, 'imageUrls.0'],
  ])('%s answers 400 validation_error at its field', async (_case, change, path) => {
    const response = await post('/campaigns/metadata', { ...DEMAK_METADATA, ...change }, ALEX);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('a planter may not save metadata (FR-076); a bad or unknown id does not resolve', async () => {
    expect((await post('/campaigns/metadata', DEMAK_METADATA, SARI)).body.error.code).toBe(
      'forbidden_role',
    );
    expect(
      (await request(api.app).get('/api/v1/campaigns/metadata/7d5c9b8e')).body.error.code,
    ).toBe('invalid_path');
    expect(
      (
        await request(api.app).get(
          '/api/v1/campaigns/metadata/7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a',
        )
      ).status,
    ).toBe(404);
  });
});

// docs/BE/features/campaigns.md §6, FR-050, FR-051, jobs.md §3.
describe('POST /api/v1/campaigns/:address/claims', () => {
  it('queues a claim job for the planter wallet: 202 { job }', async () => {
    const response = await claim(ROOTS, 2, 'd06-claim-1');
    const [stored] = (
      await sql<{
        payload: object;
        created_by_profile_id: string;
      }>`select payload, created_by_profile_id
        from public.relayer_jobs where id = ${response.body.job.id}`.execute(test.database)
    ).rows;

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({
      kind: 'claim',
      status: 'pending',
      attempts: 0,
      txHash: null,
    });
    expect(stored?.payload).toEqual({ campaign: ROOTS, planter: SARI_WALLET, count: 2 });
  });

  it('the same key again: 200 with the original job; another planter with it: 409 (ADR-009)', async () => {
    const first = await claim(ROOTS, 1, 'd06-claim-2');
    const again = await claim(ROOTS, 5, 'd06-claim-2');
    const stolen = await claim(ROOTS, 1, 'd06-claim-2', DEWI);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ job: first.body.job, idempotent: true });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('idempotency_key_reused');
  });

  it('a failed claim repeated with its key is re-armed: 202, the same id, the new count (FR-028)', async () => {
    const first = await claim(ROOTS, 1, 'd06-claim-3');

    await sql`update public.relayer_jobs set status = 'failed' where id = ${first.body.job.id}`.execute(
      test.database,
    );

    const rearmed = await claim(ROOTS, 2, 'd06-claim-3');

    expect(rearmed.status).toBe(202);
    expect(rearmed.body.job).toMatchObject({ id: first.body.job.id, status: 'pending' });
  });

  it('a retried claim that already succeeded gets its job, not planter_cap_exceeded (jobs R2)', async () => {
    const first = await claim(CAPPED, 3, 'd06-claim-cap');
    const again = await claim(CAPPED, 3, 'd06-claim-cap');

    expect(first.status).toBe(202);
    expect(again.status).toBe(200);
  });
});

describe('POST /api/v1/campaigns/:address/claims refuses', () => {
  it.each([
    {
      name: 'a campaign still funding',
      campaign: FUNDING,
      count: 1,
      code: 'campaign_not_active',
      details: { status: 'funding' },
    },
    {
      name: 'past the claim deadline',
      campaign: CLOSED,
      count: 1,
      code: 'claim_window_closed',
      details: { claimDeadline: '2026-10-01T00:00:00.000Z' },
    },
    {
      name: 'more than the open slots',
      campaign: SMALL,
      count: 3,
      code: 'not_enough_slots',
      details: { available: 2 },
    },
  ])('$name with 409 and nothing queued', async ({ campaign, count, code, details }) => {
    const key = `refused-${code}`;
    const response = await claim(campaign, count, key);
    const queued = await sql<{ n: number }>`select count(*)::int as n from public.relayer_jobs
      where idempotency_key = ${key}`.execute(test.database);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code, details });
    expect(queued.rows[0]?.n).toBe(0);
  });

  it('beyond the planter cap, counting the claims already queued', async () => {
    const response = await claim(CAPPED, 1, undefined, SARI);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'planter_cap_exceeded',
      details: { remaining: 0, cap: 3 },
    });
  });

  it.each([
    { name: 'a count of 0', body: { count: 0 }, status: 400, code: 'validation_error' },
    { name: 'a reserved key', key: 'score:abc', status: 400, code: 'invalid_idempotency_key' },
    { name: 'a malformed address', campaign: '0x12', status: 400, code: 'invalid_path' },
    { name: 'a donor', userId: ALEX, status: 403, code: 'forbidden_role' },
    { name: 'a planter without a wallet', userId: NO_WALLET, status: 403, code: 'wallet_missing' },
    { name: 'an unknown campaign', campaign: address(99), status: 404, code: 'not_found' },
  ])(
    '$name answers $status',
    async ({ campaign = ROOTS, body = { count: 1 }, userId = SARI, key, status, code }) => {
      const response = await post(`/campaigns/${campaign}/claims`, body, userId, key);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});

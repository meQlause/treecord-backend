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
import { aCampaign, aJob, aProfile, theSpecies } from '../../../fixtures/mirror.js';

const address = (index: number): string => `0x${index.toString(16).padStart(40, '0')}`;
const DEMAK = address(1);
const SENGON = address(2);
const ALEX = 'did:privy:cm2alex0000000000000000';
const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';
const CONTRIBUTION_TX = `0x${'2'.repeat(64)}`;
// 21 completed Mahogany campaigns, enough for a second page at the default limit.
const MAHOGANY_COUNT = 21;

let test: TestDatabase;
let api: TestApi;
let sari: string;

const get = (path: string) => request(api.app).get(`/api/v1${path}`);

// The mockup's catalog around the §1 example: seven Funding campaigns (Demak and Sengon newest), others in other
// states, one created on-chain without metadata, and the Mahogany pile for paging.
const seedCatalog = async (database: TestDatabase['database']): Promise<void> => {
  await theSpecies(database);
  await aCampaign(database, {
    address: DEMAK,
    chain_id: 84532,
    title: 'A new tide for Demak',
    species_code: 'RHIZOPHORA_MUCRONATA',
    region_name: 'Demak, Central Java',
    funded_amount: '6840000000',
    created_block: '29104500',
  });
  await aCampaign(database, {
    address: SENGON,
    title: 'Room for a forest',
    species_code: 'FALCATARIA_FALCATA',
    region_name: 'Sukabumi, West Java',
    tree_target: 800,
    anchor_slots: 200,
    open_slots: 600,
    funding_target: '8000000000',
    funded_amount: '4200000000',
    funding_deadline: new Date('2026-11-16T00:00:00.000Z'),
    created_block: '29104480',
  });
  await aCampaign(database, { address: address(3), status: 'active', created_block: '29104490' });

  for (const index of [4, 5, 6, 7, 8]) {
    await aCampaign(database, { address: address(index), created_block: String(29104400 - index) });
  }

  await aCampaign(database, {
    address: address(9),
    status: 'refunding',
    region_name: 'Plot 507',
    created_block: '20',
  });
  await aCampaign(database, {
    address: address(10),
    status: 'completed',
    region_name: 'Plot 50% shade',
    created_block: '21',
  });

  for (let index = 0; index < MAHOGANY_COUNT; index += 1) {
    await aCampaign(database, {
      address: address(100 + index),
      status: 'completed',
      species_code: 'SWIETENIA_MACROPHYLLA',
      created_block: String(1000 + index),
    });
  }
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await seedCatalog(test.database);
  await aProfile(test.database, 'donor', ALEX, ALEX_WALLET);
  sari = await aProfile(test.database, 'planter', SARI, SARI_WALLET);
  await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
      block_number, block_time, log_index, tx_hash)
    values (${DEMAK}, ${ALEX_WALLET}, 250000000, 250000000, 29104600, now(), 0, ${CONTRIBUTION_TX})`.execute(
    test.database,
  );
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/campaigns.md §1, FR-030–FR-034.
describe('GET /api/v1/campaigns', () => {
  it('answers the §1 example: two of seven Funding campaigns, newest first', async () => {
    const response = await get('/campaigns?status=funding&limit=2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          address: DEMAK,
          status: 'funding',
          title: 'A new tide for Demak',
          species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
          region: { name: 'Demak, Central Java' },
          treeTarget: 1000,
          commitmentUnits: 36,
          fundingTarget: '10000000000',
          fundedAmount: '6840000000',
          progressBps: 6840,
          fundingDeadline: '2026-11-10T00:00:00.000Z',
          daysLeft: 18,
          fundingDeadlinePassed: false,
        },
        {
          address: SENGON,
          status: 'funding',
          title: 'Room for a forest',
          species: { code: 'FALCATARIA_FALCATA', name: 'Sengon' },
          region: { name: 'Sukabumi, West Java' },
          treeTarget: 800,
          commitmentUnits: 36,
          fundingTarget: '8000000000',
          fundedAmount: '4200000000',
          progressBps: 5250,
          fundingDeadline: '2026-11-16T00:00:00.000Z',
          daysLeft: 24,
          fundingDeadlinePassed: false,
        },
      ],
      nextCursor:
        'eyJiIjoiMjkxMDQ0ODAiLCJhIjoiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAyIn0',
      total: 7,
    });
  });

  it('the cursor continues where the page ended, and the last page has none', async () => {
    const first = await get('/campaigns?status=funding&limit=2');
    const rest = await get(`/campaigns?status=funding&limit=5&cursor=${first.body.nextCursor}`);

    expect(rest.body.items.map((item: { address: string }) => item.address)).toEqual(
      [4, 5, 6, 7, 8].map(address),
    );
    expect(rest.body.nextCursor).toBeNull();
    expect(rest.body.total).toBe(7);
  });

  it('pages default to 20 and accept up to 100', async () => {
    const byDefault = await get('/campaigns?species=SWIETENIA_MACROPHYLLA');
    const atCap = await get('/campaigns?species=SWIETENIA_MACROPHYLLA&limit=100');

    expect(byDefault.body.items).toHaveLength(20);
    expect(byDefault.body.nextCursor).not.toBeNull();
    expect(atCap.body.items).toHaveLength(MAHOGANY_COUNT);
    expect(atCap.body.nextCursor).toBeNull();
  });
});

describe('GET /api/v1/campaigns filters', () => {
  it('a campaign created without metadata has no title, species or region name', async () => {
    const response = await get('/campaigns?status=active');

    expect(response.body.items[0]).toMatchObject({
      address: address(3),
      title: null,
      species: null,
      region: { name: null },
      daysLeft: null,
      fundingDeadlinePassed: false,
    });
  });

  it('filters the region by case-insensitive substring, with % taken literally', async () => {
    const demak = await get('/campaigns?region=demak');
    const percent = await get(`/campaigns?region=${encodeURIComponent('50%')}`);

    expect(demak.body.items.map((item: { address: string }) => item.address)).toEqual([DEMAK]);
    expect(percent.body.items.map((item: { address: string }) => item.address)).toEqual([
      address(10),
    ]);
  });
});

describe('GET /api/v1/campaigns refuses', () => {
  it('a cursor that does not decode with 400 invalid_cursor', async () => {
    const response = await get('/campaigns?cursor=not-a-cursor');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_cursor');
  });

  it.each([
    ['a limit over 100', '?limit=101'],
    ['a limit of 0', '?limit=0'],
    ['an unknown status', '?status=draft'],
    ['a malformed species', '?species=mahogany'],
    ['a blank region', '?region=%20%20'],
    ['an unknown parameter', '?sort=newest'],
  ])('%s with 400 validation_error', async (_case, query) => {
    const response = await get(`/campaigns${query}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});

// docs/BE/features/campaigns.md §2, FR-035–FR-042, FR-050.
describe('GET /api/v1/campaigns/:address', () => {
  it('answers the §2 example to Alex, who gave 250 USDC', async () => {
    const response = await get(`/campaigns/${DEMAK}`).set(await api.signedIn(ALEX));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      campaign: {
        address: DEMAK,
        chainId: 84532,
        status: 'funding',
        title: 'A new tide for Demak',
        species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
        region: { name: 'Demak, Central Java', radiusM: 2500 },
        treeTarget: 1000,
        commitmentUnits: 36,
        fundingTarget: '10000000000',
        fundedAmount: '6840000000',
        progressBps: 6840,
        fundingDeadline: '2026-11-10T00:00:00.000Z',
        claimDeadline: '2026-12-10T00:00:00.000Z',
        daysLeft: 18,
        fundingDeadlinePassed: false,
        claimDeadlinePassed: false,
        split: {
          incentivesBps: 7000,
          seedlingsBps: 1000,
          verificationBps: 500,
          reserveBps: 1000,
          feeBps: 500,
        },
        budget: [
          { bucket: 'incentives', bps: 7000, amount: '7000000000' },
          { bucket: 'seedlings', bps: 1000, amount: '1000000000' },
          { bucket: 'verification', bps: 500, amount: '500000000' },
          { bucket: 'reserve', bps: 1000, amount: '1000000000' },
          { bucket: 'fee', bps: 500, amount: '500000000' },
        ],
        incentiveSchedule: [
          { milestone: 0, month: 0, bps: 1000 },
          { milestone: 1, month: 3, bps: 1000 },
          { milestone: 2, month: 6, bps: 1000 },
          { milestone: 3, month: 12, bps: 1500 },
          { milestone: 4, month: 24, bps: 1500 },
          { milestone: 5, month: 36, bps: 4000 },
        ],
        slots: { anchor: 250, open: 750, planted: 0, openAvailable: 750 },
      },
      viewer: {
        role: 'donor',
        walletAddress: ALEX_WALLET,
        contributedAmount: '250000000',
        refundedAmount: '0',
        claim: null,
      },
    });
  });
});

describe('GET /api/v1/campaigns/:address with and without a token', () => {
  it('without a token the page renders and viewer is null; the address is read in any case', async () => {
    const response = await get(`/campaigns/0x${address(10).slice(2).toUpperCase()}`);

    expect(response.status).toBe(200);
    expect(response.body.campaign.address).toBe(address(10));
    expect(response.body.viewer).toBeNull();
  });

  it('a planter sees their cap less the slot they hold and their queued claim (D06)', async () => {
    await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
      values (${SENGON}, 41, 'open', 'claimed', ${SARI_WALLET})`.execute(test.database);
    const job = await aJob(test.database, sari, {
      payload: { campaign: SENGON, planter: SARI_WALLET, count: 2 },
    });

    const response = await get(`/campaigns/${SENGON}`).set(await api.signedIn(SARI));

    expect(response.body.campaign.slots).toEqual({
      anchor: 200,
      open: 600,
      planted: 0,
      openAvailable: 597,
    });
    expect(response.body.viewer.claim).toEqual({ cap: 50, remainingCap: 47, queuedJobId: job });
  });

  it('a token that fails verification is 401 invalid_token, not an anonymous page', async () => {
    const response = await get(`/campaigns/${DEMAK}`).set('Authorization', 'Bearer not-a-jwt');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });

  it.each([
    ['an address that is not one', '/campaigns/0x123', 400, 'invalid_path'],
    ['a campaign the mirror does not have yet', `/campaigns/${address(999)}`, 404, 'not_found'],
  ])('%s', async (_case, path, status, code) => {
    const response = await get(path);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

// docs/BE/features/campaigns.md §3, FR-032, FR-077.
describe('GET /api/v1/species', () => {
  it('answers the §3 example, by English name', async () => {
    const response = await get('/species');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        { code: 'PERSEA_AMERICANA', name: 'Avocado' },
        { code: 'DURIO_ZIBETHINUS', name: 'Durian' },
        { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
        { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
        { code: 'FALCATARIA_FALCATA', name: 'Sengon' },
      ],
      nextCursor: null,
      total: 5,
    });
  });

  it('refuses any query parameter with 400 validation_error', async () => {
    expect((await get('/species?limit=5')).body.error.code).toBe('validation_error');
  });
});

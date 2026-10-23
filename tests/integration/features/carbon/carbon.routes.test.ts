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
import {
  ALEX,
  ALEX_WALLET,
  BATCH_101_TX,
  BATCH_102_TX,
  carbonMarket,
  CERTIFICATE_HOLDER,
  FOREST,
  MANGROVES,
  NO_WALLET,
  RETIREMENT_1_TX,
  RETIREMENT_2_TX,
  ROOTS,
  SARI,
} from '../../../fixtures/carbon-market.js';

let test: TestDatabase;
let privy: FakePrivy;
let api: TestApi;

const MANGROVES_CARD = {
  address: MANGROVES,
  title: 'Back to the mangroves',
  region: 'Cilacap, Central Java',
  species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
};

// carbon.md §2's batch 101. `url` is null: the local chain has no explorer (carbon.md shared values).
const BATCH_101 = {
  batchId: '101',
  label: 'issued',
  campaign: MANGROVES_CARD,
  registry: 'SRN PPI',
  vintage: 2025,
  serialStart: 'SRN-2025-00001',
  serialEnd: 'SRN-2025-16000',
  issuedAmount: '16000',
  inventoryAmount: '8400',
  usdcPerTonne: '18500000',
  availability: 'available',
  issuedAt: '2026-09-12T08:00:00.000Z',
  issuedTx: { hash: BATCH_101_TX, url: null },
};

const BATCH_102 = {
  batchId: '102',
  label: 'issued',
  campaign: {
    address: FOREST,
    title: 'A forest, together',
    region: 'Magelang, Central Java',
    species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
  },
  registry: 'Verra',
  vintage: 2025,
  serialStart: 'VCS-2025-00001',
  serialEnd: 'VCS-2025-24000',
  issuedAmount: '24000',
  inventoryAmount: '12500',
  usdcPerTonne: '22000000',
  availability: 'available',
  issuedAt: '2026-09-18T08:00:00.000Z',
  issuedTx: { hash: BATCH_102_TX, url: null },
};

const ALEX_RETIREMENT = {
  retirementId: '2',
  batchId: '101',
  registry: 'SRN PPI',
  amount: '400',
  beneficiary: 'PT Hijau Lestari',
  purpose: '2026 scope 3 offset',
  retiredAt: '2026-09-20T08:00:00.000Z',
  txHash: RETIREMENT_2_TX,
  registryRetirement: { status: 'pending', reference: null },
};

// carbon.md §3's holdings for Alex.
const ALEX_HOLDINGS = {
  wallet: ALEX_WALLET,
  summary: {
    issuedAmount: '1200',
    allocatedAmount: '1600',
    unfilledAmount: '933',
    retiredAmount: '400',
  },
  reservations: [
    {
      campaign: MANGROVES_CARD,
      label: 'pre-certification',
      reservedAmount: '2000',
      allocatedAmount: '1600',
      unfilledAmount: '400',
      declined: false,
      updatedAt: '2026-09-18T08:00:00.000Z',
    },
    {
      campaign: {
        address: ROOTS,
        title: 'Roots that stay',
        region: 'Banyumas, Central Java',
        species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
      },
      label: 'pre-certification',
      reservedAmount: '533',
      allocatedAmount: '0',
      unfilledAmount: '533',
      declined: false,
      updatedAt: '2026-09-18T08:00:00.000Z',
    },
  ],
  balances: [
    {
      batchId: '101',
      label: 'issued',
      campaign: {
        address: MANGROVES,
        title: 'Back to the mangroves',
        region: 'Cilacap, Central Java',
      },
      registry: 'SRN PPI',
      vintage: 2025,
      serialStart: 'SRN-2025-00001',
      serialEnd: 'SRN-2025-16000',
      amount: '1200',
      retiredAmount: '400',
    },
  ],
  retirements: { items: [ALEX_RETIREMENT], nextCursor: null, total: 1 },
};

const get = async (path: string, userId?: string) =>
  request(api.app)
    .get(`/api/v1${path}`)
    .set(userId === undefined ? {} : await api.signedIn(userId));

beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
  api = testApi(test.database, privy);
  await carbonMarket(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/carbon.md §1–§2, FR-213–FR-224.
describe('the carbon catalogue', () => {
  it('answers the §1 example: two of five batches, newest issuance first', async () => {
    const response = await get('/carbon/batches?limit=2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [BATCH_102, BATCH_101],
      nextCursor: 'eyJiIjoiNDgxMjAzIiwiaSI6IjEwMSJ9',
      total: 5,
    });
  });

  it('the rest of the catalogue shows each availability (FR-216)', async () => {
    const rest = await get('/carbon/batches?cursor=eyJiIjoiNDgxMjAzIiwiaSI6IjEwMSJ9');

    expect(
      rest.body.items.map((item: { batchId: string; availability: string }) => [
        item.batchId,
        item.availability,
      ]),
    ).toEqual([
      ['103', 'sold_out'],
      ['104', 'sales_paused'],
      ['105', 'price_not_set'],
    ]);
    expect(rest.body.nextCursor).toBeNull();
  });

  it('filters by campaign, as S27 asks', async () => {
    const response = await get(
      `/carbon/batches?campaign=${MANGROVES.toUpperCase().replace('0X', '0x')}`,
    );

    expect(response.body.items.map((item: { batchId: string }) => item.batchId)).toEqual([
      '101',
      '103',
    ]);
    expect(response.body.total).toBe(2);
  });

  it('answers the §2 example for batch 101', async () => {
    expect((await get('/carbon/batches/101')).body).toEqual(BATCH_101);
  });

  it.each([
    ['a malformed id', '/carbon/batches/0101', 400, 'invalid_path'],
    ['a batch not mirrored', '/carbon/batches/999', 404, 'not_found'],
    ['a malformed campaign filter', '/carbon/batches?campaign=0x12', 400, 'validation_error'],
    ['a cursor it did not write', '/carbon/batches?cursor=nope', 400, 'invalid_cursor'],
  ])('%s', async (_case, path, status, code) => {
    const response = await get(path);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

describe('issued_at, filled from the block on first read (data-spec §5.2.3)', () => {
  it('stays null while the RPC cannot be read, and the read still answers', async () => {
    const response = await get('/carbon/batches/104');

    expect(response.status).toBe(200);
    expect(response.body.issuedAt).toBeNull();
  });

  it('is the block time once the RPC answers, and is kept', async () => {
    const blocks: string[] = [];
    const withChain = testApi(test.database, privy, {
      blockTime: async (block) => {
        blocks.push(block);

        return new Date('2026-08-25T08:00:00Z');
      },
    });

    expect((await request(withChain.app).get('/api/v1/carbon/batches/104')).body.issuedAt).toBe(
      '2026-08-25T08:00:00.000Z',
    );
    expect(blocks).toEqual(['481000']);

    const stored = await sql<{ issued_at: Date }>`select issued_at from public.carbon_batches
      where batch_id = 104`.execute(test.database);

    expect(stored.rows[0]?.issued_at.toISOString()).toBe('2026-08-25T08:00:00.000Z');
  });
});

// docs/BE/features/carbon.md §3–§4, FR-211, FR-227–FR-231.
describe('holdings', () => {
  it("answers the §3 example for Alex's wallet", async () => {
    const response = await get('/carbon/holdings', ALEX);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ALEX_HOLDINGS);
  });

  it('§4 pages the same retirements', async () => {
    expect((await get('/carbon/holdings/retirements?limit=1', ALEX)).body).toEqual({
      items: [ALEX_RETIREMENT],
      nextCursor: null,
      total: 1,
    });
  });

  it('a planter gets empty lists and zero figures (FR-212)', async () => {
    const holdings = (await get('/carbon/holdings', SARI)).body;

    expect(holdings.summary).toEqual({
      issuedAmount: '0',
      allocatedAmount: '0',
      unfilledAmount: '0',
      retiredAmount: '0',
    });
    expect([holdings.reservations, holdings.balances, holdings.retirements.items]).toEqual([
      [],
      [],
      [],
    ]);
    expect((await get('/carbon/holdings/retirements', SARI)).body.total).toBe(0);
  });

  it.each(['/carbon/holdings', '/carbon/holdings/retirements'])(
    '%s answers 403 wallet_missing before Privy has made the wallet',
    async (path) => {
      const response = await get(path, NO_WALLET);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('wallet_missing');
    },
  );
});

// docs/BE/features/carbon.md §5, FR-234–FR-238.
describe('the certificate', () => {
  it('answers the §5 example for retirement 1', async () => {
    expect((await get('/carbon/retirements/1')).body).toEqual({
      retirementId: '1',
      label: 'issued',
      amount: '500',
      beneficiary: 'PT Hijau Lestari',
      purpose: '2026 scope 3 offset',
      retiredAt: '2026-09-20T08:00:00.000Z',
      holder: CERTIFICATE_HOLDER,
      txHash: RETIREMENT_1_TX,
      registryRetirement: { status: 'pending', reference: null },
      batch: {
        batchId: '101',
        registry: 'SRN PPI',
        vintage: 2025,
        serialStart: 'SRN-2025-00001',
        serialEnd: 'SRN-2025-16000',
        issuedAmount: '16000',
        issuedTx: { hash: BATCH_101_TX, url: null },
      },
      campaign: {
        address: MANGROVES,
        title: 'Back to the mangroves',
        region: { name: 'Cilacap, Central Java', geohash: 'qqguwvt' },
        species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
        treeTarget: 900,
      },
    });
  });

  it.each([
    ['abc', 400, 'invalid_path'],
    ['0', 400, 'invalid_path'],
    ['01', 400, 'invalid_path'],
    ['12345678901234567', 400, 'invalid_path'],
    ['77', 404, 'not_found'],
  ])('retirement %s answers %i', async (retirementId, status, code) => {
    const response = await get(`/carbon/retirements/${retirementId}`);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

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
  ALEX,
  ALEX_WALLET,
  DEMAK,
  donorHome,
  MANGROVES,
  OPEN_FLAG_3091,
  OPEN_FLAG_3092,
  PENDING_FLAG,
  ROOTS,
} from '../../../fixtures/donor-home.js';

const NEW_DONOR = 'did:privy:cm2newdonor0000000000';
const NO_WALLET = 'did:privy:cm2nowallet00000000000';
const PLANTER = 'did:privy:cm2planter000000000000';
const AUDITOR = 'did:privy:cm2auditor000000000000';
const ROOTS_TITLE = { address: ROOTS, title: 'Roots that stay' };

let test: TestDatabase;
let api: TestApi;

const get = async (path: string, userId: string) =>
  request(api.app)
    .get(`/api/v1/donor${path}`)
    .set(await api.signedIn(userId));

// donor.md §1's example for Alex.
const ALEX_DASHBOARD = {
  walletAddress: ALEX_WALLET,
  totals: {
    campaigns: 3,
    contributedAmount: '2350000000',
    payoutsReleased: '8225000000',
    treesPlanted: 1884,
    survivalRateBps: 9686,
    openFlags: 3,
  },
  carbon: {
    issued: { label: 'issued', issuedAmount: '1200', allocatedAmount: '1600' },
    unfilled: { label: 'pre-certification', unfilledAmount: '933' },
  },
  flags: {
    open: 2,
    pending: 1,
    items: [
      {
        id: PENDING_FLAG,
        treeId: '3103',
        campaign: ROOTS_TITLE,
        status: 'pending',
        reasonText: 'Reason saved; wallet transaction has not been confirmed.',
        createdAt: '2026-10-22T08:41:09.330Z',
        openedAt: null,
      },
      {
        id: OPEN_FLAG_3092,
        treeId: '3092',
        campaign: ROOTS_TITLE,
        status: 'open',
        reasonText: 'Recent evidence needs review.',
        createdAt: '2026-10-20T10:02:51.004Z',
        openedAt: '2026-10-20T10:03:39.000Z',
      },
      {
        id: OPEN_FLAG_3091,
        treeId: '3091',
        campaign: ROOTS_TITLE,
        status: 'open',
        reasonText: 'Tree condition needs an independent check.',
        createdAt: '2026-10-20T09:13:58.771Z',
        openedAt: '2026-10-20T09:14:27.000Z',
      },
    ],
    total: 3,
  },
};

const noTrees = { planted: 0, alive: 0, flagged: 0, dead: 0, removed: 0, completed: 0 };

// donor.md §2's example cards.
const ALEX_CARDS = [
  {
    campaign: {
      address: DEMAK,
      status: 'funding',
      title: 'A new tide for Demak',
      species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
      region: { name: 'Demak, Central Java' },
      treeTarget: 1000,
      fundingTarget: '10000000000',
      fundedAmount: '6840000000',
      progressBps: 6840,
    },
    contributedAmount: '250000000',
    fundingShareBps: 365,
    refundedAmount: '0',
    trees: noTrees,
    payoutsReleased: '0',
    planterBudget: '4788000000',
    releasedBps: 0,
    carbon: {
      campaignEstimate: null,
      reservation: null,
      issuedHoldings: { label: 'issued', issuedAmount: '0' },
    },
  },
  {
    campaign: {
      address: ROOTS,
      status: 'active',
      title: 'Roots that stay',
      species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
      region: { name: 'Banyumas, Central Java' },
      treeTarget: 1200,
      fundingTarget: '18000000000',
      fundedAmount: '18000000000',
      progressBps: 10000,
    },
    contributedAmount: '1200000000',
    fundingShareBps: 667,
    refundedAmount: '0',
    trees: { planted: 984, alive: 948, flagged: 2, dead: 20, removed: 14, completed: 0 },
    payoutsReleased: '2100000000',
    planterBudget: '12600000000',
    releasedBps: 1666,
    carbon: {
      campaignEstimate: { label: 'pre-certification', estimatedAmount: '8005' },
      reservation: {
        label: 'pre-certification',
        reservedAmount: '533',
        allocatedAmount: '0',
        unfilledAmount: '533',
        declined: false,
      },
      issuedHoldings: { label: 'issued', issuedAmount: '0' },
    },
  },
  {
    campaign: {
      address: MANGROVES,
      status: 'completed',
      title: 'Back to the mangroves',
      species: { code: 'RHIZOPHORA_MUCRONATA', name: 'Rhizophora mangrove' },
      region: { name: 'Cilacap, Central Java' },
      treeTarget: 900,
      fundingTarget: '9000000000',
      fundedAmount: '9000000000',
      progressBps: 10000,
    },
    contributedAmount: '900000000',
    fundingShareBps: 1000,
    refundedAmount: '25000000',
    trees: { planted: 900, alive: 0, flagged: 0, dead: 10, removed: 15, completed: 875 },
    payoutsReleased: '6125000000',
    planterBudget: '6300000000',
    releasedBps: 9722,
    carbon: {
      campaignEstimate: { label: 'pre-certification', estimatedAmount: '20000' },
      reservation: {
        label: 'pre-certification',
        reservedAmount: '2000',
        allocatedAmount: '1600',
        unfilledAmount: '400',
        declined: false,
      },
      issuedHoldings: { label: 'issued', issuedAmount: '1200' },
    },
  },
];

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await donorHome(test.database);
  await aProfile(test.database, 'donor', NEW_DONOR, `0x${'e'.repeat(40)}`);
  await aProfile(test.database, 'donor', NO_WALLET);
  await aProfile(test.database, 'planter', PLANTER, `0x${'f'.repeat(40)}`);
  await aProfile(test.database, 'auditor', AUDITOR, `0x${'9'.repeat(40)}`);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/donor.md §1, FR-070–FR-075, FR-239.
describe('GET /api/v1/donor/dashboard', () => {
  it("answers the §1 example for Alex: others' unsent drafts stay out of the rail", async () => {
    const response = await get('/dashboard', ALEX);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ALEX_DASHBOARD);
  });

  it('a wallet with no contributions gets the empty home, never an error (FR-070)', async () => {
    const { body } = await get('/dashboard', NEW_DONOR);

    expect(body.totals).toEqual({
      campaigns: 0,
      contributedAmount: '0',
      payoutsReleased: '0',
      treesPlanted: 0,
      survivalRateBps: null,
      openFlags: 0,
    });
    expect(body.flags).toEqual({ open: 0, pending: 0, items: [], total: 0 });
  });
});

// docs/BE/features/donor.md §2, FR-072, FR-073, FR-239.
describe('GET /api/v1/donor/campaigns', () => {
  it("answers the §2 example: Alex's three cards, newest first", async () => {
    const response = await get('/campaigns?limit=20', ALEX);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: ALEX_CARDS, nextCursor: null, total: 3 });
  });

  it('the Refunding tab is empty (FR-072 acceptance 1), and pages continue by cursor', async () => {
    expect((await get('/campaigns?status=refunding', ALEX)).body).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
    });

    const first = await get('/campaigns?limit=2', ALEX);
    const rest = await get(`/campaigns?limit=2&cursor=${first.body.nextCursor}`, ALEX);

    expect(
      rest.body.items.map((card: { campaign: { address: string } }) => card.campaign.address),
    ).toEqual([MANGROVES]);
  });
});

describe('the donor home refuses', () => {
  it.each([
    ['/dashboard', PLANTER, 403, 'forbidden_role'],
    ['/campaigns', PLANTER, 403, 'forbidden_role'],
    ['/dashboard', AUDITOR, 403, 'forbidden_role'],
    ['/dashboard', NO_WALLET, 403, 'wallet_missing'],
    ['/campaigns', NO_WALLET, 403, 'wallet_missing'],
    ['/dashboard?tab=all', ALEX, 400, 'validation_error'],
    ['/campaigns?status=draft', ALEX, 400, 'validation_error'],
    ['/campaigns?cursor=nope', ALEX, 400, 'invalid_cursor'],
  ])('%s for %s answers %i %s', async (path, userId, status, code) => {
    const response = await get(path, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

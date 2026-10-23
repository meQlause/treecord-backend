import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accountsRepository } from '../../../../src/features/accounts/accounts.repository.js';
import { accountsRouter, createAccountsService } from '../../../../src/features/accounts/index.js';
import { privyVerifier } from '../../../../src/shared/auth/privy.js';
import { testApp } from '../../../helpers/app.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy, TEST_APP_ID, type FakePrivy } from '../../../helpers/fake-privy.js';

const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';

// The database, Privy and its wallets for this file; set up once in beforeAll.
let test: TestDatabase;
let privy: FakePrivy;
// What Privy reports as each user's embedded wallet; a user missing here has none yet.
let wallets: Map<string, string>;

const app = () => {
  const accounts = createAccountsService({
    repository: accountsRepository(test.database),
    walletOf: async (privyUserId) => wallets.get(privyUserId) ?? null,
  });

  return testApp({
    auth: {
      verify: privyVerifier({ appId: TEST_APP_ID, resolveKey: privy.resolveKey }),
      demoWalletAuth: false,
      resolveProfile: accounts.resolveProfile,
    },
    privateRouters: [accountsRouter()],
  });
};

const getMe = async (userId = SARI) =>
  request(app())
    .get('/api/v1/me')
    .set('Authorization', `Bearer ${await privy.token({ userId })}`);

// The response, after checking its status: getMe already ran the request.
const status = async (expected: number, pending: ReturnType<typeof getMe>) => {
  const response = await pending;

  expect(response.status).toBe(expected);

  return response;
};

// docs/BE/features/accounts.md §0 (profile resolution) and §1 (GET /api/v1/me), FR-001–FR-005.
describe('GET /api/v1/me', () => {
  beforeAll(async () => {
    test = await startMigratedDatabase();
    privy = await fakePrivy();
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    wallets = new Map();
    await sql`delete from public.profiles`.execute(test.database);
  });

  it('a first sign-in creates a donor profile with the embedded wallet, lowercased, and returns it', async () => {
    wallets.set(SARI, SARI_WALLET.toUpperCase().replace('0X', '0x'));

    const response = await status(200, getMe());

    expect(response.body).toEqual({
      profile: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        walletAddress: SARI_WALLET,
        role: 'donor',
        displayName: null,
        isBuyer: false,
        carbonRightsAgreementAccepted: false,
        carbonRightsAcceptedAt: null,
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('before Privy provisions the wallet, the profile carries walletAddress null — a 200, not an error', async () => {
    expect((await status(200, getMe())).body.profile.walletAddress).toBeNull();

    wallets.set(SARI, SARI_WALLET);

    expect((await status(200, getMe())).body.profile.walletAddress).toBe(SARI_WALLET);
  });

  it('the same person signing in again gets the same profile', async () => {
    const first = (await status(200, getMe())).body.profile.id;
    const second = (await status(200, getMe())).body.profile.id;

    expect(second).toBe(first);
  });

  it('two concurrent first sign-ins create one profile', async () => {
    const responses = await Promise.all([getMe(), getMe(), getMe()]);
    const ids = new Set(responses.map((response) => response.body.profile.id));
    const { rows } = await sql<{ count: string }>`select count(*) from public.profiles`.execute(
      test.database,
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(ids.size).toBe(1);
    expect(rows[0]?.count).toBe('1');
  });

  it('a wallet that belongs to another profile answers 409 wallet_already_linked and creates nothing', async () => {
    wallets.set('did:privy:cm2alex0000000000000000', SARI_WALLET);
    await status(200, getMe('did:privy:cm2alex0000000000000000'));
    wallets.set(SARI, SARI_WALLET);

    const response = await status(409, getMe());
    const { rows } = await sql<{ count: string }>`
      select count(*) from public.profiles where privy_user_id = ${SARI}`.execute(test.database);

    expect(response.body.error.code).toBe('wallet_already_linked');
    expect(rows[0]?.count).toBe('0');
  });
});

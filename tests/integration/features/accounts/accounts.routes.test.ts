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
// The testnet faucet's amounts; null leaves it off, as every describe but the faucet's does.
let faucet: { ethWei: string; usdcUnits: string } | null = null;

const app = () => {
  const accounts = createAccountsService({
    repository: accountsRepository(test.database),
    walletOf: async (privyUserId) => wallets.get(privyUserId) ?? null,
    faucet: faucet === null ? null : { database: test.database, ...faucet },
  });

  return testApp({
    auth: {
      verify: privyVerifier({ appId: TEST_APP_ID, resolveKey: privy.resolveKey }),
      demoWalletAuth: false,
      verifyWallet: async () => {
        throw new Error('demo wallet sign-in is off');
      },
      resolveProfile: accounts.resolveProfile,
    },
    privateRouters: [accountsRouter(accounts)],
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

// One database for the whole file: both describes below use it.
beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/accounts.md §0 (profile resolution) and §1 (GET /api/v1/me), FR-001–FR-005.
describe('GET /api/v1/me', () => {
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

const postProfile = async (body: unknown, userId = SARI) =>
  request(app())
    .post('/api/v1/profile')
    .set('Authorization', `Bearer ${await privy.token({ userId })}`)
    .send(body as object);

const setRole = (role: string, userId = SARI) =>
  sql`update public.profiles set role = ${role}::public.user_role where privy_user_id = ${userId}`.execute(
    test.database,
  );

// Sari signed in once: a donor with her wallet.
const freshSari = async () => {
  wallets = new Map([[SARI, SARI_WALLET]]);
  await sql`delete from public.profiles`.execute(test.database);
  await status(200, getMe());
};

// docs/BE/features/accounts.md §2, FR-018–FR-021.
describe('POST /api/v1/profile', () => {
  beforeEach(freshSari);

  it('saves a trimmed display name and answers the profile', async () => {
    const response = await status(200, postProfile({ displayName: '  Alex Tan  ' }));

    expect(response.body.profile).toMatchObject({
      displayName: 'Alex Tan',
      role: 'donor',
      walletAddress: SARI_WALLET,
    });
  });

  it('a donor becomes a planter with the agreement (D01), and repeating it never moves the acceptance time', async () => {
    const first = await status(
      200,
      postProfile({ role: 'planter', carbonRightsAgreementAccepted: true }),
    );

    expect(first.body.profile).toMatchObject({
      role: 'planter',
      carbonRightsAgreementAccepted: true,
    });

    const again = await status(
      200,
      postProfile({ role: 'planter', carbonRightsAgreementAccepted: true }),
    );

    expect(again.body.profile.carbonRightsAcceptedAt).toBe(
      first.body.profile.carbonRightsAcceptedAt,
    );
  });

  it('a donor asking for planter without any acceptance gets 400 agreement_required, role unchanged', async () => {
    const response = await status(400, postProfile({ role: 'planter' }));

    expect(response.body.error.code).toBe('agreement_required');
    expect((await status(200, getMe())).body.profile.role).toBe('donor');
  });

  it('switches back to donor, and returns to planter later on the earlier acceptance', async () => {
    await status(200, postProfile({ role: 'planter', carbonRightsAgreementAccepted: true }));

    expect((await status(200, postProfile({ role: 'donor' }))).body.profile.role).toBe('donor');
    expect((await status(200, postProfile({ role: 'planter' }))).body.profile.role).toBe('planter');
  });

  it.each(['auditor', 'operator'])(
    'an %s sending role gets 403 role_locked, and can still save a name',
    async (role) => {
      await setRole(role);

      expect((await status(403, postProfile({ role: 'donor' }))).body.error.code).toBe(
        'role_locked',
      );
      expect((await status(200, postProfile({ displayName: 'Dewi' }))).body.profile.role).toBe(
        role,
      );
    },
  );
});

describe('POST /api/v1/profile refuses a malformed body or a taken wallet', () => {
  beforeEach(freshSari);

  it.each([
    ['an empty body', {}, ''],
    ['a server-owned field', { walletAddress: SARI_WALLET }, 'walletAddress'],
    ['an unknown field', { nickname: 'Sari' }, 'nickname'],
    ['a role other than donor or planter', { role: 'operator' }, 'role'],
    [
      'an agreement sent as false',
      { carbonRightsAgreementAccepted: false },
      'carbonRightsAgreementAccepted',
    ],
    ['a display name blank after trimming', { displayName: '   ' }, 'displayName'],
    ['a display name over 80 characters', { displayName: 'x'.repeat(81) }, 'displayName'],
  ])('%s answers 400 validation_error', async (_name, body, path) => {
    const response = await status(400, postProfile(body));

    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('a caller whose wallet belongs to another profile gets 409 wallet_already_linked here too', async () => {
    wallets.set('did:privy:cm2alex0000000000000000', SARI_WALLET);
    await sql`update public.profiles set wallet_address = null where privy_user_id = ${SARI}`.execute(
      test.database,
    );
    await status(200, getMe('did:privy:cm2alex0000000000000000'));

    expect((await status(409, postProfile({ displayName: 'Sari' }))).body.error.code).toBe(
      'wallet_already_linked',
    );
  });
});

// Testnet faucet: the first time a profile's wallet is stored, gas and test USDC are queued for it, once.
describe('GET /api/v1/me with the testnet faucet on', () => {
  const ETH_WEI = '5000000000000000';
  const USDC_UNITS = '100000000';
  const ALEX = 'did:privy:cm2alex0000000000000000';

  const faucetJobs = async () =>
    (
      await sql<{ kind: string; payload: unknown; idempotency_key: string }>`
        select kind, payload, idempotency_key from public.relayer_jobs
        where kind in ('faucet_eth', 'faucet_usdc') order by kind`.execute(test.database)
    ).rows;

  beforeEach(async () => {
    wallets = new Map();
    faucet = { ethWei: ETH_WEI, usdcUnits: USDC_UNITS };
    await sql`delete from public.relayer_jobs`.execute(test.database);
    await sql`delete from public.profiles`.execute(test.database);
  });

  afterAll(() => {
    faucet = null;
  });

  it('a first sign-in with a wallet queues one ETH and one USDC job for it, and signing in again queues no more', async () => {
    wallets.set(SARI, SARI_WALLET);

    const id = (await status(200, getMe())).body.profile.id;

    await status(200, getMe());

    expect(await faucetJobs()).toEqual([
      {
        kind: 'faucet_eth',
        payload: { to: SARI_WALLET, amount: ETH_WEI },
        idempotency_key: `faucet_eth:${id}`,
      },
      {
        kind: 'faucet_usdc',
        payload: { to: SARI_WALLET, amount: USDC_UNITS },
        idempotency_key: `faucet_usdc:${id}`,
      },
    ]);
  });

  it('a profile created before its wallet gets the jobs when the wallet is stored, not before', async () => {
    await status(200, getMe());

    expect(await faucetJobs()).toEqual([]);

    wallets.set(SARI, SARI_WALLET);
    await status(200, getMe());

    expect((await faucetJobs()).map((job) => job.kind)).toEqual(['faucet_eth', 'faucet_usdc']);
  });

  it('a wallet already linked to another profile still answers 409, and queues nothing for it', async () => {
    wallets.set(SARI, SARI_WALLET);
    await status(200, getMe());
    await sql`delete from public.relayer_jobs`.execute(test.database);
    wallets.set(ALEX, SARI_WALLET);

    expect((await status(409, getMe(ALEX))).body.error.code).toBe('wallet_already_linked');
    expect(await faucetJobs()).toEqual([]);
  });
});

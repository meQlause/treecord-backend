import { sql } from 'kysely';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletToken } from '../../../../src/generated/frozen/wallet-auth.js';
import { privyVerifier } from '../../../../src/shared/auth/privy.js';
import { testApi } from '../../../helpers/api.js';
import { testApp } from '../../../helpers/app.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy, TEST_APP_ID, type FakePrivy } from '../../../helpers/fake-privy.js';

const appWith = (resolveKey: FakePrivy['resolveKey']) =>
  testApp({
    auth: {
      verify: privyVerifier({ appId: TEST_APP_ID, resolveKey }),
      demoWalletAuth: false,
      verifyWallet: async () => {
        throw new Error('demo wallet sign-in is off');
      },
      resolveProfile: async (privyUserId) => ({ privyUserId }),
    },
  });

// docs/BE/features/accounts.md §0 steps 1–2, ADR-007.
describe('authentication on private routes', () => {
  let privy: FakePrivy;

  beforeAll(async () => {
    privy = await fakePrivy();
  });

  const getMe = (authorization?: string) => {
    const call = request(appWith(privy.resolveKey)).get('/api/v1/me');

    return authorization === undefined ? call : call.set('Authorization', authorization);
  };

  it('no bearer token answers 401 missing_token', async () => {
    const response = await getMe().expect(401);

    expect(response.body.error.code).toBe('missing_token');
  });

  it('a header that is not a bearer token answers 401 missing_token', async () => {
    expect((await getMe('Basic dHJlZWNvcmQ6c2VjcmV0').expect(401)).body.error.code).toBe(
      'missing_token',
    );
  });

  it.each([
    ['an expired token', () => privy.token({ expiresIn: Math.floor(Date.now() / 1000) - 60 })],
    ["another Privy app's token", () => privy.token({ appId: 'cm2someoneelse000000000000' })],
    ['a malformed token', async () => 'not.a.jwt'],
    ['a token signed by another key', async () => (await fakePrivy()).token()],
  ])('%s answers 401 invalid_token', async (_name, token) => {
    const response = await getMe(`Bearer ${await token()}`).expect(401);

    expect(response.body.error.code).toBe('invalid_token');
  });

  it('a demo wallet token answers 401 invalid_token while DEMO_WALLET_AUTH is off', async () => {
    const payload = Buffer.from(
      JSON.stringify({ address: `0x${'a'.repeat(40)}`, chainId: 31337, issuedAt: 1, expiresAt: 2 }),
    ).toString('base64url');
    const response = await getMe(`Bearer wallet.${payload}.0xsignature`).expect(401);

    expect(response.body.error.code).toBe('invalid_token');
  });

  it('Privy unreachable answers 503 service_unavailable, never a pass (ADR-010)', async () => {
    const outage = async () => {
      throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };

    const response = await request(appWith(outage))
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${await privy.token()}`)
      .expect(503);

    expect(response.body.error.code).toBe('service_unavailable');
  });

  it('a valid token gets past authentication', async () => {
    const response = await getMe(`Bearer ${await privy.token()}`);

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(503);
  });
});

// accounts.md §0 DEMO_WALLET_AUTH, ADR-007: the demo scripts sign in with their own wallets, through the real composition.
describe('demo wallet sign-in', () => {
  const account = privateKeyToAccount(`0x${'4'.repeat(64)}`);
  const NOW = new Date('2026-10-23T03:12:44Z');
  let test: TestDatabase;

  const token = async (change: { chainId?: number; nowSec?: number } = {}) =>
    createWalletToken({
      address: account.address,
      chainId: change.chainId ?? 31337,
      nowSec: change.nowSec ?? Math.floor(NOW.getTime() / 1000),
      signMessage: async (message) => account.signMessage({ message }),
    });

  const readMe = async (demo: 'true' | 'false', bearer: string) =>
    request(
      testApi(test.database, await fakePrivy(), {
        clock: () => NOW,
        env: { DEMO_WALLET_AUTH: demo },
      }).app,
    )
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${bearer}`);

  beforeAll(async () => {
    test = await startMigratedDatabase();
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it('with the flag on, a wallet token signs in as wallet:<address>, its wallet the signer', async () => {
    const response = await readMe('true', await token());
    const stored = await sql<{ privy_user_id: string }>`select privy_user_id from public.profiles
      where wallet_address = ${account.address.toLowerCase()}`.execute(test.database);

    expect(response.status).toBe(200);
    expect(response.body.profile.walletAddress).toBe(account.address.toLowerCase());
    expect(stored.rows[0]?.privy_user_id).toBe(`wallet:${account.address.toLowerCase()}`);
  });

  it.each([
    ['the flag off', 'false' as const, () => token()],
    ['another chain', 'true' as const, () => token({ chainId: 84532 })],
    [
      'an expired token',
      'true' as const,
      () => token({ nowSec: Math.floor(NOW.getTime() / 1000) - 7200 }),
    ],
    ['a tampered payload', 'true' as const, async () => (await token()).replace('.', '.e')],
  ])('%s answers 401 invalid_token', async (_case, demo, make) => {
    const response = await readMe(demo, await make());

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });
});

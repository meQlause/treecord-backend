import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { privyVerifier } from '../../../../src/shared/auth/privy.js';
import { testApp } from '../../../helpers/app.js';
import { fakePrivy, TEST_APP_ID, type FakePrivy } from '../../../helpers/fake-privy.js';

const appWith = (resolveKey: FakePrivy['resolveKey']) =>
  testApp({
    auth: { verify: privyVerifier({ appId: TEST_APP_ID, resolveKey }), demoWalletAuth: false },
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

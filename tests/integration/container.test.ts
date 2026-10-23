import { asValue, type AwilixContainer } from 'awilix';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createRootContainer, privateRouters, type Cradle } from '../../src/container.js';
import { privyVerifier } from '../../src/shared/auth/privy.js';
import { testApp } from '../helpers/app.js';
import {
  describeAccessMatrix,
  ROLES,
  type AccessMatrix,
  type Probe,
  type Role,
  routesOf,
} from '../helpers/access-matrix.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy, TEST_APP_ID, type FakePrivy } from '../helpers/fake-privy.js';
import { VALID_ENV } from '../fixtures/env.js';

const ME_PROBE: Probe = { method: 'get', path: '/api/v1/me' };

// Every authenticated route the composition root serves, and who may call it.
const MATRIX: AccessMatrix = {
  'GET /me': { allowed: ROLES, probe: ME_PROBE, ok: 200 },
  'POST /profile': {
    allowed: ROLES,
    probe: { method: 'post', path: '/api/v1/profile', body: { displayName: 'Sari Wulandari' } },
    ok: 200,
  },
};

const userOf = (role: Role): string => `did:privy:cm2matrix${role}000000000`;

let test: TestDatabase;
let privy: FakePrivy;
let container: AwilixContainer<Cradle>;

const app = () =>
  testApp({
    auth: {
      verify: container.cradle.verifyToken,
      demoWalletAuth: false,
      resolveProfile: container.cradle.accountsService.resolveProfile,
    },
    privateRouters: privateRouters(container.cradle),
  });

const send = async (role: Role, { method, path, body }: Probe) =>
  request(app())
    [method](path)
    .set('Authorization', `Bearer ${await privy.token({ userId: userOf(role) })}`)
    .send(body);

// The production composition, with only the outside world swapped: the test database, the fake Privy key and no
// embedded wallets. Then one signed-in profile per role; roles past donor are granted by hand, as in production.
beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
  container = createRootContainer(loadConfig(VALID_ENV)).register({
    database: asValue(test.database),
    verifyToken: asValue(privyVerifier({ appId: TEST_APP_ID, resolveKey: privy.resolveKey })),
    walletOf: asValue(async () => null),
  });

  for (const role of ROLES) {
    await send(role, ME_PROBE);
    await sql`update public.profiles
      set role = ${role}::public.user_role,
          carbon_rights_agreement_hash = ${`0x${'ab'.repeat(32)}`}
      where privy_user_id = ${userOf(role)}`.execute(test.database);
  }
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// A new route fails here until it has a row in the matrix.
it('the matrix covers every authenticated route, and nothing that is not one', () => {
  expect(Object.keys(MATRIX).sort()).toEqual(routesOf(privateRouters(container.cradle)).sort());
});

describeAccessMatrix(MATRIX, send);

import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeAccessMatrix,
  ROLES,
  routesOf,
  type AccessMatrix,
  type Probe,
  type Role,
} from '../helpers/access-matrix.js';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { aJob, aProfile } from '../fixtures/mirror.js';

const userOf = (role: Role): string => `did:privy:cm2matrix${role}000000000`;
const OTHER_USER = 'did:privy:cm2matrixother0000000000';

let test: TestDatabase;
let api: TestApi;
// Profile ids by role, and one more user who owns the foreign records.
const profileOf = new Map<Role | 'other', string>();

const jobOf = async (owner: Role | 'other'): Promise<Probe> => ({
  method: 'get',
  path: `/api/v1/jobs/${await aJob(test.database, profileOf.get(owner) ?? null)}`,
});

// Every authenticated route the composition root serves, and who may call it.
const MATRIX: AccessMatrix = {
  'GET /me': { allowed: ROLES, probe: { method: 'get', path: '/api/v1/me' }, ok: 200 },
  'POST /profile': {
    allowed: ROLES,
    probe: { method: 'post', path: '/api/v1/profile', body: { displayName: 'Sari Wulandari' } },
    ok: 200,
  },
  'GET /jobs/:id': { allowed: ROLES, probe: jobOf, ok: 200, foreign: () => jobOf('other') },
};

const send = async (role: Role, { method, path, body }: Probe) =>
  request(api.app)
    [method](path)
    .set(await api.signedIn(userOf(role)))
    .send(body);

// One profile per role; roles past donor are granted by hand, as in production.
beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());

  for (const role of ROLES) {
    profileOf.set(role, await aProfile(test.database, role, userOf(role)));
  }

  profileOf.set('other', await aProfile(test.database, 'planter', OTHER_USER));
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// A new route fails here until it has a row in the matrix.
it('the matrix covers every authenticated route, and nothing that is not one', () => {
  expect(Object.keys(MATRIX).sort()).toEqual(routesOf(api.routers).sort());
});

describeAccessMatrix(MATRIX, send);

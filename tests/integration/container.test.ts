import { sql } from 'kysely';
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
import { aCampaign, aJob, aPlantedTree, aProfile, TREE_ID } from '../fixtures/mirror.js';

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

const CAMPAIGN = '0x00000000000000000000000000000000000000c1';
const ISSUED_TX = `0x${'1'.repeat(64)}`;

// Every route the composition root serves under /api/v1, and who may call it.
const MATRIX: AccessMatrix = {
  'GET /campaigns': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/campaigns' },
    ok: 200,
  },
  'GET /campaigns/:address': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: `/api/v1/campaigns/${CAMPAIGN}` },
    ok: 200,
  },
  'GET /species': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/species' },
    ok: 200,
  },
  'GET /trees/:treeId': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: `/api/v1/trees/${TREE_ID}` },
    ok: 200,
  },
  'GET /reports/campaign/:address': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: `/api/v1/reports/campaign/${CAMPAIGN}` },
    ok: 200,
  },
  'GET /reports/campaign/:address/evidence': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: `/api/v1/reports/campaign/${CAMPAIGN}/evidence` },
    ok: 200,
  },
  'GET /carbon/batches': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/carbon/batches' },
    ok: 200,
  },
  'GET /carbon/batches/:batchId': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/carbon/batches/1' },
    ok: 200,
  },
  'GET /carbon/retirements/:retirementId': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/carbon/retirements/1' },
    ok: 200,
  },
  'GET /carbon/holdings': {
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/carbon/holdings' },
    ok: 200,
  },
  'GET /carbon/holdings/retirements': {
    allowed: ROLES,
    probe: { method: 'get', path: '/api/v1/carbon/holdings/retirements' },
    ok: 200,
  },
  'GET /me': { allowed: ROLES, probe: { method: 'get', path: '/api/v1/me' }, ok: 200 },
  'POST /profile': {
    allowed: ROLES,
    probe: { method: 'post', path: '/api/v1/profile', body: { displayName: 'Sari Wulandari' } },
    ok: 200,
  },
  'GET /jobs/:id': { allowed: ROLES, probe: jobOf, ok: 200, foreign: () => jobOf('other') },
};

const sendAnonymous = ({ method, path, body }: Probe) => request(api.app)[method](path).send(body);

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
    profileOf.set(
      role,
      await aProfile(
        test.database,
        role,
        userOf(role),
        `0x${String(ROLES.indexOf(role) + 1).repeat(40)}`,
      ),
    );
  }

  profileOf.set('other', await aProfile(test.database, 'planter', OTHER_USER));
  await aCampaign(test.database, { address: CAMPAIGN });
  await aPlantedTree(test.database);
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx, issued_at)
    values (1, ${CAMPAIGN}, 100, 'Verra', 'V-1', 'V-100', 2026, 1, ${ISSUED_TX}, now())`.execute(
    test.database,
  );
  await sql`insert into public.retirements (retirement_id, batch_id, amount, holder_address, beneficiary, purpose,
      retired_at, log_index, tx_hash)
    values (1, 1, 10, ${CAMPAIGN}, 'PT Hijau Lestari', '', now(), 0, ${ISSUED_TX})`.execute(
    test.database,
  );
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// A new route fails here until it has a row in the matrix.
it('the matrix covers every route, and nothing that is not one', () => {
  expect(Object.keys(MATRIX).sort()).toEqual(routesOf(api.routers).sort());
});

describeAccessMatrix(MATRIX, send, sendAnonymous);

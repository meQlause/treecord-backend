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
import { matrixProbes } from '../helpers/matrix-probes.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import {
  CAMPAIGN,
  matrixWorld,
  METADATA_ID,
  OPEN_FLAG_ID,
  OPS_CAMPAIGN,
  PLANTER_WALLET,
  PLANTING_CAMPAIGN,
  roleWallet,
} from '../fixtures/matrix.js';
import { aProfile, CAMPAIGN as TREE_CAMPAIGN, TREE_ID } from '../fixtures/mirror.js';

const userOf = (role: Role): string => `did:privy:cm2matrix${role}000000000`;
const OTHER_USER = 'did:privy:cm2matrixother0000000000';

let test: TestDatabase;
let api: TestApi;
// Profile ids by role, and one more user who owns the foreign records.
const profileOf = new Map<Role | 'other', string>();

const probes = matrixProbes(() => test.database, profileOf);

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
  'GET /donor/dashboard': {
    allowed: ['donor', 'operator'],
    probe: { method: 'get', path: '/api/v1/donor/dashboard' },
    ok: 200,
  },
  'GET /donor/campaigns': {
    allowed: ['donor', 'operator'],
    probe: { method: 'get', path: '/api/v1/donor/campaigns' },
    ok: 200,
  },
  'GET /devices': {
    allowed: ['planter'],
    probe: { method: 'get', path: '/api/v1/devices' },
    ok: 200,
  },
  'POST /devices': {
    allowed: ['planter'],
    probe: async () => ({
      method: 'post',
      path: '/api/v1/devices',
      body: { publicKeyJwk: probes.publicKey(), label: 'Matrix' },
    }),
    ok: 201,
  },
  'DELETE /devices/:id': {
    allowed: ['planter'],
    probe: probes.deviceOf,
    ok: 200,
    foreign: () => probes.deviceOf('other'),
  },
  'GET /planter/trees': {
    allowed: ['planter'],
    probe: { method: 'get', path: '/api/v1/planter/trees' },
    ok: 200,
  },
  'GET /planter/slots': {
    allowed: ['planter'],
    probe: { method: 'get', path: '/api/v1/planter/slots' },
    ok: 200,
  },
  'GET /planter/challenges': {
    allowed: ['planter'],
    probe: { method: 'get', path: '/api/v1/planter/challenges' },
    ok: 200,
  },
  'GET /planter/uploads': {
    allowed: ['planter'],
    probe: { method: 'get', path: '/api/v1/planter/uploads' },
    ok: 200,
  },
  'GET /evidence/capture-target': {
    allowed: ['planter'],
    probe: { method: 'get', path: `/api/v1/evidence/capture-target?kind=ALIVE&treeId=${TREE_ID}` },
    ok: 200,
  },
  'POST /evidence/upload-url': {
    allowed: ['planter'],
    probe: async () => {
      return {
        method: 'post',
        path: '/api/v1/evidence/upload-url',
        body: {
          kind: 'PLANTED',
          campaign: PLANTING_CAMPAIGN,
          slotId: '1',
          milestone: 0,
          sha256: probes.nextSha(),
          sizeBytes: 1000,
        },
      };
    },
    ok: 201,
  },
  'POST /evidence/:submissionId/submit': {
    allowed: ['planter'],
    probe: probes.submissionOf,
    ok: 503,
    foreign: () => probes.submissionOf('other'),
  },
  'GET /evidence/:submissionId': {
    allowed: ROLES,
    probe: probes.submissionReadOf,
    ok: 200,
    foreign: () => probes.submissionReadOf('other'),
  },
  'POST /campaigns/metadata': {
    allowed: ['donor', 'operator'],
    probe: {
      method: 'post',
      path: '/api/v1/campaigns/metadata',
      body: {
        title: 'Matrix campaign',
        speciesCode: 'PERSEA_AMERICANA',
        regionName: 'Matrix',
        regionCenter: { lat: 0, lon: 0 },
        regionRadiusM: 100,
      },
    },
    ok: 201,
  },
  'GET /campaigns/metadata/:id': {
    public: true,
    allowed: ROLES,
    probe: { method: 'get', path: `/api/v1/campaigns/metadata/${METADATA_ID}` },
    ok: 200,
  },
  'POST /campaigns/:address/claims': {
    allowed: ['planter'],
    probe: {
      method: 'post',
      path: `/api/v1/campaigns/${PLANTING_CAMPAIGN}/claims`,
      body: { count: 1 },
    },
    ok: 202,
  },
  'POST /flags': {
    allowed: ROLES,
    probe: {
      method: 'post',
      path: '/api/v1/flags',
      body: { treeId: String(TREE_ID), reasonText: 'Matrix flag reason' },
    },
    ok: 201,
  },
  'POST /operator/flags/:id/resolve': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: `/api/v1/operator/flags/${OPEN_FLAG_ID}/resolve`,
      body: { uphold: false, note: 'Matrix' },
    },
    ok: 202,
  },
  'POST /operator/campaigns/:address/anchor-assignments': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: `/api/v1/operator/campaigns/${OPS_CAMPAIGN}/anchor-assignments`,
      body: { planter: PLANTER_WALLET, count: 1 },
    },
    ok: 202,
  },
  'POST /operator/campaigns/:address/estimate': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: `/api/v1/operator/campaigns/${OPS_CAMPAIGN}/estimate`,
      body: {},
    },
    ok: 202,
  },
  'POST /operator/campaigns/:address/issuances': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: `/api/v1/operator/campaigns/${OPS_CAMPAIGN}/issuances`,
      body: { registry: 'SRN', vintage: 2026, serialStart: 'A', serialEnd: 'B', tonnes: '1' },
      headers: { 'Idempotency-Key': 'matrix-issue' },
    },
    ok: 202,
  },
  'POST /operator/carbon/batches/:batchId/price': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: '/api/v1/operator/carbon/batches/1/price',
      body: { usdcPerTonne: '1' },
    },
    ok: 202,
  },
  'POST /operator/carbon/retirements/:retirementId/registry-retirement': {
    allowed: ['operator'],
    probe: {
      method: 'post',
      path: '/api/v1/operator/carbon/retirements/1/registry-retirement',
      body: { reference: 'Matrix' },
    },
    ok: 200,
  },
  'POST /operator/submissions/:submissionId/review': {
    allowed: ['operator'],
    probe: async () => ({
      method: 'post',
      path: `/api/v1/operator/submissions/${await probes.plantingInReview()}/review`,
      body: { approve: false, note: 'Matrix' },
    }),
    ok: 200,
  },
  'POST /audit/sessions': {
    allowed: ['auditor'],
    probe: {
      method: 'post',
      path: '/api/v1/audit/sessions',
      body: { campaign: TREE_CAMPAIGN, sampleSize: 1 },
    },
    ok: 201,
  },
  'GET /audit/sessions/:id': {
    allowed: ['auditor'],
    probe: probes.sessionOf,
    ok: 200,
    foreign: () => probes.sessionOf('other'),
  },
  'POST /audit/sessions/:id/findings': {
    allowed: ['auditor'],
    probe: probes.auditWrite('findings', { treeId: String(TREE_ID), finding: 'ok' }),
    ok: 200,
    foreign: () =>
      probes.auditWrite('findings', { treeId: String(TREE_ID), finding: 'ok' })('other'),
  },
  'POST /audit/sessions/:id/close': {
    allowed: ['auditor'],
    probe: probes.auditWrite('close', {}),
    ok: 200,
    foreign: () => probes.auditWrite('close', {})('other'),
  },
  'GET /audit/sessions/:id/report': {
    allowed: ['auditor'],
    probe: probes.reportOf,
    ok: 200,
    foreign: () => probes.reportOf('other'),
  },
  'POST /audit/sessions/:id/challenges': {
    allowed: ['auditor'],
    probe: probes.auditWrite('challenges', { treeId: String(TREE_ID) }),
    ok: 201,
    foreign: () => probes.auditWrite('challenges', { treeId: String(TREE_ID) })('other'),
  },
  'GET /me': { allowed: ROLES, probe: { method: 'get', path: '/api/v1/me' }, ok: 200 },
  'POST /profile': {
    allowed: ROLES,
    probe: { method: 'post', path: '/api/v1/profile', body: { displayName: 'Sari Wulandari' } },
    ok: 200,
  },
  'GET /jobs/:id': {
    allowed: ROLES,
    probe: probes.jobOf,
    ok: 200,
    foreign: () => probes.jobOf('other'),
  },
};

const sendAnonymous = ({ method, path, body, headers = {} }: Probe) =>
  request(api.app)[method](path).set(headers).send(body);

const send = async (role: Role, { method, path, body, headers = {} }: Probe) =>
  request(api.app)
    [method](path)
    .set({ ...(await api.signedIn(userOf(role))), ...headers })
    .send(body);

// One profile per role; roles past donor are granted by hand, as in production.
beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());

  for (const role of ROLES) {
    profileOf.set(
      role,
      await aProfile(test.database, role, userOf(role), roleWallet(ROLES.indexOf(role))),
    );
  }

  profileOf.set('other', await aProfile(test.database, 'planter', OTHER_USER));
  await matrixWorld(test.database, profileOf.get('donor') ?? '');
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// A new route fails here until it has a row in the matrix.
it('the matrix covers every route, and nothing that is not one', () => {
  expect(Object.keys(MATRIX).sort()).toEqual(routesOf(api.routers).sort());
});

describeAccessMatrix(MATRIX, send, sendAnonymous);

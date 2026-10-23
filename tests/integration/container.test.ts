import { calculateJwkThumbprint } from 'jose';
import { sql } from 'kysely';
import { generateKeyPairSync } from 'node:crypto';
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
import {
  aCampaign,
  aJob,
  aPlantedTree,
  aProfile,
  CAMPAIGN as TREE_CAMPAIGN,
  theSpecies,
  TREE_ID,
} from '../fixtures/mirror.js';

const userOf = (role: Role): string => `did:privy:cm2matrix${role}000000000`;
const OTHER_USER = 'did:privy:cm2matrixother0000000000';

let test: TestDatabase;
let api: TestApi;
// Profile ids by role, and one more user who owns the foreign records.
const profileOf = new Map<Role | 'other', string>();

// a fresh public P-256 key, as a browser registers it
const publicKey = () => {
  const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    format: 'jwk',
  });

  return { kty, crv, x, y } as { kty: string; crv: string; x: string; y: string };
};

const deviceOf = async (owner: Role | 'other'): Promise<Probe> => {
  const key = publicKey();
  const [device] = (
    await sql<{
      id: string;
    }>`insert into public.devices (profile_id, public_key_jwk, thumbprint, label)
      values (${profileOf.get(owner)}, ${JSON.stringify(key)}::jsonb, ${await calculateJwkThumbprint(key, 'sha256')},
        'Matrix') returning id`.execute(test.database)
  ).rows;

  return { method: 'delete', path: `/api/v1/devices/${device?.id}` };
};

// a queued planting announced by `owner`, and the matching signed body; the matrix has no MinIO, so its owner gets
// past the role gate and ownership to 503 (MinIO unreachable, ADR-010)
const submissionOf = async (owner: Role | 'other'): Promise<Probe> => {
  announced += 1;

  const sha256 = String(announced).padStart(64, '0');
  const [row] = (
    await sql<{
      id: string;
    }>`insert into public.submissions (profile_id, campaign_address, kind, milestone,
        slot_id, video_sha256, video_path, status)
      values (${profileOf.get(owner)}, ${PLANTING_CAMPAIGN}, 'PLANTED', 0, 1, ${sha256}, 'matrix.mp4', 'queued')
      returning id`.execute(test.database)
  ).rows;

  return {
    method: 'post',
    path: `/api/v1/evidence/${row?.id}/submit`,
    body: {
      payload: {
        v: 1,
        kind: 'PLANTED',
        campaign: PLANTING_CAMPAIGN,
        slotId: '1',
        treeId: null,
        milestone: 0,
        videoSha256: sha256,
        lat: 0,
        lon: 0,
        acc: 5,
        capturedAt: '2026-10-23T03:00:00.000Z',
        challenge: null,
        deviceKey: 'x'.repeat(43),
      },
      canonical: '{}',
      signature: 'A'.repeat(86),
    },
  };
};

// the same queued submission, read back by its owner
const submissionReadOf = async (owner: Role | 'other'): Promise<Probe> => ({
  method: 'get',
  path: (await submissionOf(owner)).path.replace(/\/submit$/, ''),
});

const jobOf = async (owner: Role | 'other'): Promise<Probe> => ({
  method: 'get',
  path: `/api/v1/jobs/${await aJob(test.database, profileOf.get(owner) ?? null)}`,
});

const CAMPAIGN = '0x00000000000000000000000000000000000000c1';
// an Active campaign where the matrix planter (wallet 0x2222…) holds slot 1 with its tag
const PLANTING_CAMPAIGN = '0x00000000000000000000000000000000000000c2';
const PLANTER_WALLET = `0x${'2'.repeat(40)}`;
const METADATA_ID = '7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a';
// an open flag on tree 3001, which every role's wallet contributed to
const OPEN_FLAG_ID = '1f6c2a9e-4b7d-4e15-9a3c-8d2e5f0b7a61';
let announced = 0;
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
      body: { publicKeyJwk: publicKey(), label: 'Matrix' },
    }),
    ok: 201,
  },
  'DELETE /devices/:id': {
    allowed: ['planter'],
    probe: deviceOf,
    ok: 200,
    foreign: () => deviceOf('other'),
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
      announced += 1;

      return {
        method: 'post',
        path: '/api/v1/evidence/upload-url',
        body: {
          kind: 'PLANTED',
          campaign: PLANTING_CAMPAIGN,
          slotId: '1',
          milestone: 0,
          sha256: String(announced).padStart(64, '0'),
          sizeBytes: 1000,
        },
      };
    },
    ok: 201,
  },
  'POST /evidence/:submissionId/submit': {
    allowed: ['planter'],
    probe: submissionOf,
    ok: 503,
    foreign: () => submissionOf('other'),
  },
  'GET /evidence/:submissionId': {
    allowed: ROLES,
    probe: submissionReadOf,
    ok: 200,
    foreign: () => submissionReadOf('other'),
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

// The wallet of the role at this index in ROLES: 0x1111… for the donor, and so on.
const roleWallet = (index: number): string => `0x${String(index + 1).repeat(40)}`;

// Every role's wallet contributed to tree 3001's campaign, and the tree has an open flag.
const flaggableTree = async (): Promise<void> => {
  for (const [index] of ROLES.entries()) {
    await sql`insert into public.contributions (campaign_address, contributor_address, amount, total_raised_after,
        block_number, block_time, log_index, tx_hash)
      values (${TREE_CAMPAIGN}, ${roleWallet(index)}, 1, 1, 1, now(), ${index}, ${ISSUED_TX})`.execute(
      test.database,
    );
  }

  await sql`insert into public.flags (id, tree_id, campaign_address, flagger_address, reason_text, reason_hash, status)
    values (${OPEN_FLAG_ID}, ${TREE_ID}, ${TREE_CAMPAIGN}, ${PLANTER_WALLET}, 'Matrix', ${ISSUED_TX}, 'open')`.execute(
    test.database,
  );
};

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
  await aCampaign(test.database, { address: CAMPAIGN });
  await aPlantedTree(test.database);
  await aCampaign(test.database, { address: PLANTING_CAMPAIGN, status: 'active' });

  await flaggableTree();
  await theSpecies(test.database);
  await sql`insert into public.campaign_metadata (id, creator_profile_id, title, species_code, region_name,
      region_center_lat, region_center_lon, region_radius_m)
    values (${METADATA_ID}, ${profileOf.get('donor')}, 'Matrix', 'PERSEA_AMERICANA', 'Matrix', 0, 0, 100)`.execute(
    test.database,
  );
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${PLANTING_CAMPAIGN}, 1, 'open', 'claimed', ${PLANTER_WALLET})`.execute(test.database);
  await sql`insert into public.slot_tags (campaign_address, slot_id, code)
    values (${PLANTING_CAMPAIGN}, 1, 'TC-MATR-2XAA')`.execute(test.database);
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

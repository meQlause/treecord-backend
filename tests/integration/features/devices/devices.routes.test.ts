import { calculateJwkThumbprint } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { aProfile } from '../../../fixtures/mirror.js';

const SARI = 'did:privy:cm2sari0000000000000000';
const DEWI = 'did:privy:cm2dewi0000000000000000';
const ALEX = 'did:privy:cm2alex0000000000000000';

let test: TestDatabase;
let api: TestApi;

/** A fresh browser key pair's public half, as the S22 browser sends it. */
const publicKey = () => {
  const { kty, crv, x, y } = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    format: 'jwk',
  });

  return { kty, crv, x, y } as { kty: string; crv: string; x: string; y: string };
};

const register = async (body: unknown, userId = SARI) =>
  request(api.app)
    .post('/api/v1/devices')
    .set(await api.signedIn(userId))
    .send(body as object);

const revoke = async (id: string, userId = SARI) =>
  request(api.app)
    .delete(`/api/v1/devices/${id}`)
    .set(await api.signedIn(userId));

const list = async (userId = SARI) =>
  request(api.app)
    .get('/api/v1/devices')
    .set(await api.signedIn(userId));

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await aProfile(test.database, 'planter', SARI, `0x${'a'.repeat(40)}`);
  await aProfile(test.database, 'planter', DEWI, `0x${'b'.repeat(40)}`);
  await aProfile(test.database, 'donor', ALEX, `0x${'c'.repeat(40)}`);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

beforeEach(async () => {
  await sql`delete from public.devices`.execute(test.database);
});

// docs/BE/features/devices.md §2, FR-119–FR-120.
describe('POST /api/v1/devices', () => {
  it('registers a public key with the RFC 7638 thumbprint the server computes', async () => {
    const key = publicKey();
    const response = await register({ publicKeyJwk: key, label: '  Pixel 8  ' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      device: {
        id: expect.any(String),
        thumbprint: await calculateJwkThumbprint(key, 'sha256'),
        label: 'Pixel 8',
        createdAt: expect.any(String),
        revokedAt: null,
      },
    });
  });

  it('three register; the fourth answers 409 device_limit_reached with the limit', async () => {
    for (const label of ['Pixel 8', 'Laptop', 'Tablet']) {
      expect((await register({ publicKeyJwk: publicKey(), label })).status).toBe(201);
    }

    const fourth = await register({ publicKeyJwk: publicKey(), label: 'Old phone' });

    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toMatchObject({ code: 'device_limit_reached', details: { max: 3 } });
  });

  it('three registered at once by one planter still stop at three (the profile lock)', async () => {
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        register({ publicKeyJwk: publicKey(), label: `Phone ${index}` }),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 201, 409, 409]);
  });

  it('a key registered before, by anyone and even revoked, answers 409 device_already_registered', async () => {
    const key = publicKey();
    const first = await register({ publicKeyJwk: key, label: 'Pixel 8' });

    await revoke(first.body.device.id);

    const again = await register({ publicKeyJwk: key, label: 'Pixel 8' }, DEWI);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('device_already_registered');
  });

  it.each([
    ['a missing label', { label: undefined }, 'label'],
    ['a blank label', { label: '   ' }, 'label'],
    ['a label over 64 characters', { label: 'x'.repeat(65) }, 'label'],
    ['a private key member', { jwk: { d: 'private-half' } }, 'publicKeyJwk.d'],
    ['a client-sent thumbprint', { thumbprint: 'x3Jd9kQpT2aB' }, 'thumbprint'],
    ['another curve', { jwk: { crv: 'P-384' } }, 'publicKeyJwk.crv'],
    ['a point off the curve', { jwk: { y: 'A'.repeat(43) } }, 'publicKeyJwk'],
  ])('%s answers 400 validation_error', async (_case, change, path) => {
    const { jwk, ...rest } = change as { jwk?: object; label?: string };
    const response = await register({
      publicKeyJwk: { ...publicKey(), ...jwk },
      label: 'Pixel 8',
      ...rest,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });
});

// docs/BE/features/devices.md §1, §3, FR-119, FR-121.
describe('GET and DELETE /api/v1/devices', () => {
  it('lists active devices newest first; a revoked one leaves the list', async () => {
    const older = await register({ publicKeyJwk: publicKey(), label: 'Laptop' });
    const newer = await register({ publicKeyJwk: publicKey(), label: 'Pixel 8' });

    await revoke(older.body.device.id);

    expect((await list()).body).toEqual({ items: [newer.body.device], nextCursor: null, total: 1 });
  });

  it('revokes once; a repeat returns the original time with idempotent: true (FR-121)', async () => {
    const { device } = (await register({ publicKeyJwk: publicKey(), label: 'Pixel 8' })).body;
    const first = await revoke(device.id);
    const again = await revoke(device.id);

    expect(first.status).toBe(200);
    expect(first.body.device.revokedAt).toEqual(expect.any(String));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ device: first.body.device, idempotent: true });
  });

  it('a revoked device frees a place under the limit', async () => {
    const devices = [];

    for (const label of ['Pixel 8', 'Laptop', 'Tablet']) {
      devices.push((await register({ publicKeyJwk: publicKey(), label })).body.device);
    }

    await revoke(devices[0].id);

    expect((await register({ publicKeyJwk: publicKey(), label: 'New phone' })).status).toBe(201);
  });

  it.each([
    ['another planter', async (id: string) => revoke(id, DEWI), 404, 'not_found'],
    ['a malformed id', async () => revoke('c2a9f4e1'), 400, 'invalid_path'],
    ['a donor', async () => list(ALEX), 403, 'forbidden_role'],
  ])('%s gets %i %s', async (_case, call, status, code) => {
    const { device } = (await register({ publicKeyJwk: publicKey(), label: 'Pixel 8' })).body;
    const response = await call(device.id);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

import { sql } from 'kysely';
import request from 'supertest';
import { HttpRequestError } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditService } from '../../../../src/features/audit/audit.service.js';
import { DEMO_AUDIT_BLOCK, testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy, type FakePrivy } from '../../../helpers/fake-privy.js';
import { auditDemo, BARE, NADIA, OMAR, POPULATION } from '../../../fixtures/audit-demo.js';
import { RAKA, ROOTS } from '../../../fixtures/roots-that-stay.js';

const DEMO_AUDIT = 'e9219997-5281-4602-b694-f3c4b08cf7c3';
const DEMO_SEED = '0x09c2dea7c3ba4fc471025dabff6ef8967bbe0efb0c99a832da02e3e8f0d75778';
const ISSUED_AT = new Date('2026-10-21T03:30:00Z');

let test: TestDatabase;
let privy: FakePrivy;
let api: TestApi;

const open = async (body: object, userId = NADIA) =>
  request(api.app)
    .post('/api/v1/audit/sessions')
    .set(await api.signedIn(userId))
    .send(body);

const sessionCount = async (): Promise<number> =>
  (
    await sql<{ n: number }>`select count(*)::int as n from public.audit_sessions`.execute(
      test.database,
    )
  ).rows[0]?.n ?? 0;

beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
  api = testApi(test.database, privy);
  await auditDemo(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/audit.md §2, §10, FR-182–FR-184.
describe('opening a session', () => {
  it('session e9219997-… seeded by block 17000015 samples 3001, 3091, 3104 (audit.md §10)', async () => {
    const nadia = await sql<{
      id: string;
    }>`select id from public.profiles where privy_user_id = ${NADIA}`.execute(test.database);
    const audit = createAuditService({
      database: test.database,
      latestBlock: async () => DEMO_AUDIT_BLOCK,
      clock: () => ISSUED_AT,
      // FR-184: the id is lowercased before it seeds anything
      newId: () => DEMO_AUDIT.toUpperCase(),
    });
    const session = await audit.open(
      { id: nadia.rows[0]?.id ?? '' },
      { campaign: ROOTS, sampleSize: 3 },
    );

    expect(session).toMatchObject({
      id: DEMO_AUDIT,
      status: 'open',
      seed: { blockNumber: '17000015', blockHash: DEMO_AUDIT_BLOCK.hash, seed: DEMO_SEED },
      population: POPULATION,
      sampleSize: 3,
      findingsRecorded: 0,
      challengesIssued: 0,
      reportHash: null,
      closedAt: null,
    });
    expect(session.samples).toEqual([
      {
        position: 0,
        treeId: '3001',
        treeStatus: 'alive',
        finding: null,
        notes: null,
        recordedAt: null,
        challenge: null,
      },
      {
        position: 1,
        treeId: '3091',
        treeStatus: 'flagged',
        finding: null,
        notes: null,
        recordedAt: null,
        challenge: null,
      },
      {
        position: 2,
        treeId: '3104',
        treeStatus: 'alive',
        finding: null,
        notes: null,
        recordedAt: null,
        challenge: null,
      },
    ]);
  });
});

describe('opening a session through the API', () => {
  it('through the API: 201 with the session, the size capped at the population, Removed 3105 left out', async () => {
    const response = await open({
      campaign: ROOTS.toUpperCase().replace('0X', '0x'),
      sampleSize: 100,
    });
    const read = await request(api.app)
      .get(`/api/v1/audit/sessions/${response.body.id}`)
      .set(await api.signedIn(NADIA));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ population: POPULATION, sampleSize: 7 });
    expect(response.body.samples.map(({ treeId }: { treeId: string }) => treeId).sort()).toEqual(
      POPULATION,
    );
    expect(read.body).toEqual(response.body);
  });
});

describe('opening a session refuses', () => {
  it('a campaign with nothing planted: 409 no_trees, no row written', async () => {
    const before = await sessionCount();
    const response = await open({ campaign: BARE, sampleSize: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('no_trees');
    expect(await sessionCount()).toBe(before);
  });

  it('an unreadable chain: 503 service_unavailable, no row written, no retry (FR-182)', async () => {
    const down = testApi(test.database, privy, {
      latestBlock: async () => {
        throw new HttpRequestError({ url: 'http://127.0.0.1:8545' });
      },
    });
    const before = await sessionCount();
    const response = await request(down.app)
      .post('/api/v1/audit/sessions')
      .set(await down.signedIn(NADIA))
      .send({ campaign: ROOTS, sampleSize: 2 });

    expect(response.status).toBe(503);
    expect(await sessionCount()).toBe(before);
  });

  it.each([
    { name: 'a sample of 0', body: { campaign: ROOTS, sampleSize: 0 }, path: 'sampleSize' },
    { name: 'a sample of 101', body: { campaign: ROOTS, sampleSize: 101 }, path: 'sampleSize' },
    { name: 'a fractional sample', body: { campaign: ROOTS, sampleSize: 1.5 }, path: 'sampleSize' },
    { name: 'a malformed address', body: { campaign: '0x12', sampleSize: 2 }, path: 'campaign' },
    {
      name: 'an address that is no campaign',
      body: { campaign: `0x${'9'.repeat(40)}`, sampleSize: 2 },
      path: 'campaign',
    },
  ])('$name: 400 validation_error at $path', async ({ body, path }) => {
    const response = await open(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });
});

// §3 shared rules: the role gate first, then ownership (ADR-008, REG-005).
describe('reading a session', () => {
  it('another auditor gets 404, an operator 403, a malformed id 400', async () => {
    const id = (await open({ campaign: ROOTS, sampleSize: 2 })).body.id as string;
    const read = async (path: string, userId: string) =>
      request(api.app)
        .get(`/api/v1/audit/sessions/${path}`)
        .set(await api.signedIn(userId));

    expect((await read(id, OMAR)).body.error.code).toBe('not_found');
    expect((await read(id, RAKA)).body.error.code).toBe('forbidden_role');
    expect((await read('e9219997', NADIA)).body.error.code).toBe('invalid_path');
  });
});

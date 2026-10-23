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
import { reportHash } from '../../../../src/generated/frozen/audit.js';

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
      randomBytes: (count) => new Uint8Array(count),
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

// §5, §7, §8, FR-190–FR-192, DN-4: findings, the close into a hashed report with sealed notes, and the report read.
let id = '';
let sample: string[] = [];

const post = async (path: string, body: object, userId = NADIA) =>
  request(api.app)
    .post(`/api/v1/audit/sessions/${id}/${path}`)
    .set(await api.signedIn(userId))
    .send(body);

const stored = async () => {
  const [row] = (
    await sql<{
      status: string;
      closed_at: Date | null;
      report: Parameters<typeof reportHash>[0];
      report_hash: string | null;
      report_notes: Parameters<typeof reportHash>[0] & { salt: string; summary: string };
    }>`select status, closed_at, report, report_hash, report_notes from public.audit_sessions
      where id = ${id}`.execute(test.database)
  ).rows;

  if (row === undefined) {
    throw new Error(`no session ${id}`);
  }

  return row;
};

describe('recording findings', () => {
  beforeAll(async () => {
    const opened = await open({ campaign: ROOTS, sampleSize: 3 });

    id = opened.body.id as string;
    sample = opened.body.samples.map(({ treeId }: { treeId: string }) => treeId);
  });

  it('records a finding with its notes trimmed; blank notes are none; a tree outside the sample is 404', async () => {
    const first = await post('findings', {
      treeId: sample[0],
      finding: 'needs_followup',
      notes: '  Flag remains open.  ',
    });
    const second = await post('findings', { treeId: sample[1], finding: 'ok', notes: '   ' });
    const outside = POPULATION.find((treeId) => !sample.includes(treeId));

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      position: 0,
      treeId: sample[0],
      finding: 'needs_followup',
      notes: 'Flag remains open.',
      recordedAt: expect.any(String),
    });
    expect(second.body.notes).toBeNull();
    expect((await post('findings', { treeId: outside, finding: 'ok' })).body.error.code).toBe(
      'not_found',
    );
    expect(
      (
        await post('findings', {
          treeId: sample[0],
          finding: 'ok',
          recordedAt: '2026-10-21T04:00:00Z',
        })
      ).status,
    ).toBe(400);
  });
});

describe('closing a session', () => {
  it('a close with a tree still missing its finding answers 409 findings_incomplete naming it; nothing changes', async () => {
    const response = await post('close', {});

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'findings_incomplete',
      details: { missing: [sample[2]] },
    });
    expect((await stored()).status).toBe('open');
  });

  it('closes into the report whose stored hash re-hashes, with the notes sealed by a fresh 32-byte salt', async () => {
    await post('findings', { treeId: sample[2], finding: 'issue' });

    const response = await post('close', { summary: ' Sample reviewed. ' });
    const row = await stored();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sessionId: id,
      status: 'closed',
      reportHash: row.report_hash,
    });
    expect(response.body.report.totals).toEqual({ ok: 1, issue: 1, needsFollowup: 1 });
    expect(reportHash(row.report)).toBe(row.report_hash);
    expect(response.body.report.notesHash).toBe(reportHash(row.report_notes));
    expect(row.report_notes).toMatchObject({
      salt: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      summary: 'Sample reviewed.',
    });
    expect(response.body.report.closedAt).toBe(row.closed_at?.toISOString());
    expect(JSON.stringify(response.body.report)).not.toContain('Flag remains open.');
  });

  it('a repeat close answers the stored report with idempotent; its summary is ignored', async () => {
    const first = await request(api.app)
      .get(`/api/v1/audit/sessions/${id}/report`)
      .set(await api.signedIn(NADIA));
    const again = await post('close', { summary: 'Another summary' });

    expect(again.body).toEqual({ ...first.body, idempotent: true });
    expect(again.body.notes.summary).toBe('Sample reviewed.');
  });

  it("every later write answers session_closed; the report stays the owner's", async () => {
    const write = await post('findings', { treeId: sample[0], finding: 'ok' });
    const foreign = await request(api.app)
      .get(`/api/v1/audit/sessions/${id}/report`)
      .set(await api.signedIn(OMAR));

    expect(write.status).toBe(409);
    expect(write.body.error.code).toBe('session_closed');
    expect(foreign.body.error.code).toBe('not_found');
  });
});

// §6, FR-198, REG-007: the demo session samples 3001 (Alive), 3091 (Flagged) and 3104 (Alive).
describe('issuing a challenge', () => {
  const challenge = async (sessionId: string, treeId: string, userId = NADIA) =>
    request(api.app)
      .post(`/api/v1/audit/sessions/${sessionId}/challenges`)
      .set(await api.signedIn(userId))
      .send({ treeId });

  it('a sampled Alive tree gets a 4-character code open for two time units (60 days): 201', async () => {
    const response = await challenge(DEMO_AUDIT, '3001');
    const { issuedAt, expiresAt } = response.body as { issuedAt: string; expiresAt: string };

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      treeId: '3001',
      code: expect.stringMatching(/^[A-Z0-9]{4}$/),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
      fulfilledSubmissionId: null,
      status: 'open',
    });
    expect(Date.parse(expiresAt) - Date.parse(issuedAt)).toBe(2 * 2_592_000 * 1000);
  });

  it('refuses in the REG-007 order, each with its details', async () => {
    const first = await sql<{
      id: string;
      expires_at: Date;
    }>`select id, expires_at from public.challenges
      where tree_id = 3001`.execute(test.database);
    const active = await challenge(DEMO_AUDIT, '3001');

    expect(active.body.error).toMatchObject({
      code: 'challenge_active',
      details: {
        challengeId: first.rows[0]?.id,
        expiresAt: first.rows[0]?.expires_at.toISOString(),
      },
    });
    expect((await challenge(DEMO_AUDIT, '3091')).body.error).toMatchObject({
      code: 'tree_not_alive',
      details: { status: 'flagged' },
    });
    expect((await challenge(DEMO_AUDIT, '3020')).body.error.code).toBe('not_found');
    // the closed session above: a Dead, unsampled tree still answers session_closed
    expect((await challenge(id, '3103')).body.error.code).toBe('session_closed');
    expect((await challenge(DEMO_AUDIT, '3104', OMAR)).body.error.code).toBe('not_found');
  });

  it('two challenges for one tree at once end in one 201 and one challenge_active', async () => {
    const responses = await Promise.all([
      challenge(DEMO_AUDIT, '3104'),
      challenge(DEMO_AUDIT, '3104'),
    ]);
    const refused = responses.find(({ status }) => status === 409);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(refused?.body.error.code).toBe('challenge_active');
  });
});

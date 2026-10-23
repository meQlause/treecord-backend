import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import { auditDemo, NADIA, OMAR, POPULATION } from '../../../fixtures/audit-demo.js';
import { aProfile } from '../../../fixtures/mirror.js';
import { ALEX, RAKA, ROOTS } from '../../../fixtures/roots-that-stay.js';

// audit.md §1 (FR-181): Nadia's three sessions, newest first. The closed demo session is the newest, the open one
// (one finding of three, two challenges) older, and a third on a population of 30 the oldest. Omar has one of his own.
const CLOSED = '868c029f-2a97-4721-b005-f66b88e3768b';
const OPEN = 'e9219997-5281-4602-b694-f3c4b08cf7c3';
const WIDE = '5b1d2c3e-4f50-4a61-8b72-9c83d4e5f6a7';
const OMARS = '7c2e3d4f-5061-4b72-9c83-ad94e5f6a7b8';
const REPORT_HASH = '0x97eb3c933091e9f179119cb8a4396c7301c1ccc911fa4573ccce6ffd1d2c5341';
const EMPTY = 'did:privy:cm2empty000000000000000';
const BLOCK_HASH = `0x${'d'.repeat(64)}`;

let test: TestDatabase;
let api: TestApi;
let nadiaId = '';

const list = async (query = '', userId = NADIA) =>
  request(api.app)
    .get(`/api/v1/audit/sessions${query}`)
    .set(await api.signedIn(userId));

type NewSession = {
  id: string;
  auditor: string;
  population: string[];
  block: number;
  createdAt: string;
  samples: string[];
};

const open = async ({ id, auditor, population, block, createdAt, samples }: NewSession) => {
  await sql`insert into public.audit_sessions (id, auditor_profile_id, campaign_address, seed_block_number,
      seed_block_hash, seed, population_tree_ids, sample_size, created_at)
    values (${id}, ${auditor}, ${ROOTS}, ${block}, ${BLOCK_HASH}, ${BLOCK_HASH},
      array[${sql.join(population)}]::bigint[], ${samples.length}, ${createdAt})`.execute(
    test.database,
  );

  for (const [position, treeId] of samples.entries()) {
    await sql`insert into public.audit_samples (session_id, position, tree_id) values (${id}, ${position}, ${treeId})`.execute(
      test.database,
    );
  }
};

const finding = async (id: string, treeId: string) => {
  await sql`update public.audit_samples set finding = 'ok', recorded_at = now()
    where session_id = ${id} and tree_id = ${treeId}`.execute(test.database);
};

const challenge = async (id: string, treeId: string, code: string) => {
  await sql`insert into public.challenges (tree_id, code, issued_by_profile_id, audit_session_id, expires_at)
    values (${treeId}, ${code}, ${nadiaId}, ${id}, '2026-12-20T04:00:00Z')`.execute(test.database);
};

const close = async (id: string) => {
  await sql`update public.audit_sessions set status = 'closed', closed_at = '2026-10-21T06:00:00Z',
      report = '{"notesHash": "0x1"}'::jsonb, report_hash = ${REPORT_HASH}, report_notes = '{}'::jsonb
    where id = ${id}`.execute(test.database);
};

/** Nadia's three sessions and Omar's one, with the findings and challenges the cards count. */
const sessions = async (nadia: string, omar: string) => {
  await open({
    id: WIDE,
    auditor: nadia,
    population: Array.from({ length: 30 }, (_unused, index) => String(3001 + index)),
    block: 100,
    createdAt: '2026-10-20T09:00:00Z',
    samples: ['3020'],
  });
  await open({
    id: OPEN,
    auditor: nadia,
    population: POPULATION,
    block: 17000015,
    createdAt: '2026-10-21T03:30:00Z',
    samples: ['3001', '3091', '3104'],
  });
  await finding(OPEN, '3091');
  await challenge(OPEN, '3001', 'R4M9');
  await challenge(OPEN, '3104', 'T2X8');
  await open({
    id: CLOSED,
    auditor: nadia,
    population: POPULATION,
    block: 17000001,
    createdAt: '2026-10-21T05:00:00Z',
    samples: ['3091', '3001'],
  });
  await finding(CLOSED, '3091');
  await finding(CLOSED, '3001');
  await close(CLOSED);
  await open({
    id: OMARS,
    auditor: omar,
    population: POPULATION,
    block: 5,
    createdAt: '2026-10-22T00:00:00Z',
    samples: ['3001'],
  });
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await auditDemo(test.database);
  await aProfile(test.database, 'auditor', EMPTY);

  const profiles = await sql<{
    id: string;
    privy_user_id: string;
  }>`select id, privy_user_id from public.profiles
    where privy_user_id in (${NADIA}, ${OMAR})`.execute(test.database);
  const idOf = (privy: string) =>
    profiles.rows.find((row) => row.privy_user_id === privy)?.id ?? '';

  nadiaId = idOf(NADIA);
  await sessions(nadiaId, idOf(OMAR));
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

const campaign = { address: ROOTS, title: 'Roots that stay' };

// docs/BE/features/audit.md §1, FR-181.
describe('GET /api/v1/audit/sessions', () => {
  it("lists the auditor's own sessions newest first, each as the §1 card", async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(3);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items.map(({ id }: { id: string }) => id)).toEqual([CLOSED, OPEN, WIDE]);
    expect(response.body.items[0]).toEqual({
      id: CLOSED,
      status: 'closed',
      campaign,
      seedBlockNumber: '17000001',
      populationSize: 7,
      sampleSize: 2,
      populationPreview: POPULATION,
      sample: ['3091', '3001'],
      findingsRecorded: 2,
      challengesIssued: 0,
      reportHash: REPORT_HASH,
      createdAt: '2026-10-21T05:00:00.000Z',
      closedAt: '2026-10-21T06:00:00.000Z',
    });
    expect(response.body.items[1]).toEqual({
      id: OPEN,
      status: 'open',
      campaign,
      seedBlockNumber: '17000015',
      populationSize: 7,
      sampleSize: 3,
      populationPreview: POPULATION,
      sample: ['3001', '3091', '3104'],
      findingsRecorded: 1,
      challengesIssued: 2,
      reportHash: null,
      createdAt: '2026-10-21T03:30:00.000Z',
      closedAt: null,
    });
  });

  it('previews the first 21 ids of a larger population, in order, and still counts all 30', async () => {
    const wide = (await list()).body.items[2];

    expect(wide.populationSize).toBe(30);
    expect(wide.populationPreview).toEqual(
      Array.from({ length: 21 }, (_unused, index) => String(3001 + index)),
    );
  });

  it('filters by status; the total follows the filter', async () => {
    const closed = await list('?status=closed');
    const opened = await list('?status=open');

    expect(closed.body.items.map(({ id }: { id: string }) => id)).toEqual([CLOSED]);
    expect(closed.body.total).toBe(1);
    expect(opened.body.items.map(({ id }: { id: string }) => id)).toEqual([OPEN, WIDE]);
    expect(opened.body.total).toBe(2);
  });

  it('pages by cursor without repeating or skipping a session', async () => {
    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${first.body.nextCursor}`);

    expect(first.body.items.map(({ id }: { id: string }) => id)).toEqual([CLOSED, OPEN]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.total).toBe(3);
    expect(second.body.items.map(({ id }: { id: string }) => id)).toEqual([WIDE]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("never shows another auditor's sessions; an auditor with none gets an empty list", async () => {
    const omar = await list('', OMAR);
    const empty = await list('', EMPTY);

    expect(omar.body.items.map(({ id }: { id: string }) => id)).toEqual([OMARS]);
    expect(empty.body).toEqual({ items: [], nextCursor: null, total: 0 });
  });
});

describe('GET /api/v1/audit/sessions refuses', () => {
  it.each([
    {
      name: 'a status that is neither open nor closed',
      query: '?status=archived',
      status: 400,
      code: 'validation_error',
    },
    { name: 'a limit of 0', query: '?limit=0', status: 400, code: 'validation_error' },
    { name: 'a limit of 101', query: '?limit=101', status: 400, code: 'validation_error' },
    { name: 'an unknown query field', query: '?campaign=x', status: 400, code: 'validation_error' },
    {
      name: 'a cursor this list never wrote',
      query: '?cursor=bm90IGEgY3Vyc29y',
      status: 400,
      code: 'invalid_cursor',
    },
    { name: 'an operator', query: '', userId: RAKA, status: 403, code: 'forbidden_role' },
    { name: 'a donor', query: '', userId: ALEX, status: 403, code: 'forbidden_role' },
  ])('$name answers $status $code', async ({ query, userId = NADIA, status, code }) => {
    const response = await list(query, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

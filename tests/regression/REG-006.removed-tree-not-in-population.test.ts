import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { auditDemo, NADIA } from '../fixtures/audit-demo.js';
import { ROOTS } from '../fixtures/roots-that-stay.js';

// REG-006 (docs/BE/testing.md §4): Removed trees entered the audit population. Roots that stay has Removed tree 3105;
// a session opened on it freezes a population without that id, in the response and in the stored row.

let test: TestDatabase;
let api: TestApi;

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await auditDemo(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

it('a session on a campaign with Removed tree 3105 freezes a population without it', async () => {
  const response = await request(api.app)
    .post('/api/v1/audit/sessions')
    .set(await api.signedIn(NADIA))
    .send({ campaign: ROOTS, sampleSize: 100 });
  const stored = await sql<{
    population: string[];
  }>`select population_tree_ids::text[] as population from public.audit_sessions
    where id = ${response.body.id}`.execute(test.database);

  expect(response.status).toBe(201);
  expect(response.body.population).not.toContain('3105');
  expect(stored.rows[0]?.population).not.toContain('3105');
  expect(response.body.samples.map(({ treeId }: { treeId: string }) => treeId)).not.toContain(
    '3105',
  );
});

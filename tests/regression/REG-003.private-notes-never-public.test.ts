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

// REG-003 (docs/BE/testing.md §4, FR-191, FR-203): private audit notes leaked into a public response. After a session
// closes with the note "Flag remains open." and a summary, no public body carries either text, and the reproduction
// has no `summary` key.
const NOTE = 'Flag remains open.';
const SUMMARY = 'Private summary, sealed only.';

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

it('a closed session with private notes: the reproduction and the sampled tree pages never show them', async () => {
  const auth = await api.signedIn(NADIA);
  const opened = await request(api.app)
    .post('/api/v1/audit/sessions')
    .set(auth)
    .send({ campaign: ROOTS, sampleSize: 2 });
  const id = opened.body.id as string;
  const sample = opened.body.samples.map(({ treeId }: { treeId: string }) => treeId) as string[];

  for (const treeId of sample) {
    await request(api.app)
      .post(`/api/v1/audit/sessions/${id}/findings`)
      .set(auth)
      .send({ treeId, finding: 'needs_followup', notes: NOTE });
  }

  const closed = await request(api.app)
    .post(`/api/v1/audit/sessions/${id}/close`)
    .set(auth)
    .send({ summary: SUMMARY });
  const publicBodies = await Promise.all([
    request(api.app).get(`/api/v1/audit/sessions/${id}/reproduce`),
    ...sample.map((treeId) => request(api.app).get(`/api/v1/trees/${treeId}`)),
  ]);

  expect(closed.status).toBe(200);
  expect(publicBodies[0]?.body.check.reportMatches).toBe(true);

  // the tree page has a milestone `summary` of its own; the audit summary key must not reach the reproduction
  expect(publicBodies[0]?.text).not.toContain('"summary"');

  for (const { text } of publicBodies) {
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain(SUMMARY);
  }
});

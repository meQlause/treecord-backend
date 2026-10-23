import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditService } from '../../src/features/audit/audit.service.js';
import { canonicalJson, reportHash } from '../../src/generated/frozen/audit.js';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { auditDemo } from '../fixtures/audit-demo.js';
import { ROOTS } from '../fixtures/roots-that-stay.js';

// REG-002 (docs/BE/testing.md §4, NFR-070): the same audit report hashed differently in the server and the browser.
// The server hashes with src/generated/frozen/audit.ts, the copy of packages/shared the browser bundle copies too; these
// are the shared vectors (audit.md §10): FR-192's canonical-JSON object, and the closed demo session `868c029f-…` built
// end to end through the service from the mockup's inputs, which must land on the published 0x97eb…5341.
const DEMO_CLOSED = '868c029f-2a97-4721-b005-f66b88e3768b';
const DEMO_AUDITOR = '5f0c2a9e-8d41-4b7a-9c3e-1a6d2f8b4e70';
const DEMO_BLOCK = {
  number: '17000001',
  hash: '0xd0e38899a3d5c3657e22f95fdada4f0da6aa36ea51545d334455da8663d50701',
} as const;
const SUMMARY =
  'Sample reviewed; one tree needs follow-up while its flag is resolved. No registry certification is implied.';

let test: TestDatabase;
let api: TestApi;

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await auditDemo(test.database);
  await sql`insert into public.profiles (id, privy_user_id, wallet_address, role)
    values (${DEMO_AUDITOR}, 'did:privy:cm2demoauditor00000000', '0x2a7f3c9e1b5d8f0a4c6e2b9d7f1a3c5e8b0d2f4a',
      'auditor')`.execute(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

describe('REG-002: one report hash for server and browser', () => {
  it('the FR-192 vector: canonical form and hash', () => {
    const value = { b: 1, a: [2, { d: null, c: 'x' }] };

    expect(canonicalJson(value)).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(reportHash(value)).toBe(
      '0x2ab4646d9bddae1eccca6d103cffefb892e463a60753a7dc105f52fa1288dae0',
    );
  });

  it('the closed demo session, opened, reviewed and closed through the service, hashes to 0x97eb…5341', async () => {
    let now = new Date('2026-10-21T05:00:00.000Z');
    const audit = createAuditService({
      database: test.database,
      // no evidence is read here
      storage: {
        presignGet: async () => {
          throw new Error('no storage in this test');
        },
        sha256Of: async () => null,
      },
      latestBlock: async () => DEMO_BLOCK,
      clock: () => now,
      newId: () => DEMO_CLOSED,
      // the mockup's fixed demo salt, 0x5a…5a
      randomBytes: (count) => new Uint8Array(count).fill(0x5a),
    });
    const auditor = { id: DEMO_AUDITOR };
    const opened = await audit.open(auditor, { campaign: ROOTS, sampleSize: 2 });

    // the mockup's findings, each at its own recorded time
    for (const [recordedAt, finding] of [
      [
        '2026-10-21T05:20:00.000Z',
        { treeId: '3001', finding: 'ok', notes: 'Planting and month-3 evidence consistent.' },
      ],
      [
        '2026-10-21T05:40:00.000Z',
        { treeId: '3091', finding: 'needs_followup', notes: 'Flag remains open.' },
      ],
    ] as const) {
      now = new Date(recordedAt);
      await audit.record(auditor, DEMO_CLOSED, finding);
    }

    now = new Date('2026-10-21T06:00:00.000Z');

    const closed = await audit.close(auditor, DEMO_CLOSED, SUMMARY);
    const reproduced = await request(api.app).get(
      `/api/v1/audit/sessions/${DEMO_CLOSED}/reproduce`,
    );

    expect(opened.samples.map(({ treeId }) => treeId)).toEqual(['3091', '3001']);
    expect(closed.reportHash).toBe(
      '0x97eb3c933091e9f179119cb8a4396c7301c1ccc911fa4573ccce6ffd1d2c5341',
    );
    expect(reproduced.body.check).toEqual({
      seedMatches: true,
      recomputedSample: ['3091', '3001'],
      sampleMatches: true,
      reportMatches: true,
    });
    expect(reportHash(reproduced.body.report)).toBe(closed.reportHash);
    expect(reproduced.body.report.notesHash).toBe(
      '0x60b1ce72a79120a3d943e93d68c5cfbaa7e5b98b99114469896c74f4da14d545',
    );
  });
});

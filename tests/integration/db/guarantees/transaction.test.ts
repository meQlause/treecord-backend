import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aPlantedTree, CAMPAIGN, PLANTER_ID, TREE_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const SUBMISSION = '2b9e6f1c-4d3a-4c1e-9f7a-1a2b3c4d5e6f';
const SCORE_KEY = `score:${SUBMISSION}`; // the server-reserved key of the score job (jobs.md)

describe('ADR-004 a status change and its job are written together or not at all', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
    await sql`
      insert into public.submissions (id, profile_id, campaign_address, tree_id, kind, milestone, video_sha256, status)
      values (${SUBMISSION}, ${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 1, ${randomBytes(32).toString('hex')},
        'uploaded')`.execute(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it('a transaction killed between the status update and the job insert leaves neither', async () => {
    const outcome = test.database
      .transaction()
      .execute(async (trx) => {
        await sql`update public.submissions set status = 'checking' where id = ${SUBMISSION}`.execute(
          trx,
        );

        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);

        // The kill, from another connection: the server ends this transaction's backend mid-way.
        await sql`select pg_terminate_backend(${rows[0]?.pid})`.execute(test.database);
        await sql`insert into public.relayer_jobs (kind, payload, idempotency_key)
                  values ('score', ${JSON.stringify({ submissionId: SUBMISSION })}::jsonb, ${SCORE_KEY})`.execute(
          trx,
        );
      })
      .then(
        () => 'committed',
        () => 'failed',
      );

    expect(await outcome).toBe('failed');

    const { rows } = await sql<{ status: string; jobs: string }>`
      select s.status, (select count(*) from public.relayer_jobs) as jobs
      from public.submissions s where s.id = ${SUBMISSION}`.execute(test.database);

    expect(rows).toEqual([{ status: 'uploaded', jobs: '0' }]);
  });
});

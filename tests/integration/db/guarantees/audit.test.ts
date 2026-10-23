import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDomainError } from '../../../../src/shared/db/constraints.js';
import { DomainError } from '../../../../src/shared/errors.js';
import { aPlantedTree, AUDITOR_ID, CAMPAIGN, TREE_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

// The demo session of features/audit.md §3 (block 17000015).
const SESSION = 'e9219997-5281-4602-b694-f3c4b08cf7c3';
const BLOCK_HASH = '0x39e41cfd9e316d39bb6ad8058c9cfbbb2d19fa7938c68e1e32009e56e735a4cd';
const HASH = `0x${'5'.repeat(64)}`;
const NOTES_HASH = `0x${'6'.repeat(64)}`;

const refusal = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('FR-192, FR-200 a closed audit session never changes — data-spec §6.2', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
    await sql`
      insert into public.audit_sessions (id, auditor_profile_id, campaign_address, seed, seed_block_number,
        seed_block_hash, sample_size)
      values (${SESSION}, ${AUDITOR_ID}, ${CAMPAIGN}, ${HASH}, 17000015, ${BLOCK_HASH}, 1)`.execute(
      test.database,
    );
    await sql`
      insert into public.audit_samples (session_id, tree_id, position, finding, notes, recorded_at)
      values (${SESSION}, ${TREE_ID}, 0, 'ok', 'Planting and month-3 evidence consistent.', now())`.execute(
      test.database,
    );
    await sql`
      update public.audit_sessions
      set status = 'closed', closed_at = now(), report = ${JSON.stringify({ notesHash: NOTES_HASH })}::jsonb,
          report_hash = ${HASH}, report_notes = ${JSON.stringify({ salt: '0x01', findings: [], summary: '' })}::jsonb
      where id = ${SESSION}`.execute(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it('updating the closed session raises session_closed (23514), mapped to 409 session_closed', async () => {
    const error = await refusal(
      sql`update public.audit_sessions set sample_size = 2 where id = ${SESSION}`.execute(
        test.database,
      ),
    );

    expect(error).toMatchObject({ code: '23514', message: 'session_closed' });
    expect(toDomainError(error)).toEqual(new DomainError('session_closed'));
  });

  it('changing a finding of the closed session raises session_closed', async () => {
    const error = await refusal(
      sql`update public.audit_samples set finding = 'needs_followup' where session_id = ${SESSION}`.execute(
        test.database,
      ),
    );

    expect(error).toMatchObject({ code: '23514', message: 'session_closed' });
    expect(toDomainError(error)).toEqual(new DomainError('session_closed'));
  });

  it('adding a sample to the closed session raises session_closed', async () => {
    const error = await refusal(
      sql`insert into public.audit_samples (session_id, tree_id, position) values (${SESSION}, ${TREE_ID}, 1)`.execute(
        test.database,
      ),
    );

    expect(error).toMatchObject({ code: '23514', message: 'session_closed' });
    expect(toDomainError(error)).toEqual(new DomainError('session_closed'));
  });

  it('reset_demo_data still deletes a closed demo session', async () => {
    await sql`update public.campaigns set is_demo = true where address = ${CAMPAIGN}`.execute(
      test.database,
    );
    await sql`select public.reset_demo_data(array[${CAMPAIGN}]::text[], array[]::uuid[])`.execute(
      test.database,
    );

    const { rows } = await sql<{ count: string }>`
      select count(*) from public.audit_sessions where id = ${SESSION}`.execute(test.database);

    expect(rows[0]?.count).toBe('0');
  });
});

import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../../../src/generated/db.js';
import { toDomainError } from '../../../../src/shared/db/constraints.js';
import { DomainError } from '../../../../src/shared/errors.js';
import { AUDITOR_ID, aPlantedTree, TREE_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const HOLD_SECONDS = 0.3;

const issue = (
  executor: TestDatabase['database'] | Transaction<DB>,
  createdAt: string,
  expiresAt: string,
) =>
  sql`insert into public.challenges (tree_id, code, issued_by_profile_id, created_at, expires_at)
      values (${TREE_ID}, 'R4M9', ${AUDITOR_ID}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz)`.execute(
    executor,
  );

describe('FR-198 one open challenge per tree — data-spec §6.2, the hardest guarantee', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await sql`delete from public.challenges`.execute(test.database);
  });

  it('two concurrent transactions issuing a challenge for one tree end with exactly one row; the other fails with 23P01', async () => {
    // Each transaction inserts, then holds itself open, so the two really overlap.
    const attempt = () =>
      test.database.transaction().execute(async (trx) => {
        await issue(trx, '2026-10-23T09:00:00Z', '2026-10-30T09:00:00Z');
        await sql`select pg_sleep(${HOLD_SECONDS})`.execute(trx);
      });
    const outcomes = await Promise.allSettled([attempt(), attempt()]);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: '23P01',
      constraint: 'challenges_one_open_per_tree',
    });

    const { rows } = await sql<{ count: string }>`select count(*) from public.challenges`.execute(
      test.database,
    );

    expect(rows[0]?.count).toBe('1');
  });

  it('the violation maps to 409 challenge_active', async () => {
    await issue(test.database, '2026-10-23T09:00:00Z', '2026-10-30T09:00:00Z');

    const error = await issue(test.database, '2026-10-24T09:00:00Z', '2026-10-31T09:00:00Z').catch(
      (caught: unknown) => caught,
    );

    expect(toDomainError(error)).toEqual(new DomainError('challenge_active'));
  });

  it("a challenge whose window ended exactly at the new one's start allows it ('[)')", async () => {
    await issue(test.database, '2026-10-16T10:00:00Z', '2026-10-23T10:00:00Z');

    await expect(
      issue(test.database, '2026-10-23T10:00:00Z', '2026-10-30T10:00:00Z'),
    ).resolves.toBeDefined();
  });

  it('one millisecond earlier still overlaps and is refused', async () => {
    await issue(test.database, '2026-10-16T10:00:00Z', '2026-10-23T10:00:00Z');

    await expect(
      issue(test.database, '2026-10-23T09:59:59.999Z', '2026-10-30T10:00:00Z'),
    ).rejects.toMatchObject({
      code: '23P01',
    });
  });
});

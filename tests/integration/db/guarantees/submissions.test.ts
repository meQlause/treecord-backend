import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../../../src/generated/db.js';
import { toDomainError } from '../../../../src/shared/db/constraints.js';
import { DomainError } from '../../../../src/shared/errors.js';
import { aPlantedTree, CAMPAIGN, PLANTER_ID, TREE_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const HOLD_SECONDS = 0.3;

type Target = { kind: 'ALIVE' | 'DEAD' | 'REPLANTED'; milestone: number } | { kind: 'PLANTED' };

// One submission row; every row gets its own video hash so only the FR-138 indexes can collide.
const submit = (
  executor: TestDatabase['database'] | Transaction<DB>,
  target: Target,
  status: string,
) => {
  const video = randomBytes(32).toString('hex');

  return target.kind === 'PLANTED'
    ? sql`insert into public.submissions (profile_id, campaign_address, slot_id, kind, milestone, video_sha256, status)
          values (${PLANTER_ID}, ${CAMPAIGN}, 1, 'PLANTED', 0, ${video}, ${status}::public.submission_status)`.execute(
        executor,
      )
    : sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256, status)
          values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, ${target.kind}::public.evidence_kind, ${target.milestone},
            ${video}, ${status}::public.submission_status)`.execute(executor);
};

// A 23505 on the named FR-138 index, mapped to precheck_failed with its reason (error-handling §2.1).
const expectRefused = (error: unknown, constraint: string, reason: string): void => {
  expect(error).toMatchObject({ code: '23505', constraint });
  expect(toDomainError(error)).toEqual(new DomainError('precheck_failed', { reasons: [reason] }));
};

const refusal = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('FR-138 one live submission per target — data-spec §6.2', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  beforeEach(async () => {
    await sql`delete from public.submissions`.execute(test.database);
  });

  it('two concurrent live check-ins for one tree and milestone leave one row', async () => {
    const attempt = () =>
      test.database.transaction().execute(async (trx) => {
        await submit(trx, { kind: 'ALIVE', milestone: 1 }, 'uploaded');
        await sql`select pg_sleep(${HOLD_SECONDS})`.execute(trx);
      });
    const outcomes = await Promise.allSettled([attempt(), attempt()]);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expectRefused(rejected?.reason, 'submissions_one_live_check_in_idx', 'milestone_already_done');

    const { rows } = await sql<{ count: string }>`select count(*) from public.submissions`.execute(
      test.database,
    );

    expect(rows[0]?.count).toBe('1');
  });

  it.each(['DEAD', 'REPLANTED'] as const)(
    'a second in-flight %s for one tree is refused as already_reported',
    async (kind) => {
      expect.assertions(2);
      await submit(test.database, { kind, milestone: 2 }, 'checking');

      const error = await refusal(submit(test.database, { kind, milestone: 2 }, 'uploaded'));

      expectRefused(error, 'submissions_one_inflight_event_idx', 'already_reported');
    },
  );

  it.each(['DEAD', 'REPLANTED'] as const)(
    'once a %s is on-chain, the tree can report it again later',
    async (kind) => {
      await submit(test.database, { kind, milestone: 2 }, 'onchain');

      await expect(
        submit(test.database, { kind, milestone: 3 }, 'uploaded'),
      ).resolves.toBeDefined();
    },
  );

  it('one live PLANTED per slot', async () => {
    await submit(test.database, { kind: 'PLANTED' }, 'needs_review');

    const error = await refusal(submit(test.database, { kind: 'PLANTED' }, 'uploaded'));

    expect(error).toMatchObject({ constraint: 'submissions_one_live_planting_idx' });
    expectRefused(error, 'submissions_one_live_planting_idx', 'slot_already_planted');
  });

  it.each(['rejected', 'failed', 'queued'])(
    'a %s planting frees the slot for a new one',
    async (status) => {
      await submit(test.database, { kind: 'PLANTED' }, status);

      await expect(submit(test.database, { kind: 'PLANTED' }, 'uploaded')).resolves.toBeDefined();
    },
  );
});

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aPlantedTree, CAMPAIGN, TREE_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const TX_HASH = `0x${'7'.repeat(64)}`;

const refusal = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('FR-243 chainlink_enforcements mirrors each Enforced log once — data-spec §5.2.6', () => {
  let test: TestDatabase;

  const insert = (kind: string, milestone: number | null, logIndex: number) =>
    sql`
      insert into public.chainlink_enforcements (kind, campaign_address, tree_id, milestone, block_number,
        block_time, tx_hash, log_index)
      values (${kind}, ${CAMPAIGN}, ${TREE_ID}, ${milestone}, 24118500, now(), ${TX_HASH}, ${logIndex})`.execute(
      test.database,
    );

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it('stores a forfeit with its milestone and an expire without one', async () => {
    await insert('forfeit', 2, 1);
    await insert('expire', null, 3);

    const rows = await sql<{ kind: string; milestone: number | null }>`
      select kind, milestone from public.chainlink_enforcements order by log_index`.execute(
      test.database,
    );

    expect(rows.rows).toEqual([
      { kind: 'forfeit', milestone: 2 },
      { kind: 'expire', milestone: null },
    ]);
  });

  it('refuses a forfeit without a milestone and an expire with one (23514)', async () => {
    expect(await refusal(insert('forfeit', null, 10))).toMatchObject({ code: '23514' });
    expect(await refusal(insert('expire', 0, 11))).toMatchObject({ code: '23514' });
    expect(await refusal(insert('forfeit', 6, 12))).toMatchObject({ code: '23514' });
  });

  it('refuses a second row for the same log (23505)', async () => {
    expect(await refusal(insert('forfeit', 2, 1))).toMatchObject({ code: '23505' });
  });
});

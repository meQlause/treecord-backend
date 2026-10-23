import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';

export const operationsRepository = (database: Kysely<DB>) => ({
  /** §2–§4: the campaign, locked so two operators acting on it at once queue behind each other (§2 concurrency). */
  lockCampaign: (address: string) =>
    database
      .selectFrom('campaigns')
      .select([
        'address',
        'status',
        'claim_deadline',
        'species_code',
        'tree_target',
        'commitment_units',
      ])
      .where('address', '=', address)
      .forUpdate()
      .executeTakeFirst(),

  /** §1 anchor: anchor slots not yet assigned, and open slots nobody claimed. */
  slotCounts: (address: string) =>
    database
      .selectFrom('slots')
      .select([
        sql<number>`(count(*) filter (where kind = 'anchor' and status = 'anchor'))::int`.as(
          'unassigned_anchors',
        ),
        sql<number>`(count(*) filter (where kind = 'open' and status = 'open'))::int`.as(
          'open_unclaimed',
        ),
      ])
      .where('campaign_address', '=', address)
      .executeTakeFirstOrThrow(),

  removedTrees: async (address: string): Promise<number> =>
    (
      await database
        .selectFrom('trees')
        .select(sql<number>`count(*)::int`.as('removed'))
        .where('campaign_address', '=', address)
        .where('status', '=', 'removed')
        .executeTakeFirstOrThrow()
    ).removed,

  species: (code: string) =>
    database
      .selectFrom('species')
      .select(['code', 'english_name', 'est_kg_co2_per_year_mature', 'years_to_maturity'])
      .where('code', '=', code)
      .executeTakeFirst(),

  /** §3 estimate_locked: a batch of the campaign is mirrored. */
  hasBatch: async (address: string): Promise<boolean> =>
    (await database
      .selectFrom('carbon_batches')
      .select('batch_id')
      .where('campaign_address', '=', address)
      .limit(1)
      .executeTakeFirst()) !== undefined,

  batchExists: async (batchId: string): Promise<boolean> =>
    (await database
      .selectFrom('carbon_batches')
      .select('batch_id')
      .where('batch_id', '=', batchId)
      .executeTakeFirst()) !== undefined,

  /** §3 side effect: the method of the run just queued. `estimated_amount` stays the indexer's (ADR-015). */
  writeEstimateMethod: async (address: string, method: Record<string, unknown>): Promise<void> => {
    await database
      .updateTable('campaigns')
      .set({ estimate_method: JSON.stringify(method) })
      .where('address', '=', address)
      .execute();
  },
});

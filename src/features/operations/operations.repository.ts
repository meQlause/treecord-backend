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

  /** §1 anchor: anchor slots not yet assigned, and open slots nobody claimed. The indexer writes a slot row only once
   *  it is claimed or assigned (a rolled-over open slot keeps kind open), so both are the campaign's totals less the
   *  rows of that kind. */
  slotCounts: (address: string) =>
    database
      .selectFrom('campaigns as c')
      .leftJoin('slots as s', 's.campaign_address', 'c.address')
      .select([
        sql<number>`c.anchor_slots - (count(s.slot_id) filter (where s.kind = 'anchor'))::int`.as(
          'unassigned_anchors',
        ),
        sql<number>`c.open_slots - (count(s.slot_id) filter (where s.kind = 'open'))::int`.as(
          'open_unclaimed',
        ),
      ])
      .where('c.address', '=', address)
      .groupBy(['c.anchor_slots', 'c.open_slots'])
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

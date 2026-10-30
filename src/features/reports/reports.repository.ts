import { sql, type Kysely } from 'kysely';
import type { DB } from '../../generated/db.js';
import type { EvidencePosition } from './reports.rules.js';

// reports.md §1–§2: campaign-wide aggregates. Every sum is numeric read as text and every id a string (REG-001). The
// service runs these on one read-only repeatable-read transaction, so they describe the same instant.

const EVENT_EVIDENCE = 'e.evidence_hash';
const EVENT_LOG_INDEX = 'e.log_index';

const SUM_AMOUNT = sql<string>`coalesce(sum(amount), 0)::text`;

const headerReads = (database: Kysely<DB>) => ({
  campaign: (address: string) =>
    database
      .selectFrom('campaigns as c')
      .leftJoin('species as s', 's.code', 'c.species_code')
      .select([
        'c.address',
        'c.status',
        'c.title',
        'c.species_code',
        's.english_name as species_name',
        'c.region_name',
        'c.region_radius_m',
        'c.tree_target',
        'c.commitment_units',
        'c.funding_target',
        'c.funded_amount',
        'c.incentive_pool',
        'c.estimated_amount',
        'c.estimate_method',
      ])
      .where('c.address', '=', address)
      .executeTakeFirst(),

  /** FR-065: trees by status, and their average age at `asOf` in whole days. */
  trees: (address: string, asOf: Date) =>
    database
      .selectFrom('trees')
      .select([
        sql<number>`count(*)::int`.as('planted'),
        sql<number>`(count(*) filter (where status = 'alive'))::int`.as('alive'),
        sql<number>`(count(*) filter (where status = 'flagged'))::int`.as('flagged'),
        sql<number>`(count(*) filter (where status = 'dead'))::int`.as('dead'),
        sql<number>`(count(*) filter (where status = 'removed'))::int`.as('removed'),
        sql<number>`(count(*) filter (where status = 'completed'))::int`.as('completed'),
        sql<
          number | null
        >`floor(extract(epoch from avg(${asOf}::timestamptz - planted_at)) / 86400)::int`.as(
          'average_age_days',
        ),
      ])
      .where('campaign_address', '=', address)
      .executeTakeFirstOrThrow(),

  /** FR-066: distinct contributors and money refunded. */
  funding: (address: string) =>
    database
      .selectNoFrom((builder) => [
        builder
          .selectFrom('contributions')
          .select(sql<number>`count(distinct contributor_address)::int`.as('n'))
          .where('campaign_address', '=', address)
          .as('contributors'),
        builder
          .selectFrom('refunds')
          .select(SUM_AMOUNT.as('n'))
          .where('campaign_address', '=', address)
          .as('refunded'),
      ])
      .executeTakeFirstOrThrow(),
});

const moneyReads = (database: Kysely<DB>) => ({
  /** FR-067: payouts per milestone, and the forfeited total. */
  payoutsByMilestone: (address: string) =>
    database
      .selectFrom('milestone_payouts')
      .select(['milestone', sql<number>`count(*)::int`.as('payouts'), SUM_AMOUNT.as('amount')])
      .where('campaign_address', '=', address)
      .groupBy('milestone')
      .execute(),

  /** `enforced`: how many the Chainlink keeper sent (FR-244), matched on (tree_id, tx_hash). */
  forfeited: (address: string): Promise<{ total: string; enforced: number }> =>
    database
      .selectFrom('milestone_forfeits as f')
      .select([
        sql<string>`coalesce(sum(f.amount), 0)::text`.as('total'),
        sql<number>`count(*) filter (where exists (select 1 from public.chainlink_enforcements ce
          where ce.tree_id = f.tree_id and ce.tx_hash = f.tx_hash))::int`.as('enforced'),
      ])
      .where('f.campaign_address', '=', address)
      .executeTakeFirstOrThrow(),

  /** FR-068: registry issuances, newest first, and the units retired from them. */
  batches: (address: string) =>
    database
      .selectFrom('carbon_batches')
      .select([
        sql<string>`batch_id::text`.as('batch_id'),
        'registry',
        'vintage',
        'serial_start',
        'serial_end',
        'amount',
        'issued_tx',
      ])
      .where('campaign_address', '=', address)
      .orderBy('issued_block', 'desc')
      .execute(),

  retired: async (address: string): Promise<string> =>
    (
      await database
        .selectFrom('retirements as r')
        .innerJoin('carbon_batches as b', 'b.batch_id', 'r.batch_id')
        .select(sql<string>`coalesce(sum(r.amount), 0)::text`.as('total'))
        .where('b.campaign_address', '=', address)
        .executeTakeFirstOrThrow()
    ).total,
});

const evidenceReads = (database: Kysely<DB>) => {
  const events = (address: string) =>
    database
      .selectFrom('tree_events as e')
      .innerJoin('trees as t', 't.tree_id', 'e.tree_id')
      .where('t.campaign_address', '=', address)
      .where(EVENT_EVIDENCE, 'is not', null);

  return {
    /** FR-069: public columns only, oldest first; one row past the page tells whether another follows. */
    evidencePage: (address: string, after: EvidencePosition | null, take: number) => {
      const query = events(address)
        .leftJoin('submissions as s', 's.evidence_hash', EVENT_EVIDENCE)
        .select([
          sql<string>`e.tree_id::text`.as('tree_id'),
          'e.kind',
          's.milestone',
          'e.block_time',
          EVENT_EVIDENCE,
          sql<string>`e.block_number::text`.as('block_number'),
          EVENT_LOG_INDEX,
          'e.tx_hash',
        ]);

      return (
        after === null
          ? query
          : query.where((builder) =>
              builder(
                builder.refTuple('e.block_number', EVENT_LOG_INDEX),
                '>',
                builder.tuple(after.block, after.logIndex),
              ),
            )
      )
        .orderBy('e.block_number')
        .orderBy(EVENT_LOG_INDEX)
        .limit(take)
        .execute();
    },

    evidenceTotal: async (address: string): Promise<number> =>
      (
        await events(address)
          .select(sql<number>`count(*)::int`.as('total'))
          .executeTakeFirstOrThrow()
      ).total,
  };
};

export const reportsRepository = (database: Kysely<DB>) => ({
  ...headerReads(database),
  ...moneyReads(database),
  ...evidenceReads(database),
});

export type ReportsRepository = ReturnType<typeof reportsRepository>;

type Rows<Read extends keyof ReportsRepository> = Awaited<ReturnType<ReportsRepository[Read]>>;

export type CampaignHeaderRow = NonNullable<Rows<'campaign'>>;

export type ReportRecords = {
  trees: Rows<'trees'>;
  funding: Rows<'funding'>;
  payoutsByMilestone: Rows<'payoutsByMilestone'>;
  forfeited: { total: string; enforced: number };
  batches: Rows<'batches'>;
  retired: string;
};

export type EvidenceRow = Rows<'evidencePage'>[number];
